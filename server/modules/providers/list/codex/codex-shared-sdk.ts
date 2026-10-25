import type { ThreadOptions } from '@openai/codex-sdk';
import type { AnyRecord as RecordValue } from '../../../../shared/index.js';
import { sharedCodexConnection } from './codex-shared-connection.js';
import { executeCodexGoal } from './codex-goals.provider.js';
import type { CodexGoal, CodexGoalCommand, CodexRpcConnection } from '@/shared/types.js';

type Event = RecordValue & { type: string };
type Input = string | Array<RecordValue>;
type RunOptions = { signal?: AbortSignal; goalCommand?: CodexGoalCommand | null; observeGoal?: boolean };

function status(value: string | undefined): string {
  return value === 'inProgress' ? 'in_progress' : (value || 'in_progress');
}

function transformItem(item: RecordValue): RecordValue | null {
  const common = { id: item.id };
  switch (item.type) {
    case 'agentMessage':
    case 'plan': return { ...common, type: 'agent_message', text: item.text || '' };
    case 'reasoning': return { ...common, type: 'reasoning', text: (item.summary || item.content || []).join('\n') };
    case 'commandExecution': return {
      ...common, type: 'command_execution', command: item.command,
      aggregated_output: item.aggregatedOutput || '', exit_code: item.exitCode,
      status: status(item.status),
    };
    case 'fileChange': return {
      ...common, type: 'file_change', status: status(item.status),
      changes: (item.changes || []).map((change: RecordValue) => ({
        path: change.path, kind: typeof change.kind === 'string' ? change.kind : change.kind?.type,
      })),
    };
    case 'mcpToolCall': return {
      ...common, type: 'mcp_tool_call', server: item.server, tool: item.tool,
      arguments: item.arguments, result: item.result, error: item.error, status: status(item.status),
    };
    case 'dynamicToolCall': return {
      ...common, type: 'mcp_tool_call', server: item.namespace, tool: item.tool,
      arguments: item.arguments, result: item.contentItems,
      error: item.success === false ? { message: JSON.stringify(item.contentItems) } : undefined,
      status: status(item.status),
    };
    case 'webSearch': return { ...common, type: 'web_search', query: item.query };
    default: return null;
  }
}

function nativeInput(input: Input): Array<RecordValue> {
  if (typeof input === 'string') return [{ type: 'text', text: input }];
  return input.map(item => item.type === 'local_image' ? { ...item, type: 'localImage' } : item);
}

/** SDK-shaped thread consumed by the Codex runtime's existing normalization. */
export class SharedCodexThread {
  id: string | null;

  constructor(private readonly client: CodexRpcConnection, threadId: string | null,
    private readonly options: ThreadOptions = {}) { this.id = threadId; }

  async runStreamed(input: Input, options: RunOptions = {}) {
    return { events: this.events(input, options) };
  }

