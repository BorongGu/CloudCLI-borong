import type { AnyRecord, CodexRpcConnection, ProviderPermissionDecision, ProviderRuntimeWriter } from '@/shared/types.js';
import { sharedCodexConnection } from '@/modules/providers/list/codex/codex-shared-connection.js';

type Binding = { sessionId: string; writer: ProviderRuntimeWriter };
type QuestionRequest = { requestId: string; toolName: string; sessionId: string; input: AnyRecord; context: AnyRecord };

/** Codex runtime and protocol tests use this bridge for native and asynchronous question cards. */
export class CodexQuestions {
  private connectionEpoch = 0;
  private bindings = new Map<string, Binding>();
  private resolved = new Set<string>();
  private released = new Set<string>();
  private pending = new Map<string, { threadId: string; nativeId?: number | string; request: QuestionRequest }>();

  constructor(private readonly client: CodexRpcConnection) {
    client.on('serverRequest', message => this.receiveRequest(message));
    client.on('notification', message => {
      const p = message.params || {};
      if (message.method === 'serverRequest/resolved') this.remove(`codex:rpc:${p.requestId}`);
      if (message.method === 'item/completed') this.receiveItem(p.threadId, p.item);
    });
    client.on('disconnect', () => {
      this.connectionEpoch++;
      for (const id of this.pending.keys()) this.remove(id, true);
    });
  }

  /** Runtime binds the app session before turn startup; retained requests then become visible. */
  bind(sessionId: string, threadId: string, writer: ProviderRuntimeWriter): void {
    const existing = this.bindings.has(threadId);
    this.bindings.set(threadId, { sessionId, writer });
    this.released.delete(threadId);
    if (!existing) void this.restore(threadId);
    for (const request of this.client.pendingRequests?.(threadId) || []) this.receiveRequest(request);
  }

  /** Session subscriptions recover persisted cards even after the native turn has completed. */
  async restorePending(sessionId: string, threadId: string, writer: ProviderRuntimeWriter): Promise<void> {
    let observed: Binding | undefined;
    if (!this.bindings.has(threadId)) {
      observed = { sessionId, writer };this.bindings.set(threadId, observed);
    }
    await this.restore(threadId);
    for (const request of this.client.pendingRequests?.(threadId) || []) this.receiveRequest(request);
    // A live runtime may bind while history is being read and then owns this thread's writer.
    if (observed && this.bindings.get(threadId) === observed) this.release(threadId);
  }

  private async restore(threadId: string): Promise<void> {
    const epoch = this.connectionEpoch;
    try {
      const history = await this.client.call('thread/items/list', { threadId, limit: 200, sortDirection: 'desc' });
      if (epoch !== this.connectionEpoch) return;
      const items = (history.data || []).map((entry: AnyRecord) => entry.item);
      // Read answers first so a refresh only publishes questions still awaiting input.
      for (const item of items) if (item?.type === 'userMessage') this.receiveItem(threadId, item);
      for (const item of items.reverse()) if (item?.type === 'agentMessage') this.receiveItem(threadId, item);
    } catch { /* A fresh thread may not yet have any persisted items. Live events remain attached. */ }
  }

  private receiveRequest(message: { id: number | string; method: string; params: AnyRecord }): void {
    if (message.method !== 'item/tool/requestUserInput') return;
    const p = message.params;
    this.add(p.threadId, `codex:rpc:${message.id}`, p.questions, {
      provider: 'codex', isBlocking: p.isBlocking !== false, nativeId: message.id,
    }, message.id);
  }

  private receiveItem(threadId: string, item: AnyRecord): void {
    if (item?.type === 'agentMessage' && Array.isArray(item.questions) && item.questions.length) {
      this.add(threadId, `codex:async:${item.id}`, item.questions.map((q: AnyRecord, index: number) => ({
        id: String(index), question: q.title, options: q.options?.map((label: string) => ({ label })), isOther: true,
      })), { provider: 'codex', isBlocking: false, nativeAsync: true, itemId: item.id });
    }
    if (item?.type === 'userMessage') {
      for (const part of item.content || []) {
        if (part.type !== 'text' || !part.text?.includes('<send_user_message_question_reply>')) continue;
        try {
          const replies = JSON.parse(part.text.split('<send_user_message_question_reply>')[1].split('</send_user_message_question_reply>')[0]);
          for (const reply of replies) {
            const id = JSON.parse(reply.questionItemId)[1];
            this.remove(`codex:async:${id}`);
          }
        } catch { /* Ordinary user text can contain a partial answer tag. */ }
      }
    }
  }

  private add(threadId: string, requestId: string, questions: AnyRecord[], context: AnyRecord, nativeId?: number | string): void {
    const binding = this.bindings.get(threadId);
    if (!binding || this.resolved.has(requestId) || this.pending.has(requestId) || !Array.isArray(questions)) return;
    const input = { questions: questions.map(q => ({
      id: q.id, question: q.question, header: q.header, allowOther: q.isOther !== false,
      isSecret: q.isSecret === true, options: Array.isArray(q.options) ? q.options : [],
    })) };
    const request = { requestId, toolName: 'AskUserQuestion', sessionId: binding.sessionId, input, context };
    this.pending.set(requestId, { threadId, nativeId, request });
    binding.writer.send({ kind: 'permission_request', provider: 'codex', ...request });
  }

  private remove(requestId: string, cancelled = false): void {
    if (!cancelled) this.resolved.add(requestId);
    if (this.resolved.size > 2000) this.resolved.delete(this.resolved.values().next().value!);
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    this.bindings.get(entry.threadId)?.writer.send({
      kind: cancelled ? 'permission_cancelled' : 'permission_resolved', provider: 'codex',
      sessionId: entry.request.sessionId, requestId,
    });
    if (this.released.has(entry.threadId)) this.release(entry.threadId);
  }

  /** Runtime cleanup releases finished thread writers after their outstanding cards settle. */
  release(threadId: string): void {
    this.released.add(threadId);
    if (![...this.pending.values()].some(entry => entry.threadId === threadId)) {
      this.bindings.delete(threadId); this.released.delete(threadId);
    }
  }

  /** Existing permission gateway replays questions when a browser refreshes or reconnects. */
  listPending(sessionId: string): QuestionRequest[] {
    return [...this.pending.values()].filter(entry => entry.request.sessionId === sessionId).map(entry => entry.request);
  }

  /** Native request replies retain question ids; async cards are cleared after the chat input is accepted. */
  resolve(requestId: string, decision: ProviderPermissionDecision): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    if (entry.nativeId !== undefined) {
      const supplied = (decision.updatedInput as AnyRecord)?.answers || {};
      const answers: AnyRecord = {};
      for (const question of entry.request.input.questions) {
        const value = supplied[question.id] ?? supplied[question.question];
        answers[question.id] = { answers: decision.allow && value ? (Array.isArray(value) ? value : [String(value)]) : [] };
      }
      if (!this.client.respond) throw new Error('Codex question replies require a live RPC connection.');
      this.client.respond(entry.nativeId, { answers });
    }
    this.remove(requestId);
  }
}

/** Shared by the Codex runtime and its provider-neutral permissions gateway. */
export const codexQuestions = new CodexQuestions(sharedCodexConnection);
