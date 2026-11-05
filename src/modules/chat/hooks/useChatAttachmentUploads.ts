import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import { optimizeChatImage } from '@/shared/utils';
import type { ChatAttachment, ChatAttachmentProgress } from '@/shared/types';

type UploadRecord = { id: string; file?: File; result?: ChatAttachment; promise?: Promise<ChatAttachment>; controller?: AbortController };

function requestId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));bytes[6] = (bytes[6] & 15) | 64;bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The workspace composer prepares/uploads selected files ahead of sending and reuses successful descriptors. */
export function useChatAttachmentUploads(files: File[]) {
  // Thumbnails expose transfer progress independently of the active model's work status.
  const [progress, setProgress] = useState(new Map<File, ChatAttachmentProgress>());
  const records = useRef(new WeakMap<File, UploadRecord>());
  const controllers = useRef(new Set<AbortController>());
  const waiting = useRef<Array<() => void>>([]);
  const running = useRef(0);
  const mounted = useRef(true);
  const update = useCallback((file: File, state: ChatAttachmentProgress) => {
    if (mounted.current) setProgress(previous => {
      const next = new Map(previous);next.delete(file);next.set(file, state);
      // Completed previews can be looked up again from their weakly held upload record.
      if (next.size > 40) for (const [old, value] of next) { if (old !== file && (value.phase === 'ready' || value.phase === 'error')) { next.delete(old);if (next.size <= 40) break; } }
      return next;
    });
  }, []);
  const start = useCallback((source: File): Promise<ChatAttachment> => {
    let record = records.current.get(source);
    if (record?.result) return Promise.resolve(record.result);
    if (record?.promise) return record.promise;
    record ||= { id: requestId() };records.current.set(source, record);
    const entry = record;const controller = new AbortController();entry.controller = controller;controllers.current.add(controller);
    update(source, { phase: 'preparing', percent: 0 });
    const pump = () => { while (running.current < 2 && waiting.current.length) waiting.current.shift()?.(); };
    entry.promise = new Promise<ChatAttachment>((resolve, reject) => {
      waiting.current.push(() => {
        running.current++;
        void (async () => {
          if (controller.signal.aborted) throw new DOMException('Upload cancelled', 'AbortError');
          if (!entry.file) {
            const blob = await optimizeChatImage(source).catch(() => source);
            const extension = blob.type === 'image/png' ? '.png' : blob.type === 'image/jpeg' ? '.jpg' : '.webp';
            entry.file = blob === source ? source : new File([blob], source.name.replace(/\.[^.]+$/, '') + extension, { type: blob.type, lastModified: source.lastModified });
          }
          const form = new FormData();form.append('files', entry.file);
          update(source, { phase: 'uploading', percent: 0 });
          const response = await api.assets.uploadFiles(form, { requestId: entry.id, signal: controller.signal, onProgress: percent => update(source, { phase: 'uploading', percent }) });
          const body = await response.json().catch(() => ({ error: '文件上传确认失败，请重试。' }));
          if (!response.ok || body.attachments?.length !== 1) throw new Error(body.error || '文件上传确认失败，请重试。');
          const attachment = body.attachments[0] as ChatAttachment;entry.result = attachment;
          if (entry.file.type.startsWith('image/') && attachment.path) api.assets.cacheImage(attachment.path.split(/[\\/]/).pop()!, entry.file);
          update(source, { phase: 'ready', percent: 100 });resolve(attachment);
        })().catch(error => {
          update(source, { phase: 'error', percent: 0, error: error instanceof Error ? error.message : '上传失败，请重试。' });reject(error);
        }).finally(() => { entry.promise = undefined;entry.controller = undefined;controllers.current.delete(controller);running.current--;pump(); });
      });
    });pump();return entry.promise;
  }, [update]);

  useEffect(() => {
    for (const file of files) if (!records.current.has(file)) void start(file).catch(() => {});
  }, [files, start]);
  useEffect(() => {
    mounted.current = true;
    const activeControllers = controllers.current;
    return () => { mounted.current = false;for (const controller of activeControllers) controller.abort(); };
  }, []);
  const upload = useCallback((selected: File[]) => Promise.all(selected.map(start)), [start]);
  const retry = useCallback((file: File) => { void start(file).catch(() => {}); }, [start]);
  const cancel = useCallback((file: File) => { records.current.get(file)?.controller?.abort();setProgress(previous => { const next = new Map(previous);next.delete(file);return next; }); }, []);
  return { progress, upload, retry, cancel };
}
