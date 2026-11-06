import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { providerModelsService } from '@/modules/providers/services/provider-models.service.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { contextTransferDb, groupsDb } from '@/modules/database/index.js';
import { GROUP_MODE_SYSTEM_PROMPT } from '@/shared/index.js';
import type { IProvider } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  LLMProvider,
  ProviderPermissionDecision,
  ProviderRunFunction,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
  ProviderSteerResult,
} from '@/shared/types.js';

type ProviderRuntimeServiceDependencies = {
  claimContext: typeof contextTransferDb.claim;
  settleContext: typeof contextTransferDb.settle;
  groupInstructions(sessionId: string): string | undefined;
  listProviders(): IProvider[];
  resolveProvider(provider: string): IProvider;
  resolveProviderSessionId(sessionId: string | null | undefined): string | null;
  resolveResumeModel(
    provider: LLMProvider,
    sessionId: string | undefined,
    requestedModel?: string | null,
  ): Promise<string | undefined>;
  getProviderModels: typeof providerModelsService.getProviderModels;
};

const defaultDependencies: ProviderRuntimeServiceDependencies = {
  claimContext: sessionId => contextTransferDb.claim(sessionId),
  settleContext: (id, status, error) => contextTransferDb.settle(id, status, error),
  groupInstructions: sessionId => groupsDb.membership(sessionId) ? GROUP_MODE_SYSTEM_PROMPT : undefined,
  listProviders: () => providerRegistry.listProviders(),
  resolveProvider: (provider) => providerRegistry.resolveProvider(provider),
  resolveProviderSessionId: (sessionId) => sessionsService.resolveProviderSessionId(sessionId),
  resolveResumeModel: (provider, sessionId, requestedModel) =>
    providerModelsService.resolveResumeModel(provider, sessionId, requestedModel),
  getProviderModels: (provider) => providerModelsService.getProviderModels(provider),
};

/**
 * Creates the application-facing provider runtime dispatcher. Context-transfer
 * integration tests use this factory to exercise the shared attachment boundary.
 *
 * The provider registry owns each concrete runtime. This service supplies the
 * registry-backed model/session lookups at execution time so runtime adapters
 * never import services that resolve back through the registry.
 */
export function createProviderRuntimeService(
  dependencyOverrides: Partial<ProviderRuntimeServiceDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };

  const createRuntimeContext = (
    provider: IProvider,
  ): ProviderRuntimeContext => ({
    resolveProviderSessionId: dependencies.resolveProviderSessionId,
    resolveResumeModel: (sessionId, requestedModel) =>
      dependencies.resolveResumeModel(provider.id, sessionId, requestedModel),
    getProviderModels: async () => dependencies.getProviderModels(provider.id),
    normalizeMessage: (raw, sessionId) => provider.sessions.normalizeMessage(raw, sessionId),
    async isProviderInstalled() {
      try {
        return (await provider.auth.getStatus()).installed;
      } catch {
        // Preserve the runtime's original error when installation probing fails.
        return true;
      }
    },
  });

  const run = async (
    providerName: LLMProvider,
    command: string,
    options: AnyRecord,
    writer: ProviderRuntimeWriter,
  ): Promise<unknown> => {
    const provider = dependencies.resolveProvider(providerName);
    const instructions = typeof options.sessionId === 'string' ? dependencies.groupInstructions(options.sessionId) : undefined;
    const attachments = typeof options.sessionId === 'string' && options.contextPreparation !== true ? dependencies.claimContext(options.sessionId) : [];
    const input = attachments.length ? `${attachments.map(item => item.prompt).join('\n\n')}\n\n## Current user message\n${command}` : command;
    let completed = false;
    let failure: string | null = null;
    const observed = attachments.length ? new Proxy(writer, {
      get(target, key) {
        if (key === 'send') return (data: unknown) => {
          const event = data as { kind?: string; exitCode?: number; aborted?: boolean } | null;
          if (event?.kind === 'complete') {
            completed = true;
            if (event.aborted || event.exitCode && event.exitCode !== 0) failure = event.aborted ? 'Target turn was interrupted.' : `Target exited with code ${event.exitCode}.`;
          }
          target.send(data);
        };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) : writer;
    try {
      const result = await provider.runtime.run(input, { ...options, ...(instructions ? { groupSystemPrompt: instructions } : {}) }, observed, createRuntimeContext(provider));
      for (const item of attachments) dependencies.settleContext(item.id, completed && !failure ? 'delivered' : 'uncertain', failure || (completed ? null : 'The provider ended without a completion acknowledgement.'));
      return result;
    } catch (error) {
      for (const item of attachments) dependencies.settleContext(item.id, 'uncertain', error instanceof Error ? error.message : String(error));
      throw error;
    }
  };

  return {
    run,

    supportsSteering(providerName: LLMProvider): boolean {
      return Boolean(dependencies.resolveProvider(providerName).runtime.steer);
    },

    async steer(providerName: LLMProvider, sessionId: string, content: string): Promise<ProviderSteerResult> {
      const runtime = dependencies.resolveProvider(providerName).runtime;
      return runtime.steer ? runtime.steer(sessionId, content) : { status: 'unsupported' };
    },

    hasRuntime(providerName: string): boolean {
      try {
        return Boolean(dependencies.resolveProvider(providerName).runtime);
      } catch {
        return false;
      }
    },

    getRunner(provider: LLMProvider): ProviderRunFunction {
      return (command, options, writer) => run(provider, command, options, writer);
    },

    async abort(providerName: LLMProvider, sessionId: string): Promise<boolean> {
      return Boolean(await dependencies.resolveProvider(providerName).runtime.abort(sessionId));
    },

    async stopBackgroundTask(providerName: LLMProvider, sessionId: string, taskId: string): Promise<boolean> {
      // A runtime that never holds background work has no task to stop.
      const { runtime } = dependencies.resolveProvider(providerName);
      return Boolean(await runtime.stopBackgroundTask?.(sessionId, taskId));
    },

    hasBackgroundWork(sessionId: string): boolean {
      return dependencies.listProviders().some((provider) =>
        (provider.runtime.listBackgroundWork?.() ?? []).some((entry) => entry.sessionId === sessionId));
    },

    resolveToolApproval(requestId: string, decision: ProviderPermissionDecision): void {
      for (const provider of dependencies.listProviders()) {
        provider.runtime.permissions?.resolve(requestId, decision);
      }
    },

    getPendingApprovalsForSession(sessionId: string): unknown[] {
      return dependencies.listProviders().flatMap(
        (provider) => provider.runtime.permissions?.listPending(sessionId) ?? [],
      );
    },

    async restorePendingApprovals(providerName: LLMProvider, sessionId: string, writer: ProviderRuntimeWriter): Promise<void> {
      const providerSessionId = dependencies.resolveProviderSessionId(sessionId);
      if (providerSessionId) await dependencies.resolveProvider(providerName).runtime.permissions?.restorePending?.(sessionId, providerSessionId, writer);
    },
  };
}

export const providerRuntimeService = createProviderRuntimeService();
