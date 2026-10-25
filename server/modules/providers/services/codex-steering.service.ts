import { sessionsDb } from '@/modules/database/index.js';
import { sharedCodexConnection } from '@/modules/providers/list/codex/codex-shared-connection.js';
import { appendFilesInputTag, buildCodexInputItems, filterAttachmentsToUploadStore, isImageAttachmentDescriptor } from '@/shared/image-attachments.js';
import type { CodexRpcConnection } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/** Provider routes use this service to append input to the daemon's current turn. */
export function createCodexSteeringService(
  client: CodexRpcConnection = sharedCodexConnection,
  lookup: typeof sessionsDb.getSessionById = id => sessionsDb.getSessionById(id),
) {
  return {
    async steer(sessionId: string, content: string, attachments: unknown = []) {
      const session = lookup(sessionId);
      if (!session) throw new AppError('Session was not found.', { statusCode: 404, code: 'SESSION_NOT_FOUND' });
      if (session.provider !== 'codex') throw new AppError('Mid-turn input requires a Codex session.', { statusCode: 400, code: 'CODEX_PROVIDER_REQUIRED' });
      const noTurn = () => new AppError('The previous turn has finished. Queue the message for the next turn.', { statusCode: 409, code: 'CODEX_NO_ACTIVE_TURN' });
      if (!session.provider_session_id) throw noTurn();
      const threadId = session.provider_session_id;
      const latest = await client.call('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
      const turn = latest.data?.find((candidate: { status: string }) => candidate.status === 'inProgress');
      if (!turn) throw noTurn();
      const verified = filterAttachmentsToUploadStore(attachments);
      const files = verified.filter(file => !isImageAttachmentDescriptor(file));
      const images = verified.filter(isImageAttachmentDescriptor);
      const prompt = appendFilesInputTag(content, files);
      if (!prompt.trim() && images.length === 0) throw new AppError('Enter a message or attach a file.', { statusCode: 400, code: 'EMPTY_INPUT' });
      const input = buildCodexInputItems(prompt || 'Please analyze the attached image(s).', images, session.project_path || undefined)
        .map(item => item.type === 'local_image' ? { ...item, type: 'localImage' } : item);
      try {
        const result = await client.call('turn/steer', { threadId, expectedTurnId: turn.id, input });
        return { turnId: result.turnId };
      } catch (error) {
        // Only an explicit turn precondition permits a durable retry. A timed-out input may already be accepted.
        if (/no active turn|expected.*turn|turn.*mismatch|not.*in.progress/i.test(String(error))) throw noTurn();
        throw error;
      }
    },
  };
}

/** Session routes share the live Codex connection with the stream observer. */
export const codexSteeringService = createCodexSteeringService();
