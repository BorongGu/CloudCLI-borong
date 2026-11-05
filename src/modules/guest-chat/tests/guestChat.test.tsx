import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { GuestChat } from '@/modules/guest-chat';
import { guestChatApi } from '@/shared/api';

vi.mock('@/shared/api', () => ({ guestChatApi: { subscribe: vi.fn(() => () => {}), auth: vi.fn(), login: vi.fn(), logout: vi.fn(), list: vi.fn(), create: vi.fn(), read: vi.fn(), send: vi.fn(), stop: vi.fn(), image: (id: string) => '/api/images/' + id } }));
vi.mock('@/modules/guest-chat/GuestAnswer', () => ({ default: ({ message }: { message: { text: string } }) => <div>{message.text}</div> }));

const chat = { id: 'guest-only', title: '我的题目', busy: false, status: '', error: null, messages: [], revision: 1, updatedAt: 1, model: 'gpt-6-astra', effort: 'high' };
beforeEach(() => {
  localStorage.clear();vi.clearAllMocks();
  vi.mocked(guestChatApi.subscribe).mockImplementation(() => () => {});
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.mocked(guestChatApi.list).mockResolvedValue({ chats: [chat] });
  vi.mocked(guestChatApi.read).mockResolvedValue(chat);vi.mocked(guestChatApi.create).mockResolvedValue(chat);
  vi.mocked(guestChatApi.login).mockResolvedValue({ ok: true });
});

test('a healthy live connection replaces repeated full-history polling', async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(guestChatApi.auth).mockResolvedValue({ authenticated: true });
    vi.mocked(guestChatApi.subscribe).mockImplementation((_id, _receive, connection) => { connection(true);return () => {}; });
    await act(async () => { render(<GuestChat />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    const reads = vi.mocked(guestChatApi.read).mock.calls.length;
    expect(reads).toBeGreaterThan(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(guestChatApi.read).toHaveBeenCalledTimes(reads);
  } finally { cleanup();vi.useRealTimers(); }
});
afterEach(() => { cleanup();vi.unstubAllGlobals(); });

test('guest login defaults to its own account and displays the fixed model', async () => {
  vi.mocked(guestChatApi.auth).mockResolvedValue({ authenticated: false, username: 'family' });render(<GuestChat />);
  const password = await screen.findByLabelText('密码');
  expect((screen.getByLabelText('账号') as HTMLInputElement).value).toBe('family');
  fireEvent.change(password, { target: { value: 'guest-password' } });
  await waitFor(() => expect((screen.getByRole('button', { name: '进入对话' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '进入对话' }));
  await screen.findByLabelText('输入问题');
  expect(guestChatApi.login).toHaveBeenCalledWith('family', 'guest-password');
  expect(screen.getByRole('heading', { name: 'GPT-6 Astra' })).toBeTruthy();
  expect(screen.queryByText('终端')).toBeNull();expect(screen.queryByText('文件')).toBeNull();
});

test('guest sends only text, images and an idempotency key to its own conversation', async () => {
  vi.mocked(guestChatApi.auth).mockResolvedValue({ authenticated: true });
  vi.mocked(guestChatApi.send).mockResolvedValue({ ...chat, busy: true, status: '思考中', revision: 2 });render(<GuestChat />);
  const input = await screen.findByLabelText('输入问题');
  fireEvent.change(input, { target: { value: '求解这道题' } });fireEvent.click(screen.getByRole('button', { name: '发送问题' }));
  await waitFor(() => expect(guestChatApi.send).toHaveBeenCalledTimes(1));
  const args = vi.mocked(guestChatApi.send).mock.calls[0];
  expect(args.slice(0, 3)).toEqual(['guest-only', '求解这道题', []]);expect(args[3]).toMatch(/^[a-f0-9-]{36}$/);
  await screen.findByRole('button', { name: '停止' });
  expect((screen.getByLabelText('我的对话') as HTMLSelectElement).options.length).toBe(1);
});

test('a late send acknowledgement preserves the newer streamed answer and completed status', async () => {
  vi.mocked(guestChatApi.auth).mockResolvedValue({ authenticated: true });
  let receive: Parameters<typeof guestChatApi.subscribe>[1] = () => {};
  vi.mocked(guestChatApi.subscribe).mockImplementation((_id, callback, connected) => { receive = callback;connected(true);return () => {}; });
  let acknowledge!: (value: typeof chat) => void;
  vi.mocked(guestChatApi.send).mockReturnValue(new Promise(resolve => { acknowledge = resolve; }));
  render(<GuestChat />);const input = await screen.findByLabelText('输入问题');
  await waitFor(() => expect(guestChatApi.subscribe).toHaveBeenCalled());
  fireEvent.change(input, { target: { value: 'hello' } });fireEvent.click(screen.getByRole('button', { name: '发送问题' }));
  await act(async () => receive({ ...chat, revision: 3, messages: [{ id: 'answer', role: 'assistant', text: '完整回答', images: [], createdAt: 1 }] }));
  await screen.findByText('完整回答');
  await act(async () => acknowledge({ ...chat, revision: 2, busy: true }));
  expect(screen.getByText('完整回答')).toBeTruthy();expect(screen.queryByRole('button', { name: '停止' })).toBeNull();
});
