import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { contextRequestsDb, contextTransferDb, getDatabasePath, groupsDb, sessionsDb } from '@/modules/database/index.js';
import { providerRuntimeService, sessionsService } from '@/modules/providers/index.js';
import { broadcastSessionUpserted, runDetachedChatTurn } from '@/modules/websocket/index.js';
import { contextSnapshotService } from '@/modules/context-transfer/services/context-snapshot.service.js';
import { contextPackageService } from '@/modules/context-transfer/services/context-package.service.js';
import { contextDeliveryService } from '@/modules/context-transfer/services/context-delivery.service.js';
import { AppError, findApplicationRoot, getModuleDirectory } from '@/shared/index.js';
import type { ContextPackageInput, ContextRequest, ContextRequestInput } from '@/shared/index.js';

const APP_ROOT = findApplicationRoot(getModuleDirectory(import.meta.url));
const active = new Set<ContextRequest['status']>(['queued', 'preparing', 'analyzing', 'ready', 'delivering']);
function fail(message: string, code = 'CONTEXT_REQUEST_ERROR', statusCode = 400): never { throw new AppError(message, { code, statusCode }); }
function folder(id: string): string { return path.join(path.dirname(getDatabasePath()), 'context-requests', id); }
function hash(token: string): string { return createHash('sha256').update(token).digest('hex'); }
function quote(value: string): string { return `'${value.replace(/'/g, `'"'"'`)}'`; }
function bridgeUrl(id: string): string {
  const configured = process.env.HOST || '127.0.0.1';
  const host = configured === '0.0.0.0' || configured === '::' ? '127.0.0.1' : configured;
  return `http://${host.includes(':') ? `[${host}]` : host}:${process.env.SERVER_PORT || '3001'}/context-bridge/${id}`;
}

/** Slash-command routes and the scoped agent bridge share this persisted preparation workflow. */
export function createContextRequestService(overrides: Partial<{
  running: () => Promise<Set<string>>;
  prepare: typeof contextSnapshotService.prepare;
  sourceTurn: (userId: number, request: ContextRequest, prompt: string) => Promise<{ started: boolean; error: string | null }>;
  deliver: typeof contextDeliveryService.deliver;
}> = {}) {
  const dependencies = {
    running: async () => new Set((await sessionsService.listRunningSessions()).map(entry => entry.sessionId)),
    prepare: contextSnapshotService.prepare.bind(contextSnapshotService),
    sourceTurn: (userId: number, request: ContextRequest, prompt: string) => runDetachedChatTurn({ userId, sessionId: request.input.sourceSessionId, content: prompt,
      options: { contextPreparation: true, permissionMode: request.input.permissionMode, ...(request.input.sourceModel ? { model: request.input.sourceModel } : {}), ...(request.input.sourceEffort ? { effort: request.input.sourceEffort } : {}) } }, { runtime: providerRuntimeService }),
    deliver: contextDeliveryService.deliver.bind(contextDeliveryService), ...overrides,
  };
  const sourceRuns = new Set<string>();
  const packageWrites = new Map<string, Promise<ReturnType<typeof contextPackageService.read>>>();
  let polling = false;

  const service = {
    read(userId: number, id: string): ContextRequest {
      const request = contextRequestsDb.get(userId, id);
      if (!request) fail('Context request was not found.', 'CONTEXT_NOT_FOUND', 404);
      return request;
    },
    view(userId: number, id: string) {
      const request = this.read(userId, id);
      const delivery = request.deliveryId ? contextTransferDb.delivery(userId, request.deliveryId) : null;
      return { ...request, delivery, package: request.packageId ? contextTransferDb.package(userId, request.packageId) : null };
    },
    async create(userId: number, input: ContextRequestInput): Promise<ContextRequest> {
      const existing = contextRequestsDb.byRequest(userId, input.requestId);
      if (existing) {
        if (JSON.stringify(existing.input) !== JSON.stringify(input)) fail('requestId belongs to different choices.', 'CONTEXT_REQUEST_CONFLICT', 409);
        return existing;
      }
      const source = contextSnapshotService.source(userId, input.sourceSessionId);
      if (!source.project_path || !source.provider_session_id) fail('先在当前会话完成一轮对话，再传递上下文。');
      if (groupsDb.membership(source.session_id)) fail('请在普通会话中使用上下文传递。');
      if (input.target.kind === 'existing') {
        const target = sessionsDb.getSessionById(input.target.sessionId);
        if (!target || groupsDb.membership(target.session_id) || target.isArchived) fail('请选择可用的普通接收会话。');
        if (target.session_id === source.session_id) fail('请选择另一个接收会话。');
        if (input.mode === 'steer' && target.provider !== 'codex') fail('运行中注入适用于 Codex 接收会话。');
      } else if (input.mode === 'steer') fail('新会话请选择启动接手或下一轮读取。');
      if (contextRequestsDb.active(source.session_id)) fail('当前会话已有一项上下文传递正在进行，可重新打开面板查看。', 'CONTEXT_REQUEST_ACTIVE', 409);
      const id = randomUUID(), token = randomBytes(32).toString('hex');
      await mkdir(folder(id), { recursive: true, mode: 0o700 });
      await writeFile(path.join(folder(id), 'connection.json'), JSON.stringify({ url: bridgeUrl(id), token }), { mode: 0o600 });
      try { return contextRequestsDb.create(userId, id, input, hash(token)); }
      catch (error) { await rm(folder(id), { recursive: true, force: true }); throw error; }
    },
    authenticate(id: string, token: string): { userId: number; request: ContextRequest } {
      if (!token || token.length > 256) fail('Request credential is required.', 'CONTEXT_REQUEST_AUTH', 401);
      const userId = contextRequestsDb.authenticate(id, hash(token));
      if (!userId) fail('Request credential has expired or is invalid.', 'CONTEXT_REQUEST_AUTH', 401);
      return { userId, request: this.read(userId, id) };
    },
    async completePackage(userId: number, id: string, input: ContextPackageInput) {
      const current = this.read(userId, id);
      if (input.snapshotId !== current.snapshotId || input.scope.kind !== current.input.scope || input.granularity !== current.input.granularity) fail('Use the snapshot, scope and granularity chosen in this request.');
      if (current.packageId) return contextPackageService.read(userId, current.packageId);
      if (!['analyzing', 'ready'].includes(current.status)) fail('This preparation has ended.', 'CONTEXT_REQUEST_ENDED', 409);
      const ongoing = packageWrites.get(id); if (ongoing) return ongoing;
      const promise = (async () => {
        const value = await contextPackageService.create(userId, input);
        if (!contextRequestsDb.update(id, { packageId: value.id, status: 'ready', error: null }, 'analyzing')) fail('This preparation ended while the package was being written.', 'CONTEXT_REQUEST_ENDED', 409);
        return value;
      })();
      packageWrites.set(id, promise);
      try { return await promise; } finally { packageWrites.delete(id); }
    },
    cancel(userId: number, id: string): ContextRequest {
      const request = this.read(userId, id);
      if (!['queued', 'preparing', 'analyzing', 'ready', 'failed'].includes(request.status)) fail('交付已经开始，请在接收会话中查看或停止。', 'CONTEXT_DELIVERY_STARTED', 409);
      contextRequestsDb.update(id, { status: 'cancelled' });
      return this.read(userId, id);
    },
    async retry(userId: number, id: string): Promise<ContextRequest> {
      const request = this.read(userId, id);
      if (request.status !== 'failed') fail('这项传递仍在进行或已经完成。', 'CONTEXT_REQUEST_ACTIVE', 409);
      if (contextRequestsDb.active(request.input.sourceSessionId)) fail('当前会话已有一项传递在进行。', 'CONTEXT_REQUEST_ACTIVE', 409);
      const delivery = request.deliveryId && contextTransferDb.delivery(userId, request.deliveryId);
      if (delivery && ['submitting', 'delivered', 'uncertain'].includes(delivery.status)) fail('请先检查接收会话中的投递结果，再发起新的传递。', 'CONTEXT_DELIVERY_UNCERTAIN', 409);
      const token = randomBytes(32).toString('hex');
      await mkdir(folder(id), { recursive: true, mode: 0o700 });
      await writeFile(path.join(folder(id), 'connection.json'), JSON.stringify({ url: bridgeUrl(id), token }), { mode: 0o600 });
      contextRequestsDb.rotateToken(id, hash(token));
      contextRequestsDb.update(id, { status: request.packageId ? 'ready' : 'queued', deliveryId: null, deliveryKey: `context-request:${randomUUID()}`, error: null }, 'failed');
      return this.read(userId, id);
    },
    async tick(): Promise<void> {
      if (polling) return;
      const pending = contextRequestsDb.pending(); if (!pending.length) return;
      polling = true;
      try {
        const running = await dependencies.running();
        for (const { userId, request } of pending) {
          try {
            if (request.status === 'queued') {
              if (running.has(request.input.sourceSessionId) || !contextRequestsDb.update(request.id, { status: 'preparing' }, 'queued')) continue;
              const snapshot = await dependencies.prepare(userId, request.input.sourceSessionId);
              if (this.read(userId, request.id).status !== 'preparing') continue;
              await writeFile(path.join(folder(request.id), 'outline.json'), JSON.stringify(contextSnapshotService.outline(snapshot)), { mode: 0o600 });
              const connectionFile = path.join(folder(request.id), 'connection.json');
              const connection = JSON.parse(await readFile(connectionFile, 'utf8')) as { token: string };
              await writeFile(connectionFile, JSON.stringify({ ...connection, url: bridgeUrl(request.id) }), { mode: 0o600 });
              const command = `${quote(process.execPath)} ${quote(path.join(APP_ROOT, 'scripts/orbit-context.mjs'))} --connection ${quote(connectionFile)}`;
              const prompt = [
                `[Orbit context preparation ${request.id}]`,
                'Prepare a context transfer of this conversation as it stood before this preparation request. Use your understanding of the original task; this preparation is bookkeeping.',
                `Snapshot: ${snapshot.id}. Scope: ${request.input.scope}. Granularity: ${request.input.granularity}.`,
                `The complete turn index is at ${JSON.stringify(path.join(folder(request.id), 'outline.json'))}. Read it, then retrieve evidence as needed with the scoped CLI below.`,
                `CLI: ${command}`,
                `Read records: pass {"snapshotId":"${snapshot.id}","turn":<turn>} on stdin to the CLI's records operation. outline supports offset/limit.`,
                'For all_topics cover every indexed turn. For recent_topic identify the latest substantive objective, combine its follow-ups/resumptions, and include earlier dependency ranges with reasons; the latest turn belongs in focus.',
                'Author a cited briefing preserving user constraints, changed decisions, unresolved disagreements, observations and uncertainty. Fine handoff adds progress, artifacts, verification and actionable next steps.',
                'Create input: {snapshotId, scope: {kind:"all_topics"} OR {kind:"recent_topic",title,rationale,confidence:"high|medium|low",focus:[{from,to}],background:[{from,to,reason}]}, granularity:"coarse|fine", briefing:{author,topics:[{title,summary,turns:[numbers]}],items:[{kind,status,text,refs:["r1"]}]}}.',
                'Item kinds: goal,constraint,fact,decision,disagreement,progress,artifact,verification,open_question,next_step. Status: observed,reported,proposed,uncertain,superseded. Every selected turn belongs to a topic; every item cites selected records.',
                'Submit that JSON on stdin to the CLI create operation. Resolve validation errors using the returned details. Orbit handles the selected recipient and delivery. Finish with a short confirmation after create succeeds.',
                `Recipient instruction: ${request.input.instruction}`,
              ].join('\n\n');
              if (!contextRequestsDb.update(request.id, { snapshotId: snapshot.id, status: 'analyzing' }, 'preparing')) continue;
              sourceRuns.add(request.id); running.add(request.input.sourceSessionId);
              void dependencies.sourceTurn(userId, request, prompt).then(result => {
                const latest = contextRequestsDb.get(userId, request.id);
                if (latest?.status === 'analyzing') contextRequestsDb.update(request.id, result.started
                  ? { status: 'failed', error: result.error || '整理回合已结束，尚未收到上下文包。可重试，或在当前会话查看执行记录。' }
                  : { status: 'queued', error: null }, 'analyzing');
              }).catch(error => {
                contextRequestsDb.update(request.id, { status: 'failed', error: String(error) }, 'analyzing');
              }).finally(() => sourceRuns.delete(request.id));
            } else if (request.status === 'analyzing' && !sourceRuns.has(request.id) && !running.has(request.input.sourceSessionId)) {
              contextRequestsDb.update(request.id, { status: 'failed', error: '整理回合已经结束，尚未收到上下文包。可查看原会话后重试。' }, 'analyzing');
            } else if (request.status === 'ready') {
              if (request.input.mode === 'start' && request.input.target.kind === 'existing' && running.has(request.input.target.sessionId)) continue;
              if (!contextRequestsDb.update(request.id, { status: 'delivering' }, 'ready')) continue;
              let targetId = request.targetSessionId;
              if (!targetId) {
                if (request.input.target.kind === 'existing') targetId = request.input.target.sessionId;
                else {
                  const source = contextSnapshotService.source(userId, request.input.sourceSessionId);
                  targetId = sessionsService.createAppSession(request.input.target.provider, source.project_path!, `接续 · ${source.custom_name || '会话'}`).sessionId;
                  sessionsDb.setSessionModel(targetId, request.input.target.model);
                  if (request.input.target.effort) sessionsDb.setSessionEffort(targetId, request.input.target.effort);
                }
                contextRequestsDb.update(request.id, { targetSessionId: targetId });
                if (request.input.target.kind === 'new') await broadcastSessionUpserted(targetId);
              }
              const delivery = await dependencies.deliver(userId, request.packageId!, { targetSessionId: targetId, mode: request.input.mode, instruction: request.input.instruction, requestId: request.deliveryKey });
              contextRequestsDb.update(request.id, { deliveryId: delivery.id, status: ['failed', 'uncertain'].includes(delivery.status) ? 'failed' : 'completed', error: delivery.error });
            } else if (request.status === 'delivering') {
              const receipt = contextTransferDb.byRequest(userId, request.deliveryKey);
              contextRequestsDb.update(request.id, receipt ? { deliveryId: receipt.id, status: ['failed', 'uncertain', 'cancelled'].includes(receipt.status) ? 'failed' : 'completed', error: receipt.error }
                : { status: 'ready' }, 'delivering');
            }
          } catch (error) {
            const latest = contextRequestsDb.get(userId, request.id);
            if (latest && active.has(latest.status)) contextRequestsDb.update(request.id, error instanceof AppError && error.code === 'CONTEXT_TARGET_BUSY'
              ? { status: 'ready', error: null } : { status: 'failed', error: error instanceof Error ? error.message : String(error) });
          }
        }
      } finally { polling = false; }
    },
  };
  return service;
}

/** HTTP routes and the startup timer use the same source-agent preparation service. */
export const contextRequestService = createContextRequestService();
let timer: ReturnType<typeof setInterval> | undefined;
/** Server startup resumes queued slash-command requests after its provider gateway is ready. */
export function initializeContextRequests(): void {
  if (timer) return;
  contextRequestsDb.recover();
  const tick = () => void contextRequestService.tick().catch(error => console.error('[Context requests]', error));
  timer = setInterval(tick, 1500); timer.unref(); tick();
}
/** Server shutdown stops admitting new preparation turns. Native provider runs retain their normal lifecycle. */
export function closeContextRequests(): void { if (timer) clearInterval(timer); timer = undefined; }