  private async *events(input: Input, runOptions: RunOptions): AsyncGenerator<Event> {
    const { signal, goalCommand, observeGoal } = runOptions;
    const queue: Event[] = [];
    const items = new Map<string, RecordValue>();
    let wake: (() => void) | null = null;
    let finished = false;
    let targetTurn: string | null = null;
    let accepted = false;
    let usage: RecordValue | null = null;
    let interruption: Promise<unknown> | null = null;
    let goal: CodexGoal | null = null;
    let goalRevision = 0;
    let nativeRunning = false;
    const observedTurns = new Set<string>();
    const goalIsActive = () => goal?.status === 'active';
    const push = (event: Event) => { queue.push(event); wake?.(); wake = null; };
    const synchronizeGoal = async (command: CodexGoalCommand) => {
      const revision = goalRevision;
      const result = await executeCodexGoal(this.client, this.id!, command);
      // A notification received during the RPC is newer than its response snapshot.
      if (revision === goalRevision) goal = result;
    };
    const complete = async (turn: RecordValue) => {
      if (targetTurn === turn.id) { targetTurn = null; nativeRunning = false; }
      if (turn.status === 'completed') push({ type: 'turn.completed', ...(usage ? { usage } : {}) });
      else push({ type: 'turn.failed', error: turn.error || { message: `Codex turn ${turn.status}` } });
      if (turn.status !== 'completed') { finished = true; return; }
      // Goal continuation is owned by Codex. Keep observing its following turns.
      if (goal) {
        await synchronizeGoal({ action: 'get' });
        push({ type: 'goal.updated', goal });
      }
      if (!goalIsActive() && !nativeRunning) finished = true;
    };
    const disconnected = (error: Error) => {
      push({ type: 'turn.failed', error: { message: error.message } }); finished = true;
    };
    const notification = (message: { method: string; params: RecordValue }) => {
      const p = message.params || {};
      if (p.threadId !== this.id) return;
      if (message.method === 'thread/goal/updated' || message.method === 'thread/goal/cleared') {
        goalRevision++;
        goal = message.method === 'thread/goal/cleared' ? null : p.goal;
        push({ type: 'goal.updated', goal });
        if (accepted && !goalIsActive() && !nativeRunning) finished = true;
        return;
      }
      if (message.method === 'turn/started' && (!targetTurn || goalIsActive())) {
        targetTurn = p.turn.id; nativeRunning = true; observedTurns.add(targetTurn!);
      }
      if (targetTurn && p.turnId && p.turnId !== targetTurn) return;
      if (message.method === 'item/started' || message.method === 'item/completed') {
        const item = p.item;
        items.set(item.id, item);
        const transformed = transformItem(item);
        if (transformed) push({ type: message.method === 'item/started' ? 'item.started' : 'item.completed', item: transformed });
      } else if (message.method === 'item/agentMessage/delta') {
        const item = items.get(p.itemId) || { id: p.itemId, type: 'agentMessage', text: '' };
        item.text = (item.text || '') + p.delta; items.set(item.id, item);
        push({ type: 'item.updated', item: transformItem(item) });
      } else if (message.method === 'item/reasoning/summaryTextDelta') {
        const item = items.get(p.itemId) || { id: p.itemId, type: 'reasoning', summary: [] };
        item.summary ||= [];
        const index = p.summaryIndex || 0;
        item.summary[index] = (item.summary[index] || '') + p.delta; items.set(item.id, item);
        push({ type: 'item.updated', item: transformItem(item) });
      } else if (message.method === 'item/commandExecution/outputDelta') {
        const item = items.get(p.itemId);
        if (item) {
          item.aggregatedOutput = (item.aggregatedOutput || '') + p.delta;
          push({ type: 'item.updated', item: transformItem(item) });
        }
      } else if (message.method === 'turn/plan/updated') {
        push({ type: 'item.updated', item: {
          id: `plan-${p.turnId}`, type: 'todo_list',
          items: (p.plan || []).map((step: RecordValue) => ({ text: step.step, completed: step.status === 'completed' })),
        } });
      } else if (message.method === 'thread/tokenUsage/updated') {
        const total = p.tokenUsage.total || {};
        usage = { input_tokens: total.inputTokens, output_tokens: total.outputTokens,
          total_tokens: total.totalTokens, model_context_window: p.tokenUsage.modelContextWindow };
      } else if (message.method === 'turn/completed') {
        push({ type: '_completion', turn: p.turn });
      }
    };
    const abort = () => {
      const interruptedTurn = targetTurn;
      if (this.id) interruption = (async () => {
        if (goalIsActive()) await executeCodexGoal(this.client, this.id!, { action: 'pause' }).catch(() => {});
        if (interruptedTurn) await this.client.call('turn/interrupt', {
          threadId: this.id, turnId: interruptedTurn,
        }).catch(() => {});
      })();
      finished = true; wake?.(); wake = null;
    };
    this.client.on('notification', notification);
    this.client.on('disconnect', disconnected);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) return;
      const threadOptions = this.options;
      const nativeOptions = {
        cwd: threadOptions.workingDirectory, model: threadOptions.model,
        sandbox: threadOptions.sandboxMode, approvalPolicy: threadOptions.approvalPolicy,
        ...(threadOptions.modelReasoningEffort ? { config: { model_reasoning_effort: threadOptions.modelReasoningEffort } } : {}),
      };
      const session = this.id
        ? await this.client.call('thread/resume', { threadId: this.id, excludeTurns: true, ...(goalCommand ? nativeOptions : {}) })
        : await this.client.call('thread/start', nativeOptions);
      this.id = session.thread.id;
      push({ type: 'thread.started', thread_id: this.id });
      if (signal?.aborted) return;
      // Older servers can still serve ordinary turns through the existing path.
      try { await synchronizeGoal({ action: 'get' }); }
      catch (error) { if (goalCommand || observeGoal) throw error; }
      if (goalCommand) await synchronizeGoal(goalCommand);
      if (goal || goalCommand || observeGoal) push({ type: 'goal.updated', goal });
      const content = nativeInput(input);
      let currentTurn: RecordValue | undefined;
      if (session.thread.status?.type === 'active' || goalCommand || observeGoal || goalIsActive()) {
        const latest = await this.client.call('thread/turns/list', {
          threadId: this.id, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded',
        });
        currentTurn = latest.data?.find((turn: RecordValue) => turn.status === 'inProgress');
      }
      if (signal?.aborted) return;
      if (goalCommand || observeGoal) {
        // Setting/resuming an active native goal starts continuation on the daemon.
        // Adopt a turn already in flight, or await its turn/started notification.
        if (currentTurn) { targetTurn = currentTurn.id; observedTurns.add(currentTurn.id); nativeRunning = true; }
        accepted = true;
        if (!goalIsActive() && !nativeRunning) finished = true;
      } else if (currentTurn) {
        targetTurn = currentTurn.id;
        observedTurns.add(currentTurn.id); nativeRunning = true;
        try {
          await this.client.call('turn/steer', { threadId: this.id, expectedTurnId: targetTurn, input: content });
          accepted = true;
        } catch (error) {
          // A rejected precondition is safe to retry as a new turn. A timed-out
          // submission has an unknown outcome, so it is returned without replay.
          if (!/no active turn|expected.*turn|turn.*mismatch|not.*in.progress/i.test(String(error))) throw error;
          targetTurn = null;
        }
      }
      if (!accepted) {
        const turn = await this.client.call('turn/start', {
          threadId: this.id, input: content, cwd: threadOptions.workingDirectory,
          model: threadOptions.model, effort: threadOptions.modelReasoningEffort,
          approvalPolicy: threadOptions.approvalPolicy,
          sandboxPolicy: threadOptions.sandboxMode === 'danger-full-access'
            ? { type: 'dangerFullAccess' }
            : { type: 'workspaceWrite', writableRoots: threadOptions.workingDirectory ? [threadOptions.workingDirectory] : [], networkAccess: false },
        });
        targetTurn = turn.turn.id; accepted = true;
        observedTurns.add(targetTurn!); nativeRunning = true;
      }
      if (signal?.aborted) { abort(); return; }
      while (!finished || queue.length) {
        if (!queue.length) { await new Promise<void>(resolve => { wake = resolve; }); continue; }
        const event = queue.shift()!;
        if (event.type === '_completion') {
          if (observedTurns.has(event.turn.id)) await complete(event.turn);
          continue;
        }
        yield event;
      }
    } finally {
      signal?.removeEventListener('abort', abort);
      this.client.off('notification', notification);
      this.client.off('disconnect', disconnected);
      await interruption;
    }
  }
}

/** Shared-app-server adapter used by the Codex runtime and its focused tests. */
export class SharedCodex {
  constructor(private readonly client: CodexRpcConnection = sharedCodexConnection) {}
  startThread(options: ThreadOptions = {}): SharedCodexThread {
    return new SharedCodexThread(this.client, null, options);
  }
  resumeThread(threadId: string, options: ThreadOptions = {}): SharedCodexThread {
    return new SharedCodexThread(this.client, threadId, options);
  }
}
