import type { CodexGoal, CodexGoalCommand, CodexRpcConnection } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/** Used by the Codex runtime to recognize native commands before model submission. */
export function parseCodexGoalCommand(input: string): CodexGoalCommand | null {
  if (!/^\/goal(?:\s|$)/.test(input)) return null;
  const argument = input.slice(5).trim();
  if (!argument) return { action: 'get' };
  if (argument === 'pause' || argument === 'resume' || argument === 'clear') return { action: argument };
  if (argument.length > 4000) throw new AppError('Goal objective must contain at most 4000 characters.', { statusCode: 400, code: 'INVALID_GOAL' });
  return { action: 'set', objective: argument };
}

/** Used by the goal API and streamed runtime to operate on Codex's persisted goal. */
export async function executeCodexGoal(
  client: CodexRpcConnection, threadId: string, command: CodexGoalCommand,
): Promise<CodexGoal | null> {
  if (command.action === 'get') return (await client.call('thread/goal/get', { threadId })).goal;
  if (command.action === 'clear') {
    await client.call('thread/goal/clear', { threadId }); return null;
  }
  const result = await client.call('thread/goal/set', {
    threadId,
    ...(command.action === 'set' ? { objective: command.objective } : {}),
    status: command.action === 'pause' ? 'paused' : 'active',
  });
  return result.goal;
}
