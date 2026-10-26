import { open, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { sessionsDb } from '@/modules/database/index.js';
import { sharedCodexConnection } from '@/modules/providers/list/codex/codex-shared-connection.js';
import type { AnyRecord, ProviderUsageAccount, ProviderUsageSnapshot, ProviderUsageWindow, SessionContextUsage } from '@/shared/types.js';
import { AppError, getOpenCodeDatabasePath, readObjectRecord } from '@/shared/utils.js';

const readUsageNumber = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const object = (value: unknown): AnyRecord => readObjectRecord(value) ?? {};

async function readJson(filename: string): Promise<AnyRecord> {
  try { return object(JSON.parse(await readFile(filename, 'utf8'))); }
  catch { return {}; }
}

async function readTail(filename: string): Promise<string> {
  const file = await open(filename, 'r');
  try {
    const { size } = await file.stat();
    const start = Math.max(0, size - 4 * 1024 * 1024);
    const buffer = Buffer.alloc(size - start);
    await file.read(buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8');
    return start ? text.slice(text.indexOf('\n') + 1) : text;
  } finally { await file.close(); }
}

function readOpenCodeContext(sessionId: string): AnyRecord | null {
  const db = new Database(getOpenCodeDatabasePath(), { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare("SELECT data, time_created FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant' ORDER BY time_created DESC LIMIT 40").all(sessionId) as Array<{ data: string; time_created: number }>;
    for (const row of rows) {
      const info = JSON.parse(row.data) as AnyRecord;
      const tokens = object(info.tokens);
      const used = readUsageNumber(tokens.total) ?? ['input', 'output', 'reasoning'].reduce((sum, key) => sum + (readUsageNumber(tokens[key]) ?? 0), 0)
        + (readUsageNumber(tokens.cache?.read) ?? 0) + (readUsageNumber(tokens.cache?.write) ?? 0);
      if (used > 0) return { used, model: `${info.providerID}/${info.modelID}`, updatedAt: new Date(row.time_created).toISOString() };
    }
    return null;
  } finally { db.close(); }
}

type Dependencies = {
  now: () => number;
  home: () => string;
  getSession: typeof sessionsDb.getSessionById;
  readJson: typeof readJson;
  readTail: typeof readTail;
  readOpenCodeContext: typeof readOpenCodeContext;
  codexCall: (method: string, params: unknown) => Promise<AnyRecord>;
  fetch: typeof fetch;
};

type UsageOptions = { sessionId?: string; provider?: string; model?: string; refresh?: boolean };

/** Provider routes use this service for bounded context reads and sanitized, cached subscription quotas. */
export function createProviderUsageService(overrides: Partial<Dependencies> = {}) {
  const d: Dependencies = { now: Date.now, home: os.homedir, getSession: id => sessionsDb.getSessionById(id), readJson, readTail, readOpenCodeContext,
    codexCall: (method, params) => sharedCodexConnection.call(method, params), fetch: globalThis.fetch, ...overrides };
  // A shared in-flight read and short cache bound upstream requests across tabs and phones.
  let cached: { expiresAt: number; accounts: ProviderUsageAccount[] } | null = null;
  let pending: Promise<ProviderUsageAccount[]> | null = null;

  function windows(raw: AnyRecord): ProviderUsageWindow[] {
    return Object.entries(raw).flatMap(([id, value]) => {
      const item = object(value);
      const usedPercent = readUsageNumber(item.usedPercent ?? item.percent);
      if (usedPercent === null) return [];
      const date = typeof item.resetsAt === 'string' ? Date.parse(item.resetsAt) : typeof item.resetsAt === 'number' ? item.resetsAt * 1000 : NaN;
      return [{ id, usedPercent, windowMinutes: readUsageNumber(item.windowDurationMins) ?? ({ rolling: 300, weekly: 10080, monthly: 43200 }[id] ?? null),
        resetsAt: Number.isFinite(date) ? new Date(date).toISOString() : null }];
    });
  }

  function unavailable(id: string, provider: 'codex' | 'opencode', label: string, error: string): ProviderUsageAccount {
    const previous = cached?.accounts.find(account => account.id === id);
    return { id, provider, label, enabled: true, active: false, plan: null, windows: [], checkedAt: null, ...previous, status: previous?.windows.length ? 'stale' : 'unavailable', error };
  }

  async function codexAccount(): Promise<ProviderUsageAccount[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const [auth, limits] = await Promise.race([
        Promise.all([d.codexCall('account/read', {}), d.codexCall('account/rateLimits/read', {})]),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 8000); }),
      ]);
      const account = object(auth.account);
      const buckets = Object.keys(object(limits.rateLimitsByLimitId)).length ? object(limits.rateLimitsByLimitId) : { codex: object(limits.rateLimits) };
      const rows = Object.entries(buckets).flatMap(([id, bucket]) => {
        const item = object(bucket);
        return windows({ primary: item.primary, secondary: item.secondary }).map(window => ({ ...window, id: `${id}:${window.id}`, label: item.limitName || undefined }));
      });
      return [{ id: 'codex', provider: 'codex', label: 'Codex', enabled: true, active: true,
        plan: typeof account.planType === 'string' ? account.planType : null, windows: rows, checkedAt: new Date(d.now()).toISOString(),
        status: rows.length ? 'ok' : 'unavailable', error: rows.length ? null : account.type === 'apiKey' ? 'api_key' : 'quota_unavailable' }];
    } catch { return [unavailable('codex', 'codex', 'Codex', 'quota_unavailable')]; }
    finally { clearTimeout(timer); }
  }

  async function goState(): Promise<AnyRecord> {
    return d.readJson(path.join(process.env.OPENCODE_GO_ROUTER_HOME || path.join(d.home(), '.config', 'opencode-go-router'), 'state.json'));
  }

  async function goAccounts(): Promise<ProviderUsageAccount[]> {
    const state = await goState();
    let accounts = Array.isArray(state.accounts) ? state.accounts.slice().sort((a, b) => a.priority - b.priority) : [];
    if (!accounts.length) {
      const auth = await d.readJson(path.join(process.env.XDG_DATA_HOME || path.join(d.home(), '.local', 'share'), 'opencode', 'auth.json'));
      const key = auth['opencode-go']?.key;
      if (typeof key === 'string' && key !== 'go-account-router') accounts = [{ id: 'go', label: 'OpenCode Go', apiKey: key, enabled: true }];
    }
    if (!accounts.length) return [unavailable('go', 'opencode', 'OpenCode Go', 'not_configured')];
    return Promise.all(accounts.map(async account => {
      const id = `go:${account.id}`;
      const label = typeof account.label === 'string' ? account.label : 'OpenCode Go';
      try {
        const response = await d.fetch('https://opencode.ai/zen/go/v1/usage', {
          headers: { Authorization: `Bearer ${account.apiKey}` }, redirect: 'manual', signal: AbortSignal.timeout(6000),
        });
        if (!response.ok) throw new Error('quota_unavailable');
        const quota = object(await response.json());
        const result = windows(object(quota.usage));
        if (!result.length) throw new Error('quota_unavailable');
        return { id, label, provider: 'opencode' as const, enabled: account.enabled === true, active: false, plan: 'Go', windows: result,
          checkedAt: new Date(d.now()).toISOString(), status: 'ok' as const, error: null };
      } catch { return { ...unavailable(id, 'opencode', label, 'quota_unavailable'), enabled: account.enabled === true }; }
    }));
  }

  async function subscriptions(refresh: boolean): Promise<ProviderUsageAccount[]> {
    if (!refresh && cached && cached.expiresAt > d.now()) return cached.accounts;
    if (pending) return pending;
    pending = Promise.all([codexAccount(), goAccounts()]).then(groups => {
      const accounts = groups.flat(); cached = { expiresAt: d.now() + 30_000, accounts }; return accounts;
    }).finally(() => { pending = null; });
    return pending;
  }

  async function context(session: ReturnType<Dependencies['getSession']>, provider: string, selectedModel?: string): Promise<SessionContextUsage> {
    let model = selectedModel || session?.model || null;
    let used: number | null = null;
    let limit: number | null = null;
    let updatedAt: string | null = null;
    if (provider === 'codex') {
      if (session?.jsonl_path) {
        try {
          const lines = (await d.readTail(session.jsonl_path)).trim().split('\n');
          for (let i = lines.length - 1; i >= 0; i--) {
            let entry: AnyRecord;
            try { entry = JSON.parse(lines[i]); } catch { continue; }
            const info = entry.type === 'event_msg' && entry.payload?.type === 'token_count' ? entry.payload.info : null;
            if (!info) continue;
            // last_token_usage measures the current context; total_token_usage is cumulative billing activity.
            used = readUsageNumber(info.last_token_usage?.total_tokens);
            limit = readUsageNumber(info.model_context_window);
            updatedAt = entry.timestamp || null;
            break;
          }
        } catch { /* The context stays unknown until a usage snapshot becomes available. */ }
      }
      if (!limit && model) {
        const catalog = await d.readJson(path.join(d.home(), '.codex', 'models_cache.json'));
        const item = Array.isArray(catalog.models) ? catalog.models.find(candidate => candidate.slug === model) : null;
        const window = readUsageNumber(item?.context_window);
        if (window) limit = Math.floor(window * (readUsageNumber(item?.effective_context_window_percent) ?? 100) / 100);
      }
    } else if (provider === 'opencode') {
      if (session?.provider_session_id) {
        try {
          const latest = d.readOpenCodeContext(session.provider_session_id);
          if (latest) { used = latest.used; model = latest.model; updatedAt = latest.updatedAt; }
        } catch { /* A fresh session has no persisted assistant usage yet. */ }
      }
      if (model) {
        const catalog = await d.readJson(path.join(process.env.XDG_CACHE_HOME || path.join(d.home(), '.cache'), 'opencode', 'models.json'));
        const slash = model.indexOf('/');
        limit = readUsageNumber(catalog[model.slice(0, slash)]?.models?.[model.slice(slash + 1)]?.limit?.context);
      }
    }
    return { used, limit, model, updatedAt };
  }

  return {
    async getUsage(options: UsageOptions): Promise<ProviderUsageSnapshot> {
      const session = options.sessionId ? d.getSession(options.sessionId) : null;
      if (options.sessionId && !session) throw new AppError('Session was not found.', { code: 'SESSION_NOT_FOUND', statusCode: 404 });
      const provider = session?.provider || options.provider || 'codex';
      const [currentContext, accounts, state] = await Promise.all([context(session, provider, options.model), subscriptions(options.refresh === true), goState()]);
      const nativeId = session?.provider_session_id;
      const activeGo = nativeId && state.sessions?.[nativeId]?.accountId;
      const preferredGo = accounts.find(account => account.provider === 'opencode' && account.enabled)?.id;
      const usingGo = provider === 'opencode' && (options.model || currentContext.model || '').startsWith('opencode-go/');
      return { context: currentContext, accounts: accounts.map(account => ({ ...account,
        active: account.provider === 'codex' ? provider === 'codex' : usingGo && account.id === (activeGo ? `go:${activeGo}` : preferredGo),
      })), fetchedAt: new Date(d.now()).toISOString() };
    },
  };
}

/** Shared cache for the authenticated provider usage endpoint. */
export const providerUsageService = createProviderUsageService();
