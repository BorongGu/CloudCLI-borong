import { groupsDb } from '@/modules/database/index.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import { groupsService } from '@/modules/groups/services/groups.service.js';
import type { GroupMember, ProviderRuntimeWriter } from '@/shared/index.js';

let timer: ReturnType<typeof setInterval> | undefined;

async function deliver(member: GroupMember, runtime: ProviderRuntimeGateway): Promise<void> {
  if (chatRunRegistry.isProcessing(member.sessionId) || runtime.hasBackgroundWork(member.sessionId)) return;
  const messages = groupsDb.claim(member.id);
  if (!messages.length) return;
  let runStarted = false;
  let sawCompletion = false;
  let terminalError: string | null = null;
  try {
    const prompt = groupsService.prompt(member, messages);
    const observedRuntime: ProviderRuntimeGateway = {
      ...runtime,
      run(provider, command, options, writer) {
        runStarted = true;
        const observedWriter = new Proxy(writer, {
          get(target, key) {
            if (key === 'send') return (data: unknown) => {
              const event = data as { kind?: string; exitCode?: number; aborted?: boolean } | null;
              if (event?.kind === 'complete') sawCompletion = true;
              if (event?.kind === 'complete' && (event.aborted || (typeof event.exitCode === 'number' && event.exitCode !== 0))) {
                terminalError = event.aborted ? 'Turn was stopped; inspect the member session.' : `Provider exited with code ${event.exitCode}.`;
              }
              target.send(data);
            };
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }) as ProviderRuntimeWriter;
        return runtime.run(provider, command, options, observedWriter);
      },
    };
    const result = await runDetachedChatTurn({
      sessionId: member.sessionId, userId: groupsDb.get(member.groupId)!.userId,
      content: prompt.content, options: { ...(member.model ? { model: member.model } : {}), permissionMode: member.permissionMode },
    }, { runtime: observedRuntime });
    if (!result.started && chatRunRegistry.isProcessing(member.sessionId)) {
      groupsDb.settle(member, messages, 'queued', null);
      return;
    }
    const error = result.error || terminalError || (runStarted && !sawCompletion ? 'Provider ended without a completion event; inspect the member session.' : null);
    groupsDb.settle(member, messages, result.started && !error ? 'completed' : 'failed', error,
      runStarted && !error ? prompt.seenSeq : undefined);
  } catch (error) {
    groupsDb.settle(member, messages, 'failed', error instanceof Error ? error.message : String(error));
  }
}

/** Used by Groups tests and the lifecycle timer; claims prevent duplicate concurrent dispatches. */
export async function dispatchGroupMessages(runtime: ProviderRuntimeGateway): Promise<void> {
  await Promise.all(groupsDb.candidates().map(member => deliver(member, runtime)));
}

/** Called by server startup after the database and provider runtime are ready. */
export function initializeGroupDispatcher(runtime: ProviderRuntimeGateway): void {
  if (timer) return;
  groupsDb.recover();
  const poll = () => void dispatchGroupMessages(runtime).catch(error => console.error('[Groups] Dispatch failed', error));
  timer = setInterval(poll, 1000);
  timer.unref();
  poll();
}

/** Called by server shutdown to stop scheduling new group turns. */
export function closeGroupDispatcher(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
