import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import { claudeRuntime } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { IProviderRuntime } from '@/shared/interfaces.js';

/** Claude's group adapter and its tests merge peer input into the SDK's existing held stdin stream. */
export function createGroupPromptChannel(base: AsyncIterable<SDKUserMessage>) {
  const queued: Array<{ message: SDKUserMessage; resolve: () => void; reject: (error: Error) => void }> = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const close = () => {
    closed = true; wake?.();
    for (const item of queued.splice(0)) item.reject(new Error('Claude input closed before accepting this message.'));
  };
  const stream = (async function* () {
    const iterator = base[Symbol.asyncIterator]();
    let original = iterator.next();
    try {
      while (!closed) {
        const peer = queued.shift();
        if (peer) {
          try { yield peer.message; peer.resolve(); }
          finally { if (closed) peer.reject(new Error('Claude input closed during delivery.')); }
          continue;
        }
        const incoming = new Promise<{ peer: true }>(resolve => { wake = () => resolve({ peer: true }); });
        const result = await Promise.race([original.then(value => ({ value })), incoming]);
        wake = undefined;
        if ('peer' in result) continue;
        if (result.value.done) return;
        yield result.value.value;
        original = iterator.next();
      }
    } finally { close(); void iterator.return?.(); }
  })();
  return {
    stream, close,
    append(content: string): Promise<void> {
      if (closed) return Promise.reject(new Error('Claude input is closed.'));
      return new Promise((resolve, reject) => {
        queued.push({ message: { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null,
          priority: 'now', isSynthetic: true, client_composed: true, timestamp: new Date().toISOString() }, resolve, reject });
        wake?.();
      });
    },
  };
}

const channels = new Map<string, { active: boolean; input: ReturnType<typeof createGroupPromptChannel> }>();

/** ClaudeProvider uses this adapter for native group instructions and live input, retaining its normal runtime. */
export const claudeGroupRuntime: IProviderRuntime = {
  ...claudeRuntime,
  async steer(sessionId, content) {
    const channel = channels.get(sessionId);
    if (!channel?.active) return { status: 'idle' };
    await channel.input.append(content);
    return { status: 'accepted' };
  },
  async run(command, options, writer, context) {
    if (!options.groupSystemPrompt || typeof options.sessionId !== 'string') return claudeRuntime.run(command, options, writer, context);
    const sessionId = options.sessionId;
    let current: { active: boolean; input: ReturnType<typeof createGroupPromptChannel> } | undefined;
    const createQuery = (args: Parameters<typeof query>[0]): Query => {
      if (typeof args.prompt === 'string') throw new Error('Group input requires Claude streaming prompts.');
      current?.input.close();
      const input = createGroupPromptChannel(args.prompt);
      const state = { active: true, input };
      current = state; channels.set(sessionId, state);
      const existing = args.options?.systemPrompt;
      const systemPrompt = typeof existing === 'string' ? `${existing}\n\n${options.groupSystemPrompt}`
        : { type: 'preset' as const, preset: 'claude_code' as const, append: [existing && !Array.isArray(existing) && 'append' in existing ? existing.append : '', options.groupSystemPrompt].filter(Boolean).join('\n\n') };
      const instance = query({ ...args, prompt: input.stream, options: { ...args.options, systemPrompt } });
      return new Proxy(instance, {
        get(target, key) {
          if (key === Symbol.asyncIterator) return async function* () {
            for await (const event of target) {
              if (event.type === 'result') state.active = false;
              yield event;
            }
          };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };
    try { return await claudeRuntime.run(command, options, writer, { ...context, createQuery }); }
    finally {
      current?.input.close();
      if (channels.get(sessionId) === current) channels.delete(sessionId);
    }
  },
};
