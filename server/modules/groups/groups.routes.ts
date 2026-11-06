import express from 'express';
import type { Request } from 'express';

import { groupsService } from '@/modules/groups/services/groups.service.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/index.js';
import type { GroupMember, GroupMessageInput, LLMProvider } from '@/shared/index.js';

function invalid(field: string): never {
  throw new AppError(`Invalid ${field}.`, { code: 'INVALID_GROUP_INPUT', statusCode: 400 });
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('object');
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, max = 16_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) invalid(field);
  return value.trim();
}

function optional(value: unknown, field: string, max = 200): string | undefined {
  return value === undefined || value === '' ? undefined : text(value, field, max);
}

function integer(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid(field);
  return value;
}

function userId(req: Request): number {
  const id = Number((req as Request & { user?: { id?: number | string } }).user?.id);
  if (!Number.isSafeInteger(id) || id < 1) throw new AppError('Authenticated user is required.', { code: 'USER_REQUIRED', statusCode: 401 });
  return id;
}

function message(body: Record<string, unknown>): GroupMessageInput {
  if (!['send', 'publish', 'request', 'reply'].includes(String(body.kind))) invalid('kind');
  return {
    kind: body.kind as GroupMessageInput['kind'], content: text(body.content, 'content'),
    requestId: text(body.requestId, 'requestId', 128), to: optional(body.to, 'to'),
    title: optional(body.title, 'title'), replyTo: optional(body.replyTo, 'replyTo'),
  };
}

/** Mounted by server/index.ts behind the normal Orbit user authentication. */
export const groupsRoutes = express.Router();

groupsRoutes.get('/', asyncHandler(async (req, res) => {
  res.json(createApiSuccessResponse(groupsService.list(userId(req))));
}));

groupsRoutes.post('/', asyncHandler(async (req, res) => {
  const body = record(req.body);
  if (!Array.isArray(body.members) || body.members.length < 2 || body.members.length > 5) invalid('members (2–5)');
  const members = body.members.map(value => {
    const member = record(value);
    if (!['claude', 'codex', 'cursor', 'opencode'].includes(String(member.provider))) invalid('provider');
    const permissionMode = member.permissionMode ?? 'default';
    if (!['default', 'acceptEdits', 'bypassPermissions'].includes(String(permissionMode))) invalid('permissionMode');
    return { name: text(member.name, 'member name', 48), provider: member.provider as LLMProvider, model: optional(member.model, 'model'), permissionMode: permissionMode as GroupMember['permissionMode'] };
  });
  res.status(201).json(createApiSuccessResponse(groupsService.create(userId(req), {
    name: text(body.name, 'name', 100), projectPath: text(body.projectPath, 'projectPath', 4096), members,
  })));
}));

groupsRoutes.get('/:id', asyncHandler(async (req, res) => {
  res.json(createApiSuccessResponse(groupsService.snapshot(userId(req), text(req.params.id, 'group id', 128))));
}));

groupsRoutes.get('/:id/messages', asyncHandler(async (req, res) => {
  const id = text(req.params.id, 'group id', 128);
  groupsService.owned(userId(req), id);
  res.json(createApiSuccessResponse(groupsService.read(id, undefined, integer(Number(req.query.after ?? 0), 'after', 0, Number.MAX_SAFE_INTEGER), req.query.publishedOnly === 'true')));
}));

groupsRoutes.post('/:id/messages', asyncHandler(async (req, res) => {
  const id = text(req.params.id, 'group id', 128);
  groupsService.owned(userId(req), id);
  res.status(201).json(createApiSuccessResponse(groupsService.post(id, null, message(record(req.body)))));
}));

groupsRoutes.post('/:id/dispatch', asyncHandler(async (req, res) => {
  const body = record(req.body);
  const assignments = Object.fromEntries(Object.entries(record(body.assignments ?? {})).map(([id, value]) => [
    text(id, 'assignment member id', 128), value === '' ? '' : text(value, 'assignment', 8000),
  ]));
  res.status(201).json(createApiSuccessResponse(groupsService.dispatch(
    userId(req), text(req.params.id, 'group id', 128), text(body.content, 'content'), assignments,
    integer(body.turns ?? 20, 'turns', 2, 1000), text(body.requestId, 'requestId', 128),
  )));
}));

groupsRoutes.patch('/:id', asyncHandler(async (req, res) => {
  const body = record(req.body);
  if (typeof body.paused !== 'boolean') invalid('paused');
  if (body.retry !== undefined && typeof body.retry !== 'boolean') invalid('retry');
  res.json(createApiSuccessResponse(groupsService.control(userId(req), text(req.params.id, 'group id', 128),
    body.paused, body.turns === undefined ? undefined : integer(body.turns, 'turns', 0, 1000), body.retry === true)));
}));

/** Scoped member bridge used by the local CLI; member credentials determine identity and group. */
export const groupBridgeRoutes = express.Router();

groupBridgeRoutes.post('/:operation', asyncHandler(async (req, res) => {
  const token = /^Bearer (\S+)$/i.exec(req.headers.authorization || '')?.[1] || '';
  const member = groupsService.authenticate(token);
  const body = record(req.body);
  const operation = text(req.params.operation, 'operation', 32);
  if (operation === 'read') {
    if (body.publishedOnly !== undefined && typeof body.publishedOnly !== 'boolean') invalid('publishedOnly');
    res.json(createApiSuccessResponse(groupsService.read(member.groupId, member.id,
      integer(body.after ?? 0, 'after', 0, Number.MAX_SAFE_INTEGER), body.publishedOnly === true)));
    return;
  }
  res.json(createApiSuccessResponse(groupsService.post(member.groupId, member.id, message({ ...body, kind: operation }))));
}));
