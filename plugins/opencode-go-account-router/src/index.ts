import type { Plugin } from '@opencode-ai/plugin';
import { Store } from './store.js';
import { Router } from './router.js';

const server: Plugin = async (_context, options) => {
  const store = new Store(typeof options?.stateDir === 'string' ? options.stateDir : undefined);
  const router = new Router(store);
  return {
    auth: {
      provider: 'opencode-go',
      loader: async () => {
        const state = await store.snapshot();
        if (!state.accounts.some(a => a.enabled)) return {};
        return { apiKey: 'go-account-router', fetch: router.fetch };
      },
      methods: [{
        type: 'api', label: 'Add Go router account',
        prompts: [
          { type: 'text', key: 'apiKey', message: 'OpenCode Go API key' },
          { type: 'text', key: 'label', message: 'Account label' },
        ],
        authorize: async inputs => {
          try { await store.add(inputs?.label || 'Go account', inputs?.apiKey || ''); }
          catch { return { type: 'failed' }; }
          return { type: 'success', key: inputs!.apiKey.trim() };
        },
      }],
    },
    'chat.headers': async (input, output) => {
      if (input.model.providerID === 'opencode-go') output.headers['x-opencode-session'] = input.sessionID;
    },
  };
};

/** OpenCode 1.18 server plugin entry; helper exports live in their own modules. */
export default { id: 'opencode-go-account-router', server };
