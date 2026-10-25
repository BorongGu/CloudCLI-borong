import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexSessionsProvider } from '../list/codex/codex-sessions.provider.js';

test('live assistant snapshots preserve the native item id across all updates', () => {
  const provider = new CodexSessionsProvider();
  const contents = ['', '收到', '收到，测试', '收到，测试消息已成功发送。'];
  const rows = contents.flatMap(content => provider.normalizeMessage({
    type: 'item', itemType: 'agent_message', itemId: 'native-answer',
    message: { role: 'assistant', content },
  }, 'app-session'));
  assert.equal(rows.length, contents.length);
  assert.deepEqual(rows.map(row => row.id), contents.map(() => 'native-answer'));
  assert.deepEqual(rows.map(row => row.content), contents);
});

test('live reasoning keeps its item identity and thinking kind', () => {
  const provider = new CodexSessionsProvider();
  const [row] = provider.normalizeMessage({
    type: 'item', itemType: 'reasoning', itemId: 'native-reasoning',
    message: { role: 'assistant', content: 'Checking the result.', isReasoning: true },
  }, 'app-session');
  assert.equal(row.id, 'native-reasoning');
  assert.equal(row.kind, 'thinking');
});

test('persisted assistant entries keep the history identity', () => {
  const [row] = new CodexSessionsProvider().normalizeMessage({
    uuid: 'history-answer', type: 'assistant',
    message: { role: 'assistant', content: 'Complete reply.' },
  }, 'app-session');
  assert.equal(row.id, 'history-answer');
  assert.equal(row.content, 'Complete reply.');
});

test('native asynchronous question replies render their selected answers after a history reload', () => {
  const [row] = new CodexSessionsProvider().normalizeMessage({
    uuid: 'native-reply', message: { role: 'user', content: '<send_user_message_question_reply>\n[{"answer":"Mac","question":"Which host?","questionItemId":"native-id"}]\n</send_user_message_question_reply>' },
  }, 'app-session');
  assert.equal(row.role, 'user');assert.equal(row.content, 'Which host?\nMac');
});
