import assert from 'node:assert/strict';

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { BtwPanel } from '@/modules/chat/modals/BtwPanel';
import type { BtwRequest } from '@/shared/types';

vi.mock('@/modules/chat/transcript/Markdown', () => ({ Markdown: ({ children }: any) => <div>{children}</div> }));
const instances: FakeSocket[] = [];
class FakeSocket {
  static CONNECTING = 0;static OPEN = 1;static CLOSED = 3;
  readyState = 0;
  sent: any[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { instances.push(this); }
  open() { this.readyState = 1;this.onopen?.(); }
  frame(data: any) { this.onmessage?.({ data: JSON.stringify(data) }); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3;this.onclose?.(); }
}
const REQUEST: BtwRequest = { key: 'window', sessionId: 'parent', question: 'Initial side question', model: 'gpt-6.1-sol', effort: 'low' };
beforeEach(() => { instances.length = 0;vi.stubGlobal('WebSocket', FakeSocket); });
afterEach(() => { cleanup();vi.unstubAllGlobals(); });

test('BTW streams one row per native item, accepts a follow-up and cleans up on close', async () => {
  const onClose = vi.fn();const view = render(<BtwPanel request={REQUEST} onClose={onClose} />);
  const socket = instances[0];assert.ok(socket.url.includes('/btw'));
  await act(async () => { socket.open();socket.frame({ kind: 'btw_ready' });
    socket.frame({ kind: 'btw_message', id: 'question', role: 'user', content: 'Initial side question' });
    socket.frame({ kind: 'btw_message', id: 'answer', role: 'assistant', content: 'A streamed' });
    socket.frame({ kind: 'btw_message', id: 'answer', role: 'assistant', content: 'A streamed answer' });
    socket.frame({ kind: 'btw_status', busy: false }); });
  assert.equal(socket.sent[0].sessionId, 'parent');assert.equal(socket.sent[0].question, REQUEST.question);
  assert.equal(view.getByRole('dialog').querySelectorAll('[data-btw-message="assistant"]').length, 1);
  assert.ok(view.getByText('A streamed answer'));
  fireEvent.change(view.getByRole('textbox'), { target: { value: 'Follow-up question' } });
  fireEvent.submit(view.getByRole('dialog').querySelector('form')!);
  assert.deepEqual(socket.sent.at(-1), { type: 'send', content: 'Follow-up question' });
  fireEvent.click(view.getByRole('button', { name: /Stop|停止/ }));assert.equal(socket.sent.at(-1).type, 'stop');
  fireEvent.keyDown(view.getByRole('textbox'), { key: 'Escape' });assert.equal(onClose.mock.calls.length, 1);
  view.unmount();assert.equal(socket.sent.at(-1).type, 'finish');assert.equal(socket.readyState, FakeSocket.CLOSED);
});

test('closing during connection setup releases the socket without starting a fork', async () => {
  const view = render(<BtwPanel request={REQUEST} onClose={() => {}} />);const socket = instances[0];
  view.unmount();socket.open();assert.equal(socket.readyState, FakeSocket.CLOSED);assert.deepEqual(socket.sent, []);
});

test('a lost socket ends the temporary UI and preserves the reply for reading', async () => {
  const view = render(<BtwPanel request={REQUEST} onClose={() => {}} />);const socket = instances[0];
  await act(async () => { socket.open();socket.frame({ kind: 'btw_ready' });
    socket.frame({ kind: 'btw_message', id: 'answer', role: 'assistant', content: 'Saved in the window' });socket.close(); });
  assert.ok(view.getByText('Saved in the window'));
  assert.equal((view.getByRole('textbox') as HTMLTextAreaElement).disabled, true);
  assert.ok(view.getByText(/Conversation ended|对话已结束/));
});
