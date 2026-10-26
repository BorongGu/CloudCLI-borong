import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import { codexGoalsService } from '@/modules/providers/index.js';

/**
 * A session's turn ends while its agents, workflow or backgrounded command are
 * still going. The run registry marks the run completed at the turn's
 * `complete`, but the runtime keeps producing events through that run's
 * writer — task progress, and the turn the CLI pushes when the task reports.
 * A tab opened during that work has to attach to the run to see them, and the
 * run has to still be there to attach to.
 */

const SESSION_ID = 'held-session';
const FIVE_MINUTES = 5 * 60 * 1000;

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    frames: Array<Record<string, unknown>>;
    send: (data: string) => void;
  };
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(JSON.parse(data) as Record<string, unknown>);
  return socket;
}

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-background-subscribe-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory);
    await runTest();
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    chatRunRegistry.setRetentionGuard(() => false);
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** Starts a run for the session and ends its turn, leaving the run completed but registered. */
function startAndCompleteRun(connection: ReturnType<typeof createFakeSocket>) {
  const run = chatRunRegistry.startRun({
    appSessionId: SESSION_ID,
    provider: 'claude',
    providerSessionId: 'native-1',
    connection: connection as never,
    userId: 1,
  });
  assert.ok(run);
  run.writer.send({ kind: 'complete', provider: 'claude', sessionId: 'native-1', exitCode: 0 });
  assert.equal(chatRunRegistry.isProcessing(SESSION_ID), false);
  return run;
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 30); });

test('reconnect reattaches an active native goal once without submitting another prompt', async () => {
  await withIsolatedDatabase(async () => {
    const id = 'native-goal-app';sessionsDb.createAppSession(id, 'codex', '/workspace');
    sessionsDb.assignProviderSessionId(id, 'native-goal');
    const mocked = mock.method(codexGoalsService, 'execute', async () => ({ goal: { status: 'active' } } as never));
    let finish!: () => void;const held = new Promise<void>(resolve => { finish = resolve; });
    const calls: any[] = [];
    const runtime = { hasBackgroundWork: () => false, getPendingApprovalsForSession: () => [],
      async run(provider: string, command: string, options: any, writer: any) {
        calls.push({ provider, command, options });await held;
        writer.send({ kind: 'complete', provider: 'codex', sessionId: 'native-goal', exitCode: 0 });
      },
    };
    try {
      const socket = createFakeSocket();handleChatConnection(socket as never, { user: { id: 1 } } as never, { runtime: runtime as never });
      const frame = JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: id, watchGoal: true }] });
      socket.emit('message', frame);await settle();socket.emit('message', frame);await settle();
      assert.equal(calls.length, 1);assert.equal(calls[0].command, '');assert.equal(calls[0].options.codexGoalObserve, true);
      assert.ok(socket.frames.some(f => f.kind === 'chat_subscribed' && f.isProcessing === true));
    } finally { finish();await settle();mocked.mock.restore(); }
  });
});

test('a tab that subscribes during background work receives the run\'s later events', async () => {
  await withIsolatedDatabase(async () => {
    const run = startAndCompleteRun(createFakeSocket());

    const newTab = createFakeSocket();
    handleChatConnection(
      newTab as never,
      { user: { id: 1 } } as never,
      { runtime: { hasBackgroundWork: (sessionId: string) => sessionId === SESSION_ID, getPendingApprovalsForSession: () => [] } as never },
    );
    newTab.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION_ID, lastSeq: 0 }] }));
    await settle();

    // Not processing — the composer stays usable — but attached.
    assert.equal(newTab.frames[0]?.kind, 'chat_subscribed');
    assert.equal(newTab.frames[0]?.isProcessing, false);

    run.writer.send({ kind: 'task_status', provider: 'claude', sessionId: 'native-1', event: 'notification', taskId: 't1', status: 'completed' } as never);
    assert.ok(
      newTab.frames.some((frame) => frame.kind === 'task_status'),
      'the task event must reach the tab that subscribed after the turn ended',
    );
  });
});

test('goal observation attaches live output without replaying the transcript', async () => {
  await withIsolatedDatabase(async () => {
    const run = chatRunRegistry.startRun({ appSessionId: SESSION_ID, provider: 'claude', providerSessionId: 'native-1',
      connection: createFakeSocket() as never, userId: 1 });
    assert.ok(run);
    run.writer.send({ kind: 'text', text: 'Older assistant snapshot' } as never);
    run.writer.send({ kind: 'status', text: 'codex_goal', goal: { status: 'active', tokensUsed: 0 } } as never);
    const socket = createFakeSocket();
    handleChatConnection(socket as never, { user: { id: 1 } } as never, {
      runtime: { hasBackgroundWork: () => false, getPendingApprovalsForSession: () => [] } as never,
    });
    socket.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION_ID, replay: false }] }));
    await settle();
    assert.deepEqual(socket.frames.map(f => f.kind), ['chat_subscribed']);
    run.writer.send({ kind: 'status', text: 'codex_goal', goal: { status: 'paused', tokensUsed: 123 } } as never);
    assert.equal(socket.frames.at(-1)?.text, 'codex_goal');
    socket.frames.length = 0;
    socket.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION_ID, lastSeq: 0 }] }));
    await settle();
    assert.ok(socket.frames.some(f => f.text === 'Older assistant snapshot'));
    assert.ok(socket.frames.every(f => f.text !== 'codex_goal'));
  });
});

