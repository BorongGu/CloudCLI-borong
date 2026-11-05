import { useEffect, useRef, useState } from 'react';

import { prepareGuestImage } from '@/modules/guest-chat/utils/prepareGuestImage';
import { guestChatApi } from '@/shared/api';
import type { GuestChatAttachment } from '@/shared/types';

/** GuestChat keeps image preparation and uploads associated with their original conversation drafts. */
export function useGuestAttachments(report: (error: unknown) => void) {
  // Each conversation retains its selected images and live progress when the user switches away.
  const [byChat, setByChat] = useState<Record<string, GuestChatAttachment[]>>({});
  // Recently sent images reuse their local preview instead of downloading the same bytes through the tunnel.
  const [sentPreviews, setSentPreviews] = useState<Record<string, string>>({});
  const retained = useRef(new Map<string, string>());
  const current = useRef(byChat);
  const jobs = useRef(new Map<string, AbortController>());
  const waiting = useRef<Array<() => void>>([]);
  const running = useRef(0);
  const mounted = useRef(true);
  function update(id: string, change: (images: GuestChatAttachment[]) => GuestChatAttachment[]) {
    if (!mounted.current) return;
    current.current = { ...current.current, [id]: change(current.current[id] || []) };setByChat(current.current);
  }
  function patch(id: string, image: string, value: Partial<GuestChatAttachment>) {
    update(id, images => images.map(item => item.id === image ? { ...item, ...value } : item));
  }
  function pump() {
    while (running.current < 2 && waiting.current.length) waiting.current.shift()?.();
  }
  function start(chatId: string, attachment: GuestChatAttachment) {
    if (jobs.current.has(attachment.id)) return;
    const controller = new AbortController();jobs.current.set(attachment.id, controller);
    patch(chatId, attachment.id, { status: attachment.blob ? 'queued' : 'preparing', error: undefined, progress: 0 });
    waiting.current.push(() => {
      if (controller.signal.aborted) { jobs.current.delete(attachment.id);return; }
      running.current++;
      void (async () => {
        const blob = attachment.blob || await prepareGuestImage(attachment.source);
        if (controller.signal.aborted) return;
        let preview = attachment.preview;
        if (!attachment.blob && blob !== attachment.source) { preview = URL.createObjectURL(blob);URL.revokeObjectURL(attachment.preview); }
        patch(chatId, attachment.id, { blob, preview, status: 'uploading' });
        const result = await guestChatApi.upload(attachment.id, blob, progress => patch(chatId, attachment.id, { progress }), controller.signal);
        if (!controller.signal.aborted) patch(chatId, attachment.id, { status: 'ready', imageId: result.id, progress: 100 });
      })().catch(error => {
        if (!controller.signal.aborted) {
          patch(chatId, attachment.id, { status: 'error', error: error instanceof Error ? error.message : '上传失败，点击重试。' });
          if ((error as { status?: number }).status === 401) report(error);
        }
      }).finally(() => { running.current--;jobs.current.delete(attachment.id);pump(); });
    });pump();
  }
  function add(chatId: string, files: File[]) {
    const existing = current.current[chatId] || [];
    if (existing.length + files.length > 3) { report(new Error('每次最多上传 3 张图片。'));return; }
    const attachments = files.map(source => ({ id: crypto.randomUUID(), source, name: source.name, preview: URL.createObjectURL(source), status: 'preparing' as const, progress: 0 }));
    update(chatId, images => [...images, ...attachments]);attachments.forEach(image => start(chatId, image));
  }
  function remove(chatId: string, id: string) {
    jobs.current.get(id)?.abort();
    const image = current.current[chatId]?.find(item => item.id === id);if (image && ![...retained.current.values()].includes(image.preview)) URL.revokeObjectURL(image.preview);
    update(chatId, images => images.filter(item => item.id !== id));
  }
  function clear(chatId: string, ids?: string[]) {
    for (const image of current.current[chatId] || []) if (!ids || ids.includes(image.id)) remove(chatId, image.id);
  }
  function commit(chatId: string, ids: string[]) {
    for (const image of current.current[chatId] || []) if (ids.includes(image.id) && image.imageId) retained.current.set(image.imageId, image.preview);
    clear(chatId, ids);
    while (retained.current.size > 16) { const [id, preview] = retained.current.entries().next().value!;URL.revokeObjectURL(preview);retained.current.delete(id); }
    setSentPreviews(Object.fromEntries(retained.current));
  }
  function reset() { for (const id of Object.keys(current.current)) clear(id);for (const preview of retained.current.values()) URL.revokeObjectURL(preview);retained.current.clear();setSentPreviews({}); }
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false;for (const job of jobs.current.values()) job.abort();waiting.current = [];for (const images of Object.values(current.current)) for (const image of images) URL.revokeObjectURL(image.preview);for (const preview of retained.current.values()) URL.revokeObjectURL(preview); };
  }, []);
  return { byChat, sentPreviews, add, remove, commit, reset, retry: (chatId: string, image: GuestChatAttachment) => start(chatId, image) };
}
