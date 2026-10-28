import { sharedCodexConnection } from '@/modules/providers/list/codex/codex-shared-connection.js';
import type { CodexRpcConnection, NativeSessionActivity } from '@/shared/types.js';

/** The Codex runtime uses native liveness for the sidebar poll and reconnect recovery. */
export function createCodexActivityService(client: CodexRpcConnection = sharedCodexConnection) {
  // Coalesce concurrent browser polls while keeping every completed read current.
  let reading: Promise<NativeSessionActivity[]> | null = null;
  const read = async (): Promise<NativeSessionActivity[]> => {
    try {
      const ids = new Set<string>();let cursor: string | undefined;
      do {
        const page = await client.call('thread/loaded/list', { limit: 100, ...(cursor ? { cursor } : {}) });
        for (const id of page.data || []) if (typeof id === 'string') ids.add(id);
        const next = page.nextCursor;
        if (next === cursor) break;
        cursor = next || undefined;
      } while (cursor);
      const results = await Promise.allSettled([...ids].map(async (threadId): Promise<NativeSessionActivity | null> => {
        const { thread } = await client.call('thread/read', { threadId, includeTurns: false });
        if (thread?.status?.type !== 'active' || thread.ephemeral) return null;
        const latest = await client.call('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
        const start = latest.data?.[0]?.startedAt ?? thread.updatedAt;
        return { providerSessionId: threadId, startedAt: typeof start === 'number' && start > 0 ? start * 1000 : Date.now() };
      }));
      return results.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : []);
    } catch { return []; }
  };
  return {
    listRunningSessions(): Promise<NativeSessionActivity[]> {
      reading ??= read().finally(() => { reading = null; });
      return reading;
    },
  };
}

/** Shared by the Codex runtime's status readers without owning or interrupting native turns. */
export const codexActivityService = createCodexActivityService();
