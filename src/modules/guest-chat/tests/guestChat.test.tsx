import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { GuestChat } from '@/modules/guest-chat';
import { guestChatApi } from '@/shared/api';

vi.mock('@/shared/api', () => ({ guestChatApi: { subscribe: vi.fn(() => () => {}), auth: vi.fn(), login: vi.fn(), logout: vi.fn(), list: vi.fn(), create: vi.fn(), read: vi.fn(), send: vi.fn(), stop: vi.fn(), image: (id: string) => '/api/images/' + id } }));
vi.mock('@/modules/guest-chat/GuestAnswer', () => ({ default: ({ message }: { message: { text: string } }) => <div>{message.text}</div> }));

const chat = { id: 'guest-only', title: '我的题目', busy: false, status: '', error: null, messages: [], revision: 1, updatedAt: 1, model: 'gpt-6-astra', effort: 'high' };
beforeEach(() => {
  localStorage.clear();vi.clearAllMocks();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.mocked(guestChatApi.list).mockResolvedValue({ chats: [chat] });
  vi.mocked(guestChatApi.read).mockResolvedValue(chat);vi.mocked(guestChatApi.create).mockResolvedValue(chat);
  vi.mocked(guestChatApi.login).mockResolvedValue({ ok: true });
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
  expect(screen.getByText('GPT-6 Astra · High')).toBeTruthy();
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
