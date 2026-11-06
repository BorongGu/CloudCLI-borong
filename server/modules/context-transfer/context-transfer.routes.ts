import express from 'express';
import type { Request } from 'express';

import { authenticateToken } from '@/modules/auth/index.js';
import { apiKeysDb, contextRequestsDb } from '@/modules/database/index.js';
import { contextSnapshotService } from '@/modules/context-transfer/services/context-snapshot.service.js';
import { contextPackageService } from '@/modules/context-transfer/services/context-package.service.js';
import { contextDeliveryService } from '@/modules/context-transfer/services/context-delivery.service.js';
import { contextRequestService } from '@/modules/context-transfer/services/context-request.service.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/index.js';
import type { ContextBriefing, ContextDelivery, ContextPackageInput, ContextRequestInput, ContextScope } from '@/shared/index.js';

function invalid(field: string): never { throw new AppError(`Invalid ${field}.`, { code: 'INVALID_CONTEXT_INPUT', statusCode: 400 }); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('object');
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string, max = 128): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) invalid(field);
  return value.trim();
}
function integer(value: unknown, field: string, min = 0, max = 100_000): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid(field);
  return value;
}
function list(value: unknown, field: string, max = 200): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid(field);
  return value;
}
function choice<T extends string>(value: unknown, field: string, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) invalid(field);
  return value as T;
}
function owner(req: Request): number {
  return integer(Number((req as Request & { user?: { id?: number } }).user?.id), 'authenticated user', 1, Number.MAX_SAFE_INTEGER);
}
function packageInput(value: unknown): ContextPackageInput {
  const body = object(value);
  const source = object(body.scope);
  const kind = choice(source.kind, 'scope.kind', ['all_topics', 'recent_topic']);
  let scope: ContextScope = { kind: 'all_topics' };
  if (kind === 'recent_topic') {
    const range = (value: unknown) => { const item = object(value); return { from: integer(item.from, 'range.from'), to: integer(item.to, 'range.to') }; };
    scope = { kind, title: text(source.title, 'scope.title', 500), rationale: text(source.rationale, 'scope.rationale', 8000),
      confidence: choice(source.confidence, 'scope.confidence', ['high', 'medium', 'low']),
      focus: list(source.focus, 'focus', 100).map(range),
      background: list(source.background ?? [], 'background', 100).map(value => ({ ...range(value), reason: text(object(value).reason, 'background reason', 2000) })) };
    if (!scope.focus.length) invalid('focus');
  }
  const brief = object(body.briefing);
  const briefing: ContextBriefing = {
    author: text(brief.author, 'briefing.author', 200),
    topics: list(brief.topics, 'briefing.topics').map(value => { const item = object(value); return {
      title: text(item.title, 'topic.title', 500), summary: text(item.summary, 'topic.summary', 8000),
      turns: list(item.turns, 'topic.turns', 100_000).map(value => integer(value, 'topic.turn')),
    }; }),
    items: list(brief.items, 'briefing.items', 500).map(value => { const item = object(value); return {
      kind: choice(item.kind, 'item.kind', ['goal', 'constraint', 'fact', 'decision', 'disagreement', 'progress', 'artifact', 'verification', 'open_question', 'next_step']),
      status: choice(item.status, 'item.status', ['observed', 'reported', 'proposed', 'uncertain', 'superseded']),
      text: text(item.text, 'item.text', 8000), refs: list(item.refs, 'item.refs', 200).map(ref => text(ref, 'reference')),
    }; }),
  };
  if (!briefing.topics.length || !briefing.items.length) invalid('briefing coverage');
  return { snapshotId: text(body.snapshotId, 'snapshotId'), scope, briefing,
    granularity: choice(body.granularity, 'granularity', ['coarse', 'fine']), maxChars: integer(body.maxChars ?? (body.granularity === 'fine' ? 64_000 : 16_000), 'maxChars', 4000, 160_000) };
}
function page<T>(entries: T[], req: Request) {
  const offset = integer(Number(req.query.offset ?? 0), 'offset');
  const limit = integer(Number(req.query.limit ?? 50), 'limit', 1, 200);
  return { items: entries.slice(offset, offset + limit), total: entries.length, offset, limit, hasMore: offset + limit < entries.length };
}

