import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { reserveAttachmentUpload } from '@/modules/assets/services/image-assets.service.js';

test('lost upload acknowledgements and concurrent retries reuse only the same authenticated owner result', async () => {
  const id = randomUUID();let count = 0;let finish!: (value: []) => void;
  const upload = () => { count++;return new Promise<[]>(resolve => { finish = resolve; }); };
  const first = reserveAttachmentUpload('alice', id, upload);const second = reserveAttachmentUpload('alice', id, upload);
  await Promise.resolve();assert.equal(count, 1);assert.equal(second.reused, true);finish([]);await first.promise;
  const third = reserveAttachmentUpload('alice', id, upload);assert.equal(third.reused, true);
  const other = reserveAttachmentUpload('bob', id, async () => []);assert.equal(other.reused, false);await other.promise;
});

test('failed upload reservations are released for an explicit retry', async () => {
  const id = randomUUID();const first = reserveAttachmentUpload('alice', id, async () => { throw new Error('connection interrupted'); });
  await assert.rejects(first.promise, /interrupted/);
  const retry = reserveAttachmentUpload('alice', id, async () => []);assert.equal(retry.reused, false);await retry.promise;
});
