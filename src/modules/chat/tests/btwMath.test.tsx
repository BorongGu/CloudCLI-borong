import assert from 'node:assert/strict';

import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { BtwPanel } from '@/modules/chat/modals/BtwPanel';
import type { BtwMessage, BtwRequest } from '@/shared/types';

const conversation = vi.hoisted(() => ({ messages: [] as BtwMessage[] }));
// Render complete formula snapshots here; frame pacing has its own clock-driven tests.
vi.mock('@/modules/chat/hooks/useProgressiveText', () => ({ useProgressiveText: (content: string) => content }));
vi.mock('@/modules/chat/hooks/useBtwConversation', () => ({ useBtwConversation: () => ({
  messages: conversation.messages, ready: true, busy: false, busySince: 0, closed: false,
  error: '', label: '', phase: '', draft: '', setDraft() {}, send() {}, stop() {},
}) }));
vi.mock('@/modules/command-palette', () => ({
  usePaletteOps: () => ({ openFileInEditor: vi.fn(), openDirectory: vi.fn() }),
}));

beforeEach(() => { sessionStorage.clear();conversation.messages = []; });
afterEach(cleanup);

const request = (provider: BtwRequest['provider']): BtwRequest => ({
  key: `math-${provider}`, sessionId: 'source', provider, question: '', effort: 'default',
  model: provider === 'codex' ? 'gpt-6.1-sol' : 'opencode-go/glm-5.3-flash',
});

for (const provider of ['codex', 'opencode'] as const) {
  for (const role of ['user', 'assistant'] as const) {
    test(`${provider} BTW ${role} renders inline and display math with the shared renderer`, () => {
      conversation.messages = [{ id: 'math', role, content: String.raw`行内 $x^2$ 和 \(y=2\)。

$$
E=mc^2
$$

\[a^2+b^2=c^2\]

公式后的 **加粗说明**。` }];
      const view = render(<BtwPanel request={request(provider)} onClose={() => {}} />);
      const panel = view.getByRole('dialog');
      assert.equal(panel.querySelectorAll('.katex').length, 4);
      assert.equal(panel.querySelectorAll('.katex-display').length, 2);
      assert.equal(panel.querySelectorAll('.katex-error').length, 0);
      assert.equal(panel.querySelector('strong')?.textContent, '加粗说明');
    });
  }

  test(`${provider} BTW growing formulas replace the same answer and preserve following prose`, () => {
    const source = request(provider);
    conversation.messages = [{ id: 'answer', role: 'assistant', content: '计算：\n\n$$\n\\frac{' }];
    const view = render(<BtwPanel request={source} onClose={() => {}} />);
    conversation.messages = [{ id: 'answer', role: 'assistant', content: '计算：\n\n$$\n\\frac{a}{b}=c\n$$\n\n计算完成，**结果**如上。' }];
    view.rerender(<BtwPanel request={source} onClose={() => {}} />);
    const panel = view.getByRole('dialog');
    assert.equal(panel.querySelectorAll('[data-btw-message="assistant"]').length, 1);
    assert.equal(panel.querySelectorAll('.katex-display').length, 1);
    assert.equal(panel.querySelectorAll('.katex-error').length, 0);
    assert.equal(panel.querySelector('strong')?.textContent, '结果');
    assert.ok(panel.textContent?.includes('计算完成'));
  });
}