function requestInput(value: unknown): ContextRequestInput {
  const body = object(value), target = object(body.target);
  const targetKind = choice(target.kind, 'target.kind', ['existing', 'new']);
  const optional = (value: unknown, name: string) => value === undefined ? undefined : text(value, name, 200);
  return { sourceSessionId: text(body.sourceSessionId, 'sourceSessionId'), requestId: text(body.requestId, 'requestId'),
    scope: choice(body.scope, 'scope', ['all_topics', 'recent_topic']), granularity: choice(body.granularity, 'granularity', ['coarse', 'fine']),
    instruction: text(body.instruction, 'instruction', 16000), mode: choice(body.mode, 'mode', ['attach', 'start', 'steer']),
    sourceModel: optional(body.sourceModel, 'sourceModel'), sourceEffort: optional(body.sourceEffort, 'sourceEffort'),
    permissionMode: choice(body.permissionMode ?? 'default', 'permissionMode', ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'plan']),
    target: targetKind === 'existing' ? { kind: 'existing', sessionId: text(target.sessionId, 'target.sessionId') }
      : { kind: 'new', provider: choice(target.provider, 'target.provider', ['claude', 'codex', 'opencode', 'cursor']), model: text(target.model, 'target.model', 200), effort: optional(target.effort, 'target.effort') },
  };
}

/** Mounted by server/index; browser JWT and existing Orbit API keys share the same owned transfer resources. */
export const contextTransferRoutes = express.Router();
contextTransferRoutes.use((req, res, next) => {
  const key = req.headers['x-api-key'];
  if (key !== undefined) {
    const user = typeof key === 'string' ? apiKeysDb.validateApiKey(key) : undefined;
    if (!user) { res.status(401).json({ error: 'Invalid API key.' }); return; }
    Object.assign(req, { user }); next(); return;
  }
  void authenticateToken(req, res, next);
});
contextTransferRoutes.post('/requests', asyncHandler(async (req, res) => {
  const request = await contextRequestService.create(owner(req), requestInput(req.body));
  res.status(202).json(createApiSuccessResponse(contextRequestService.view(owner(req), request.id)));
}));
contextTransferRoutes.get('/requests', asyncHandler(async (req, res) => {
  const request = contextRequestsDb.latest(owner(req), text(req.query.sourceSessionId, 'sourceSessionId'));
  res.json(createApiSuccessResponse(request ? contextRequestService.view(owner(req), request.id) : null));
}));
contextTransferRoutes.get('/requests/:id', asyncHandler(async (req, res) => {
  res.json(createApiSuccessResponse(contextRequestService.view(owner(req), text(req.params.id, 'requestId'))));
}));
contextTransferRoutes.delete('/requests/:id', asyncHandler(async (req, res) => {
  res.json(createApiSuccessResponse(contextRequestService.cancel(owner(req), text(req.params.id, 'requestId'))));
}));
contextTransferRoutes.post('/requests/:id/retry', asyncHandler(async (req, res) => {
  res.json(createApiSuccessResponse(await contextRequestService.retry(owner(req), text(req.params.id, 'requestId'))));
}));
contextTransferRoutes.post('/prepare', asyncHandler(async (req, res) => {
  const snapshot = await contextSnapshotService.prepare(owner(req), text(object(req.body).sessionId, 'sessionId'));
  const { records, ...metadata } = snapshot;
  res.status(201).json(createApiSuccessResponse({ ...metadata, recordCount: records.length, lastTurn: records.at(-1)?.turn,
    outline: page(contextSnapshotService.outline(snapshot), req),
    synthesisInstructions: 'Read the complete turn index and relevant records. For all_topics cover every turn of THIS session. For recent_topic identify the latest substantive objective, merge its follow-ups and resumptions, and select non-contiguous focus ranges plus earlier dependency ranges with reasons. Preserve revised decisions, unresolved disagreements and user constraints. Author a cited briefing; mark reported claims, observations, proposals, uncertainty and superseded decisions distinctly. Fine handoff should include current progress, artifacts, checks, pending work and next steps when supported by evidence. Use snapshot refs, then POST /packages. Scope and granularity are independent.',
    packageExample: { snapshotId: snapshot.id, scope: { kind: 'all_topics' }, granularity: 'coarse', briefing: { author: 'source agent', topics: [{ title: 'Topic', summary: 'What this topic established', turns: [records[0].turn] }], items: [{ kind: 'goal', status: 'reported', text: 'Cited objective', refs: [records[0].ref] }] } },
  }));
}));
contextTransferRoutes.get('/snapshots/:id/outline', asyncHandler(async (req, res) => {
  res.json(createApiSuccessResponse(page(contextSnapshotService.outline(contextSnapshotService.read(owner(req), text(req.params.id, 'snapshotId'))), req)));
}));
contextTransferRoutes.delete('/snapshots/:id', asyncHandler(async (req, res) => {
  await contextSnapshotService.remove(owner(req), text(req.params.id, 'snapshotId'));
  res.json(createApiSuccessResponse({ deleted: true }));
}));
contextTransferRoutes.get('/snapshots/:id/records', asyncHandler(async (req, res) => {
  let records = contextSnapshotService.read(owner(req), text(req.params.id, 'snapshotId')).records;
  if (req.query.turn !== undefined) records = records.filter(record => record.turn === integer(Number(req.query.turn), 'turn'));
  if (req.query.ref !== undefined) records = records.filter(record => record.ref === text(req.query.ref, 'ref'));
  res.json(createApiSuccessResponse(page(records, req)));
}));
contextTransferRoutes.post('/packages', asyncHandler(async (req, res) => {
  res.status(201).json(createApiSuccessResponse(await contextPackageService.create(owner(req), packageInput(req.body))));
}));
contextTransferRoutes.get('/packages/:id', asyncHandler(async (req, res) => {
  res.json(createApiSuccessResponse(contextPackageService.read(owner(req), text(req.params.id, 'packageId'))));
}));
contextTransferRoutes.get('/packages/:id/records', asyncHandler(async (req, res) => {
  const records = contextPackageService.records(owner(req), text(req.params.id, 'packageId'));
  res.json(createApiSuccessResponse(page(req.query.ref === undefined ? records : records.filter(record => record.ref === text(req.query.ref, 'ref')), req)));
}));
contextTransferRoutes.post('/packages/:id/deliver', asyncHandler(async (req, res) => {
  const body = object(req.body);
  res.status(202).json(createApiSuccessResponse(await contextDeliveryService.deliver(owner(req), text(req.params.id, 'packageId'), {
    targetSessionId: text(body.targetSessionId, 'targetSessionId'), requestId: text(body.requestId, 'requestId'),
    mode: choice<ContextDelivery['mode']>(body.mode ?? 'attach', 'mode', ['attach', 'start', 'steer']), instruction: text(body.instruction, 'instruction', 16_000),
  })));
}));
contextTransferRoutes.get('/deliveries/:id', asyncHandler(async (req, res) => {
  res.json(createApiSuccessResponse(contextDeliveryService.read(owner(req), text(req.params.id, 'deliveryId'))));
}));
contextTransferRoutes.delete('/deliveries/:id', asyncHandler(async (req, res) => {
  res.json(createApiSuccessResponse(contextDeliveryService.cancel(owner(req), text(req.params.id, 'deliveryId'))));
}));

