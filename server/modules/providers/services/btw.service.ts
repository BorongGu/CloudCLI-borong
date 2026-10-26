import { sessionsDb } from '@/modules/database/index.js';
import { createCodexBtwSession } from '@/modules/providers/services/codex-btw.service.js';
import { createOpenCodeBtwSession } from '@/modules/providers/services/opencode-btw.service.js';
import type { BtwEvent, BtwInput, BtwSession } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/** The websocket gateway uses the source session's provider to select its temporary conversation adapter. */
export function createBtwSession(input: BtwInput, emit: (event: BtwEvent) => void, dependencies = {
  lookup: (id: string) => sessionsDb.getSessionById(id),
  codex: createCodexBtwSession,
  opencode: createOpenCodeBtwSession,
}): BtwSession {
  const source = dependencies.lookup(input.sessionId);
  if (!source) throw new AppError('Source conversation was not found.', { statusCode: 404, code: 'SESSION_NOT_FOUND' });
  if (source.provider === 'codex') return dependencies.codex(input, emit);
  if (source.provider === 'opencode') return dependencies.opencode(input, emit);
  throw new AppError('Open a Codex or OpenCode conversation before using /btw.', { statusCode: 400, code: 'BTW_SOURCE_REQUIRED' });
}
