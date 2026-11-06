import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import { contextTransferDb, getDatabasePath, groupsDb, sessionsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import { AppError } from '@/shared/index.js';
import type { ContextRecord, ContextSnapshot, LLMProvider, NormalizedMessage } from '@/shared/index.js';

function normalize(messages: NormalizedMessage[]): ContextRecord[] {
  const records: ContextRecord[] = [];
  let turn = 0;
  let previousUserAnchor: string | undefined;
  for (const message of messages) {
    const content = message.content || message.text || message.displayText || '';
    const kind = message.isCompactSummary ? 'compaction' : message.kind === 'tool_use' ? 'tool'
      : message.kind === 'tool_result' ? 'tool_result' : message.kind === 'text' && message.role ? 'message' : null;
    if (!kind || (!content && kind === 'message' && !message.images && !message.files)) continue;
    // Multiple attachment/text blocks from one native user row share its anchor.
    if (kind === 'message' && message.role === 'user') {
      if (!message.transcriptAnchorId || message.transcriptAnchorId !== previousUserAnchor) turn++;
      previousUserAnchor = message.transcriptAnchorId;
    } else previousUserAnchor = undefined;
    records.push({ ref: `r${records.length + 1}`, turn, messageId: message.id,
      ...(message.transcriptAnchorId ? { anchorId: message.transcriptAnchorId } : {}),
      timestamp: message.timestamp, kind, ...(message.role ? { role: message.role } : {}), content,
      ...(message.toolName ? { toolName: message.toolName } : {}), ...(message.toolId ? { toolId: message.toolId } : {}),
      ...(message.toolInput !== undefined ? { input: message.toolInput } : {}),
      ...(message.toolResult !== undefined || message.toolUseResult !== undefined ? { result: message.toolResult ?? message.toolUseResult } : {}),
      ...(message.images || message.files ? { attachments: { images: message.images, files: message.files } } : {}),
      ...(message.isError || message.toolResult?.isError ? { isError: true } : {}),
    });
  }
  return records;
}

/** Context package creation and REST share a single-session snapshot reader with injectable history for tests. */
export function createContextSnapshotService(overrides: Partial<{
  history: typeof sessionsService.fetchHistory;
  running: (id: string) => boolean | Promise<boolean>;
}> = {}) {
  const dependencies = { history: sessionsService.fetchHistory.bind(sessionsService),
    running: async (id: string) => (await sessionsService.listRunningSessions()).some(entry => entry.sessionId === id), ...overrides };
  return {
    source(userId: number, sessionId: string) {
      const source = sessionsDb.getSessionById(sessionId);
      if (!source) throw new AppError('Source session was not found.', { code: 'SESSION_NOT_FOUND', statusCode: 404 });
      const membership = groupsDb.membership(sessionId);
      if (membership && groupsDb.get(membership.groupId)?.userId !== userId) throw new AppError('Source session was not found.', { code: 'SESSION_NOT_FOUND', statusCode: 404 });
      return source;
    },
    async prepare(userId: number, sessionId: string): Promise<ContextSnapshot> {
      const source = this.source(userId, sessionId);
      const runningBefore = await dependencies.running(sessionId);
      const history = await dependencies.history(sessionId, { limit: null, offset: 0 });
      const sourceWasRunning = runningBefore || await dependencies.running(sessionId);
      const current = this.source(userId, sessionId);
      if (current.provider_session_id !== source.provider_session_id) throw new AppError('The source session changed branches during capture. Prepare again.', { code: 'CONTEXT_SOURCE_CHANGED', statusCode: 409 });
      const records = normalize(history.messages);
      if (!records.length) throw new AppError('This session has no persisted context yet.', { code: 'CONTEXT_EMPTY', statusCode: 409 });
      const limitations = ['Source records use the provider-normalized transcript. Tool output and attachment contents retain the provider reader’s available detail.'];
      if (sourceWasRunning) limitations.push('The source was working during capture. This snapshot includes persisted records at capture time; later output belongs to a new snapshot.');
      if (records.some(record => record.kind === 'compaction')) limitations.push('Compaction summaries are labeled as summaries; earlier details may be available only through those summaries.');
      const serialized = JSON.stringify(records);
      if (Buffer.byteLength(serialized) > 32 * 1024 * 1024) throw new AppError('The normalized snapshot exceeds the 32 MB capture limit.', { code: 'CONTEXT_TOO_LARGE', statusCode: 413 });
      const snapshot: ContextSnapshot = { id: randomUUID(), sourceSessionId: sessionId, provider: source.provider as LLMProvider,
        projectPath: source.project_path, title: source.custom_name || 'Session context', createdAt: new Date().toISOString(),
        fingerprint: createHash('sha256').update(serialized).digest('hex'), sourceWasRunning, records, limitations };
      contextTransferDb.saveSnapshot(userId, snapshot);
      return snapshot;
    },
    read(userId: number, id: string): ContextSnapshot {
      const snapshot = contextTransferDb.snapshot(userId, id);
      if (!snapshot) throw new AppError('Context snapshot was not found.', { code: 'CONTEXT_NOT_FOUND', statusCode: 404 });
      return snapshot;
    },
    async remove(userId: number, id: string): Promise<void> {
      this.read(userId, id);
      const packages = contextTransferDb.removeSnapshot(userId, id);
      if (packages === null) throw new AppError('A context delivery is being submitted. Inspect its receipt before deleting the snapshot.', { code: 'CONTEXT_DELIVERY_STARTED', statusCode: 409 });
      for (const packageId of packages) await rm(path.join(path.dirname(getDatabasePath()), 'context-packages', packageId), { recursive: true, force: true });
    },
    outline(snapshot: ContextSnapshot) {
      const turns = new Map<number, { turn: number; firstRef: string; lastRef: string; request: string; response: string; records: number; excerpted: boolean }>();
      for (const record of snapshot.records) {
        const entry = turns.get(record.turn) || { turn: record.turn, firstRef: record.ref, lastRef: record.ref, request: '', response: '', records: 0, excerpted: false };
        entry.lastRef = record.ref; entry.records++;
        if (record.kind === 'message' && record.role === 'user') entry.request += `${entry.request ? '\n' : ''}${record.content}`;
        if (record.kind === 'message' && record.role === 'assistant') entry.response = record.content;
        turns.set(record.turn, entry);
      }
      return [...turns.values()].map(entry => ({ ...entry, excerpted: entry.request.length > 1200 || entry.response.length > 600, request: entry.request.slice(0, 1200), response: entry.response.slice(0, 600) }));
    },
  };
}

/** Used by context REST, package validation and delivery to resolve owned source snapshots. */
export const contextSnapshotService = createContextSnapshotService();
