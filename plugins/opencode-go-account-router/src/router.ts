import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { blockedUntil, parseQuota, retryAt } from './quota.js';
import type { Account, Fetch } from './types.js';

type Options = {
  fetch?: Fetch; now?: () => number; quotaTtlMs?: number; quotaTimeoutMs?: number;
  usageUrl?: string; allowedOrigins?: string[];
};

/** Request-level Go routing, shared by the plugin, CLI status and protocol tests. */
export class Router {
  private readonly send: Fetch;
  private readonly now: () => number;
  private refresh: Promise<void> | null = null;
  private readonly fallbackSession = 'process-' + randomUUID();
  constructor(readonly store: Store, private readonly options: Options = {}) {
    this.send = options.fetch || globalThis.fetch.bind(globalThis);
    this.now = options.now || Date.now;
  }
  async refreshQuotas(force = false): Promise<void> {
    if (this.refresh) return this.refresh;
    this.refresh = (async () => {
      const snapshot = await this.store.snapshot();
      await Promise.all(snapshot.accounts.filter(a => a.enabled).map(async account => {
        const cached = snapshot.quotas[account.id];
        if (!force && cached && this.now() - cached.checkedAt < (this.options.quotaTtlMs ?? 30_000)) return;
        try {
          const response = await this.send(this.options.usageUrl || 'https://opencode.ai/zen/go/v1/usage', {
            headers: { Authorization: 'Bearer ' + account.apiKey, 'User-Agent': 'opencode-go-account-router/0.1.0' },
            redirect: 'manual', signal: AbortSignal.timeout(this.options.quotaTimeoutMs ?? 5000),
          });
          const quota = response.ok ? parseQuota(await response.json(), this.now()) : null;
          if (quota || response.status === 401) await this.store.transaction(state => {
            if (!state.accounts.some(a => a.id === account.id && a.apiKey === account.apiKey)) return;
            if (quota) state.quotas[account.id] = quota;
            if (response.status === 401) {
              state.blocks[account.id] ||= {};
              state.blocks[account.id]['*'] = { until: this.now() + 3_600_000, reason: 'credential_rejected' };
            }
          });
          if (!response.ok) await response.body?.cancel();
        } catch { /* Keep the latest persisted observation when usage is temporarily unavailable. */ }
      }));
    })();
    try { await this.refresh; } finally { this.refresh = null; }
  }
  private async choose(session: string, model: string, tried: Set<string>): Promise<Account | null> {
    return this.store.transaction(state => {
      const now = this.now();
      const candidates = state.accounts.filter(a => a.enabled && !tried.has(a.id) && blockedUntil(state, a.id, model, now) <= now)
        .sort((a, b) => a.priority - b.priority);
      const previous = state.sessions[session]?.accountId;
      const account = candidates.find(a => a.id === previous) || candidates[0];
      if (!account) return null;
      state.sessions[session] = { accountId: account.id, updatedAt: now };
      // Bound persisted diagnostic data without storing prompts or API keys in events.
      if (previous !== account.id) state.events.push({ at: now, session, accountId: account.id, previous, reason: previous ? 'failover' : 'selected' });
      state.events = state.events.slice(-200);
      const sessions = Object.entries(state.sessions).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, 2000);
      state.sessions = Object.fromEntries(sessions);
      return { ...account };
    });
  }
  private async unavailable(model: string): Promise<Response> {
    const state = await this.store.snapshot(); const now = this.now();
    const times = state.accounts.filter(a => a.enabled).map(a => blockedUntil(state, a.id, model, now)).filter(t => t > now);
    const next = times.length ? Math.min(...times) : now + 60_000;
    return new Response(JSON.stringify({ error: {
      type: 'rate_limit_error', code: 'all_go_accounts_unavailable',
      message: 'All enabled OpenCode Go accounts are unavailable. Next retry: ' + new Date(next).toISOString(),
      retryAt: new Date(next).toISOString(),
    } }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(Math.max(1, Math.ceil((next - now) / 1000))) } });
  }
  readonly fetch: Fetch = async (input, init) => {
    const template = new Request(input, init);
    const url = new URL(template.url);
    const origins = this.options.allowedOrigins || ['https://opencode.ai'];
    if (!origins.includes(url.origin) || !/^\/(zen|inference)\/go\//.test(url.pathname)) {
      throw new Error('Go account router received an untrusted inference endpoint.');
    }
    const session = template.headers.get('x-opencode-session') || this.fallbackSession;
    // Google identifies the model in the URL; OpenAI/Anthropic put it in JSON.
    const pathModel = /\/models\/([^/]+)/.exec(url.pathname)?.[1];
    let model = pathModel ? decodeURIComponent(pathModel).split(':')[0] : 'unknown-model';
    if (template.method === 'POST') {
      try { const body = await template.clone().json() as { model?: unknown }; if (typeof body.model === 'string') model = body.model; }
      catch { /* Keep non-JSON request bodies intact. */ }
    }
    template.signal.throwIfAborted();
    await this.refreshQuotas();
    const tried = new Set<string>();
    while (true) {
      template.signal.throwIfAborted();
      const account = await this.choose(session, model, tried);
      if (!account) return this.unavailable(model);
      tried.add(account.id);
      const headers = new Headers(template.headers);
      const target = new URL(template.url);
      const hasQueryKey = target.searchParams.has('key');
      const hasHeaderKey = headers.has('x-api-key') || headers.has('x-goog-api-key');
      if (headers.has('Authorization') || (!hasHeaderKey && !hasQueryKey)) headers.set('Authorization', 'Bearer ' + account.apiKey);
      if (headers.has('x-api-key')) headers.set('x-api-key', account.apiKey);
      if (headers.has('x-goog-api-key')) headers.set('x-goog-api-key', account.apiKey);
      if (hasQueryKey) target.searchParams.set('key', account.apiKey);
      headers.set('x-opencode-session', session);
      // A fresh Request retains body, native headers and cancellation for each
      // attempt. Transport errors and successful/streaming responses pass through.
      const attempt = new Request(template.clone(), { headers, redirect: 'manual' });
      const response = await this.send(hasQueryKey ? new Request(target, attempt) : attempt);
      let reason: string | null = response.status === 429 ? 'quota_or_rate_limit'
        : response.status === 401 ? 'credential_rejected' : null;
      if (!reason && (response.status === 402 || response.status === 403)) {
        const text = await response.clone().text();
        if (/quota|usage.?limit|insufficient\s+(balance|credit)|rate.?limit/i.test(text)) reason = 'quota_exhausted';
      }
      if (!reason) return response;
      const failureReason = reason;
      const now = this.now();
      const until = response.status === 401 ? now + 3_600_000 : retryAt(response.headers.get('Retry-After'), now);
      await response.body?.cancel();
      await this.store.transaction(state => {
        if (!state.accounts.some(a => a.id === account.id && a.apiKey === account.apiKey)) return;
        state.blocks[account.id] ||= {};
        const scope = response.status === 401 ? '*' : model;
        state.blocks[account.id][scope] = { until: Math.max(until, state.blocks[account.id][scope]?.until || 0), reason: failureReason };
      });
      // A rejected request is safe to replay. Force a quota read so a weekly or
      // monthly exhaustion survives the next CLI process with its real reset time.
      if (response.status !== 401) await this.refreshQuotas(true);
    }
  };
}
