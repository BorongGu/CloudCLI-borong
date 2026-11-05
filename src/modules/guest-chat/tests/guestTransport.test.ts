import { afterEach, expect, test, vi } from 'vitest';

import { guestChatApi } from '@/shared/api';
import type { GuestChatSnapshot } from '@/shared/types';

afterEach(() => { vi.unstubAllGlobals();vi.useRealTimers(); });

test('stream patches append only once and a revision gap reconnects for a fresh snapshot', () => {
  const sockets: Array<{ onmessage: (event: { data: string }) => void; close: ReturnType<typeof vi.fn> }> = [];
  vi.stubGlobal('WebSocket', class {
    close = vi.fn();onmessage = () => {};constructor() { sockets.push(this); }
  });
  const initial: GuestChatSnapshot = { id: 'one', title: 'one', model: 'gpt-6-astra', effort: 'high', busy: true, status: '', error: null, revision: 5, updatedAt: 1,
    messages: [{ id: 'answer', role: 'assistant', text: 'Hello', images: [], createdAt: 1 }] };
  const receive = vi.fn();const close = guestChatApi.subscribe('one', receive, vi.fn(), initial);
  const socket = sockets[0];
  socket.onmessage({ data: JSON.stringify({ ...initial, type: 'patch', partial: true, baseRevision: 5, revision: 6, messages: [{ id: 'answer', textAppend: ' world' }] }) });
  expect(receive.mock.calls[0][0].messages[0].text).toBe('Hello world');
  socket.onmessage({ data: JSON.stringify({ type: 'heartbeat' }) });expect(receive).toHaveBeenCalledTimes(1);
  socket.onmessage({ data: JSON.stringify({ id: 'one', type: 'patch', baseRevision: 5, revision: 7, messages: [] }) });
  expect(socket.close).toHaveBeenCalled();expect(receive).toHaveBeenCalledTimes(1);close();
});

test('a stalled request times out with actionable feedback', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))));
  const pending = guestChatApi.read('one');const check = expect(pending).rejects.toThrow('连接等待较久');
  await vi.advanceTimersByTimeAsync(20001);await check;
});

test('preupload uses binary content with a stable ID and reports server acknowledgement separately', async () => {
  const requests: Array<{ status: number; responseText: string; upload: { onprogress: (event: unknown) => void }; onload: () => void; send: ReturnType<typeof vi.fn>; open: ReturnType<typeof vi.fn>; abort: ReturnType<typeof vi.fn> }> = [];
  vi.stubGlobal('XMLHttpRequest', class {
    status = 201;responseText = '{"id":"image.webp"}';upload = { onprogress: () => {} };onload = () => {};setRequestHeader = vi.fn();send = vi.fn();open = vi.fn();abort = vi.fn();constructor() { requests.push(this); }
  });
  const blob = new Blob(['binary'], { type: 'image/webp' });const progress = vi.fn();
  const result = guestChatApi.upload('stable-id', blob, progress, new AbortController().signal);
  const xhr = requests[0];
  expect(xhr.send).toHaveBeenCalledWith(blob);expect(xhr.open).toHaveBeenCalledWith('POST', '/api/uploads/stable-id');
  xhr.upload.onprogress({ lengthComputable: true, loaded: 6, total: 6 });expect(progress).toHaveBeenLastCalledWith(99);
  xhr.onload();expect(await result).toEqual({ id: 'image.webp' });expect(progress).toHaveBeenLastCalledWith(100);
});
