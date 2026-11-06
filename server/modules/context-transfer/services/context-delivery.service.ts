import { randomUUID } from 'node:crypto';

import { contextTransferDb, groupsDb, sessionsDb } from '@/modules/database/index.js';
import { providerRuntimeService, sessionsService } from '@/modules/providers/index.js';
import { runDetachedChatTurn } from '@/modules/websocket/index.js';
import { contextPackageService } from '@/modules/context-transfer/services/context-package.service.js';
import { AppError } from '@/shared/index.js';
import type { ContextDelivery, LLMProvider } from '@/shared/index.js';

/** Context REST uses this delivery boundary; tests replace native calls without starting paid model turns. */
export function createContextDeliveryService(overrides: Partial<{
  steer: typeof providerRuntimeService.steer;
  running: (sessionId: string) => Promise<boolean>;
  start: (userId: number, sessionId: string, instruction: string) => Promise<{ started: boolean; error: string | null }>;
}> = {}) {
  const dependencies = {
    steer: providerRuntimeService.steer.bind(providerRuntimeService),
    running: async (sessionId: string) => (await sessionsService.listRunningSessions()).some(entry => entry.sessionId === sessionId),
    start: (userId: number, sessionId: string, instruction: string) => runDetachedChatTurn({ userId, sessionId, content: instruction }, { runtime: providerRuntimeService }),
    ...overrides,
  };
  return {
    read(userId: number, id: string): ContextDelivery {
      const delivery = contextTransferDb.delivery(userId, id);
      if (!delivery) throw new AppError('Context delivery was not found.', { code: 'CONTEXT_NOT_FOUND', statusCode: 404 });
      return delivery;
    },
    async deliver(userId: number, packageId: string, input: { targetSessionId: string; requestId: string; mode: ContextDelivery['mode']; instruction: string }): Promise<ContextDelivery> {
      const value = contextPackageService.read(userId, packageId);
      const target = sessionsDb.getSessionById(input.targetSessionId);
      if (!target) throw new AppError('Target session was not found.', { code: 'SESSION_NOT_FOUND', statusCode: 404 });
      if (groupsDb.membership(input.targetSessionId)) throw new AppError('Choose an ordinary session. Group member input is managed through its public discussion.', { code: 'CONTEXT_GROUP_TARGET', statusCode: 409 });
      const existing = contextTransferDb.byRequest(userId, input.requestId);
      if (existing) {
        if (existing.packageId !== packageId || existing.targetSessionId !== input.targetSessionId || existing.mode !== input.mode || existing.instruction !== input.instruction) {
          throw new AppError('requestId already belongs to a different delivery.', { code: 'CONTEXT_REQUEST_CONFLICT', statusCode: 409 });
        }
        return existing;
      }
      if (input.mode === 'start' && await dependencies.running(input.targetSessionId)) throw new AppError('The target is working. Use attach for its next turn, or steer for live input.', { code: 'CONTEXT_TARGET_BUSY', statusCode: 409 });
      // Recheck after the liveness await so concurrent retries share one durable receipt.
      if (contextTransferDb.byRequest(userId, input.requestId)) return this.deliver(userId, packageId, input);
      const delivery: ContextDelivery = { id: randomUUID(), packageId, ...input, status: input.mode === 'steer' ? 'submitting' : 'pending', error: null, createdAt: new Date().toISOString() };
      const prompt = `${value.text}\n\n## Transfer instruction\n${input.instruction}`;
      contextTransferDb.insertDelivery(userId, delivery, prompt);
      if (input.mode === 'steer') {
        try {
          const result = await dependencies.steer(target.provider as LLMProvider, target.session_id, prompt);
          contextTransferDb.settle(delivery.id, result.status === 'accepted' ? 'delivered' : 'failed', result.status === 'accepted' ? null : `Live input returned ${result.status}. Attach this context for the next turn instead.`);
        } catch (error) { contextTransferDb.settle(delivery.id, 'uncertain', error instanceof Error ? error.message : String(error)); }
      } else if (input.mode === 'start') {
        // The registered runtime claims pending inputs synchronously, while its model turn continues in the background.
        void dependencies.start(userId, target.session_id, input.instruction).then(result => {
          if (!result.started) contextTransferDb.settle(delivery.id, 'failed', result.error || 'Target turn was not started.');
        }).catch(error => contextTransferDb.settle(delivery.id, 'uncertain', String(error)));
      }
      return this.read(userId, delivery.id);
    },
    cancel(userId: number, id: string): ContextDelivery {
      this.read(userId, id);
      if (!contextTransferDb.cancel(userId, id)) throw new AppError('Only pending attachments can be cancelled.', { code: 'CONTEXT_DELIVERY_STARTED', statusCode: 409 });
      return this.read(userId, id);
    },
  };
}

/** Authenticated context routes share this delivery service and its provider gateway. */
export const contextDeliveryService = createContextDeliveryService();
