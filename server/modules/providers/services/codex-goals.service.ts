import { sessionsDb } from '@/modules/database/index.js';
import { executeCodexGoal } from '@/modules/providers/list/codex/codex-goals.provider.js';
import { sharedCodexConnection } from '@/modules/providers/list/codex/codex-shared-connection.js';
import type { CodexGoalCommand, CodexRpcConnection } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/** Used by provider routes and websocket reconnects; resolves app ids before native goal calls. */
export function createCodexGoalsService(
  client: CodexRpcConnection = sharedCodexConnection,
  lookup: typeof sessionsDb.getSessionById = id => sessionsDb.getSessionById(id),
) {
  return {
    async execute(sessionId: string, command: CodexGoalCommand) {
      const session = lookup(sessionId);
      if (!session) throw new AppError('Session was not found.', { statusCode: 404, code: 'SESSION_NOT_FOUND' });
      if (session.provider !== 'codex') throw new AppError('Goals are available for Codex sessions.', { statusCode: 400, code: 'GOAL_PROVIDER_REQUIRED' });
      if (!session.provider_session_id) {
        if (command.action === 'get' || command.action === 'clear') return { goal: null };
        throw new AppError('Start the goal from the chat composer.', { statusCode: 409, code: 'GOAL_THREAD_REQUIRED' });
      }
      const goal = await executeCodexGoal(client, session.provider_session_id, command);
      if (command.action === 'pause') {
        // Pause scheduling first, then stop the current turn so the button
        // also pauses work already in flight. Usage stays on the native goal.
        const turns = await client.call('thread/turns/list', {
          threadId: session.provider_session_id, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded',
        });
        const running = turns.data?.find((turn: { status: string }) => turn.status === 'inProgress');
        if (running) {
          try {
            await client.call('turn/interrupt', { threadId: session.provider_session_id, turnId: running.id });
          } catch (error) {
            // The turn may finish between the list and interrupt requests.
            if (!/no active turn|not.*in.progress|already.*(?:completed|finished)/i.test(String(error))) throw error;
          }
        }
      }
      return { goal };
    },
  };
}

/** Provider routes and websocket reconnects share the native Codex goal service. */
export const codexGoalsService = createCodexGoalsService();