/** The current source agent receives a short-lived capability scoped to this snapshot and package creation. */
export const contextBridgeRoutes = express.Router();
contextBridgeRoutes.use('/:requestId', (req, res, next) => {
  try {
    const token = /^Bearer (\S+)$/i.exec(req.headers.authorization || '')?.[1] || '';
    res.locals.contextRequest = contextRequestService.authenticate(text(req.params.requestId, 'requestId'), token);
    next();
  } catch (error) { next(error); }
});
contextBridgeRoutes.get('/:requestId/snapshots/:id/:operation', asyncHandler(async (req, res) => {
  const { userId, request } = res.locals.contextRequest as { userId: number; request: ReturnType<typeof contextRequestService.read> };
  if (req.params.id !== request.snapshotId) throw new AppError('Snapshot is outside this request.', { statusCode: 403, code: 'CONTEXT_SCOPE' });
  const snapshot = contextSnapshotService.read(userId, req.params.id);
  if (req.params.operation === 'outline') res.json(createApiSuccessResponse(page(contextSnapshotService.outline(snapshot), req)));
  else if (req.params.operation === 'records') {
    let records = snapshot.records;
    if (req.query.turn !== undefined) records = records.filter(record => record.turn === integer(Number(req.query.turn), 'turn'));
    if (req.query.ref !== undefined) records = records.filter(record => record.ref === text(req.query.ref, 'ref'));
    res.json(createApiSuccessResponse(page(records, req)));
  } else invalid('operation');
}));
contextBridgeRoutes.post('/:requestId/packages', asyncHandler(async (req, res) => {
  const { userId, request } = res.locals.contextRequest as { userId: number; request: ReturnType<typeof contextRequestService.read> };
  const value = await contextRequestService.completePackage(userId, request.id, packageInput(req.body));
  res.status(201).json(createApiSuccessResponse({ id: value.id, snapshotId: value.snapshotId, selectedRecords: value.selectedRefs.length, status: 'prepared' }));
}));
