import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { GuestChat } from '@/modules/guest-chat';
import { guestChatApi } from '@/shared/api';

vi.mock('@/shared/api', () => ({ guestChatApi: { upload: vi.fn(), subscribe: vi.fn(() => () => {}), auth: vi.fn(), login: vi.fn(), logout: vi.fn(), list: vi.fn(), create: vi.fn(), read: vi.fn(), send: vi.fn(), stop: vi.fn(), image: (id: string) => '/api/images/' + id } }));
vi.mock('@/modules/guest-chat/utils/prepareGuestImage', () => ({ prepareGuestImage: async (file: File) => file }));
vi.mock('@/modules/guest-chat/GuestAnswer', () => ({ default: ({ message }: { message: { text: string } }) => <div>{message.text}</div> }));

const chat = { id: 'guest-only', title: '我的题目', busy: false, status: '', error: null, messages: [], revision: 1, updatedAt: 1, model: 'gpt-6-astra', effort: 'high' };
beforeEach(() => {
  localStorage.clear();vi.clearAllMocks();
  vi.mocked(guestChatApi.subscribe).mockImplementation(() => () => {});
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.mocked(guestChatApi.list).mockResolvedValue({ chats: [chat] });
  vi.mocked(guestChatApi.read).mockResolvedValue(chat);vi.mocked(guestChatApi.create).mockResolvedValue(chat);
  vi.mocked(guestChatApi.login).mockResolvedValue({ authenticated: true, chats: [chat], chat });
  vi.mocked(guestChatApi.auth).mockResolvedValue({ authenticated: true, chats: [chat], chat });
  URL.createObjectURL = vi.fn(() => 'blob:test-image');URL.revokeObjectURL = vi.fn();
});

test('a healthy live connection replaces repeated full-history polling', async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(guestChatApi.auth).mockResolvedValue({ authenticated: true });
    vi.mocked(guestChatApi.subscribe).mockImplementation((_id, _receive, connection) => { connection(true);return () => {}; });
    await act(async () => { render(<GuestChat />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    const reads = vi.mocked(guestChatApi.read).mock.calls.length;
    expect(reads).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(guestChatApi.read).toHaveBeenCalledTimes(reads);
  } finally { cleanup();vi.useRealTimers(); }
});

test('bootstrap restores the selected conversation in one request', async () => {
  render(<GuestChat />);await screen.findByLabelText('输入问题');
  expect(guestChatApi.list).not.toHaveBeenCalled();expect(guestChatApi.read).not.toHaveBeenCalled();expect(guestChatApi.create).not.toHaveBeenCalled();
});

test('cached switching is immediate and preserves each draft while refreshing', async () => {
  const second = { ...chat, id: 'second', title: '第二个对话' };
  vi.mocked(guestChatApi.auth).mockResolvedValue({ authenticated: true, chats: [chat, second], chat });
  vi.mocked(guestChatApi.read).mockResolvedValueOnce(second).mockImplementation(() => new Promise(() => {}));
  render(<GuestChat />);const input = await screen.findByLabelText('输入问题');
  fireEvent.change(input, { target: { value: '第一个草稿' } });
  fireEvent.change(screen.getByLabelText('我的对话'), { target: { value: 'second' } });
  await waitFor(() => expect(screen.queryByText('正在打开对话…')).toBeNull());
  fireEvent.change(input, { target: { value: '第二个草稿' } });
  fireEvent.change(screen.getByLabelText('我的对话'), { target: { value: chat.id } });
  expect((screen.getByLabelText('输入问题') as HTMLTextAreaElement).value).toBe('第一个草稿');
  expect(screen.getByText('正在同步最新消息…')).toBeTruthy();
});

test('failed sends retain the optimistic question and retry with the same idempotency key', async () => {
  vi.mocked(guestChatApi.send).mockRejectedValueOnce(new Error('连接中断')).mockResolvedValueOnce({ ...chat, revision: 2, busy: true });
  render(<GuestChat />);const input = await screen.findByLabelText('输入问题');
  fireEvent.change(input, { target: { value: '保留问题' } });fireEvent.click(screen.getByRole('button', { name: '发送问题' }));
  const retry = await screen.findByRole('button', { name: '重试发送' });
  expect((input as HTMLTextAreaElement).value).toBe('保留问题');
  fireEvent.click(retry);await waitFor(() => expect(guestChatApi.send).toHaveBeenCalledTimes(2));
  expect(vi.mocked(guestChatApi.send).mock.calls[1]).toEqual(vi.mocked(guestChatApi.send).mock.calls[0]);
});

test('image preparation uploads before send and sends only the returned image reference', async () => {
  let finish!: (value: { id: string }) => void;
  vi.mocked(guestChatApi.upload).mockImplementation((_id, _blob, progress) => { progress(45);return new Promise(resolve => { finish = resolve; }); });
  vi.mocked(guestChatApi.send).mockImplementation(async (_id, text, _images, requestId, imageIds) => ({ ...chat, revision: 2, busy: true, messages: [{ id: requestId, role: 'user', text, images: imageIds || [], createdAt: 1 }] }));
  render(<GuestChat />);await screen.findByLabelText('输入问题');
  fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File(['png'], '题目.png', { type: 'image/png' })] } });
  await screen.findByText('45%');expect((screen.getByRole('button', { name: '发送问题' }) as HTMLButtonElement).disabled).toBe(true);
  expect(guestChatApi.send).not.toHaveBeenCalled();
  await act(async () => finish({ id: 'uploaded.png' }));await screen.findByText('已就绪');
  fireEvent.click(screen.getByRole('button', { name: '发送问题' }));
  await waitFor(() => expect(guestChatApi.send).toHaveBeenCalled());
  expect(vi.mocked(guestChatApi.send).mock.calls[0][2]).toEqual([]);expect(vi.mocked(guestChatApi.send).mock.calls[0][4]).toEqual(['uploaded.png']);
  const sentImage = await screen.findByAltText('题目截图');expect(sentImage.getAttribute('src')).toBe('blob:test-image');
});

