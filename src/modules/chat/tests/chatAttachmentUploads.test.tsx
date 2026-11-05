import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { useChatAttachmentUploads } from '@/modules/chat/hooks/useChatAttachmentUploads';
import { api } from '@/shared/api';

afterEach(() => vi.restoreAllMocks());
const response = (name: string) => new Response(JSON.stringify({ attachments: [{ name, path: `/files/${name}`, mimeType: 'text/plain', size: 3 }] }));

test('selection starts two background uploads and sending reuses the same completed descriptors', async () => {
  const pending: Array<() => void> = [];
  const upload = vi.spyOn(api.assets, 'uploadFiles').mockImplementation((form, options) => {
    options?.onProgress(50);const file = form.get('files') as File;
    return new Promise(resolve => { pending.push(() => resolve(response(file.name))); });
  });
  const files = ['a', 'b', 'c'].map(name => new File(['abc'], name + '.txt', { type: 'text/plain' }));
  const view = renderHook(() => useChatAttachmentUploads(files));
  await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));expect(view.result.current.progress.get(files[0])?.percent).toBe(50);
  await act(async () => pending.shift()!());await waitFor(() => expect(upload).toHaveBeenCalledTimes(3));
  await act(async () => { for (const resolve of pending.splice(0)) resolve(); });
  await waitFor(() => expect(view.result.current.progress.get(files[2])?.phase).toBe('ready'));
  expect((await view.result.current.upload(files)).map(item => item.name)).toEqual(['a.txt', 'b.txt', 'c.txt']);expect(upload).toHaveBeenCalledTimes(3);
  view.unmount();
});

test('retry retains the upload ID and completed files are never resent after an interrupted message send', async () => {
  const upload = vi.spyOn(api.assets, 'uploadFiles').mockRejectedValueOnce(new Error('offline')).mockResolvedValue(response('a.txt'));
  const file = new File(['abc'], 'a.txt', { type: 'text/plain' });const files = [file];
  const view = renderHook(() => useChatAttachmentUploads(files));await waitFor(() => expect(view.result.current.progress.get(file)?.phase).toBe('error'));
  act(() => view.result.current.retry(file));await waitFor(() => expect(view.result.current.progress.get(file)?.phase).toBe('ready'));
  expect(upload.mock.calls[0][1]?.requestId).toBe(upload.mock.calls[1][1]?.requestId);
  await view.result.current.upload(files);expect(upload).toHaveBeenCalledTimes(2);view.unmount();
});