test('a tab that subscribes to an idle session is not attached to its old run', async () => {
  await withIsolatedDatabase(async () => {
    const run = startAndCompleteRun(createFakeSocket());

    const newTab = createFakeSocket();
    handleChatConnection(
      newTab as never,
      { user: { id: 1 } } as never,
      { runtime: { hasBackgroundWork: () => false, getPendingApprovalsForSession: () => [] } as never },
    );
    newTab.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION_ID, lastSeq: 0 }] }));
    await settle();

    run.writer.send({ kind: 'task_status', provider: 'claude', sessionId: 'native-1', event: 'notification', taskId: 't1', status: 'completed' } as never);
    assert.ok(!newTab.frames.some((frame) => frame.kind === 'task_status'));
  });
});

test('reconnecting after failure replays the retained error while leaving the session idle', async () => {
  await withIsolatedDatabase(async () => {
    const run = chatRunRegistry.startRun({ appSessionId: SESSION_ID, provider: 'claude', providerSessionId: 'native-1',
      connection: createFakeSocket() as never, userId: 1 });
    assert.ok(run);
    run.writer.send({ kind: 'text', content: 'Earlier response', role: 'assistant' } as never);
    const content = 'Selected model is at capacity. Please try a different model.';
    run.writer.send({ kind: 'error', id: 'capacity', content } as never);
    run.writer.send({ kind: 'complete', exitCode: 1 } as never);
    const socket = createFakeSocket();
    handleChatConnection(socket as never, { user: { id: 1 } } as never, {
      runtime: { hasBackgroundWork: () => false, getPendingApprovalsForSession: () => [] } as never,
    });
    socket.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION_ID, lastSeq: 0 }] }));
    await settle();
    assert.deepEqual(socket.frames.map(frame => frame.kind), ['chat_subscribed', 'error']);
    assert.equal(socket.frames[0].isProcessing, false);assert.equal(socket.frames[1].content, content);
    const lastSeq = socket.frames[1].seq;
    socket.frames.length = 0;
    socket.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION_ID, lastSeq }] }));
    await settle();assert.deepEqual(socket.frames.map(frame => frame.kind), ['chat_subscribed']);
  });
});

test('a completed run stays registered while its session still has background work', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await withIsolatedDatabase(async () => {
      let working = true;
      chatRunRegistry.setRetentionGuard((sessionId) => sessionId === SESSION_ID && working);
      startAndCompleteRun(createFakeSocket());

      mock.timers.tick(FIVE_MINUTES);
      assert.ok(chatRunRegistry.getRun(SESSION_ID), 'the run must outlive the retention window while work is outstanding');

      working = false;
      mock.timers.tick(FIVE_MINUTES);
      assert.equal(chatRunRegistry.getRun(SESSION_ID), undefined, 'once the work is gone the run is evicted as before');
    });
  } finally {
    mock.timers.reset();
  }
});

test('a retained run\'s eviction timer cannot evict the session\'s next run early', async () => {
  // Run one completes with work outstanding and is re-armed at five minutes;
  // run two takes the slot and completes with two minutes of retention to
  // go. Run one's timer firing on the slot alone would evict run two.
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await withIsolatedDatabase(async () => {
      let working = true;
      chatRunRegistry.setRetentionGuard((sessionId) => sessionId === SESSION_ID && working);
      const first = startAndCompleteRun(createFakeSocket());
      mock.timers.tick(FIVE_MINUTES);
      assert.equal(chatRunRegistry.getRun(SESSION_ID), first);

      working = false;
      mock.timers.tick(FIVE_MINUTES - 2 * 60 * 1000);
      const second = startAndCompleteRun(createFakeSocket());
      assert.equal(chatRunRegistry.getRun(SESSION_ID), second);

      // Run one's re-armed timer fires now; run two's has two minutes left.
      mock.timers.tick(2 * 60 * 1000);
      assert.equal(chatRunRegistry.getRun(SESSION_ID), second, 'run two keeps its own retention window');
      mock.timers.tick(FIVE_MINUTES);
      assert.equal(chatRunRegistry.getRun(SESSION_ID), undefined);
    });
  } finally {
    mock.timers.reset();
  }
});