test('a delayed send response updates its own session while another conversation stays selected', async () => {
  const second = { ...chat, id: 'second', title: '第二个对话' };
  vi.mocked(guestChatApi.auth).mockResolvedValue({ authenticated: true, chats: [chat, second], chat });
  vi.mocked(guestChatApi.read).mockResolvedValue(second);
  let acknowledge!: (snapshot: typeof chat) => void;
  vi.mocked(guestChatApi.send).mockReturnValue(new Promise(resolve => { acknowledge = resolve; }));
  render(<GuestChat />);const input = await screen.findByLabelText('输入问题');
  fireEvent.change(input, { target: { value: '第一条问题' } });fireEvent.click(screen.getByRole('button', { name: '发送问题' }));
  fireEvent.change(screen.getByLabelText('我的对话'), { target: { value: second.id } });
  await waitFor(() => expect(screen.queryByText('正在打开对话…')).toBeNull());
  fireEvent.change(input, { target: { value: '第二个草稿' } });
  await act(async () => acknowledge({ ...chat, revision: 2, busy: true }));
  expect((screen.getByLabelText('我的对话') as HTMLSelectElement).value).toBe(second.id);
  expect((screen.getByLabelText('输入问题') as HTMLTextAreaElement).value).toBe('第二个草稿');
});

test('a failed image upload can be retried without preparing or selecting the file again', async () => {
  vi.mocked(guestChatApi.upload).mockRejectedValueOnce(new Error('网络中断')).mockResolvedValueOnce({ id: 'retry.png' });
  render(<GuestChat />);await screen.findByLabelText('输入问题');
  fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File(['png'], '题目.png', { type: 'image/png' })] } });
  fireEvent.click(await screen.findByLabelText('重试图片 1'));await screen.findByText('已就绪');
  const calls = vi.mocked(guestChatApi.upload).mock.calls;expect(calls[0][0]).toBe(calls[1][0]);expect(calls[0][1]).toBe(calls[1][1]);
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

test('compression shows its context and a new-conversation action while the original turn keeps running', async () => {
  const compressing = { ...chat, busy: true, context: { used: 420000, limit: 475000 }, compaction: { phase: 'running' as const, startedAt: Date.now() } };
  vi.mocked(guestChatApi.auth).mockResolvedValue({ authenticated: true, chats: [compressing], chat: compressing });
  vi.mocked(guestChatApi.create).mockResolvedValue({ ...chat, id: 'fresh', title: '新对话' });
  render(<GuestChat />);await screen.findByText('420K / 475K');
  expect(screen.getByText('可以新开一个对话来避免等待。')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '新开对话' }));
  await waitFor(() => expect((screen.getByLabelText('我的对话') as HTMLSelectElement).value).toBe('fresh'));
  expect(guestChatApi.stop).not.toHaveBeenCalled();expect(screen.queryByText('可以新开一个对话来避免等待。')).toBeNull();
});
