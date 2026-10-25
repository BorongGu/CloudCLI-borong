import { mkdir, open, readFile, rename, chmod, unlink, link } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import type { Account, State } from './types.js';

const empty = (): State => ({ version: 1, accounts: [], quotas: {}, blocks: {}, sessions: {}, events: [] });

/** Owns the account pool and shared runtime state; transactions serialize CLI processes. */
export class Store {
  readonly directory: string;
  readonly filename: string;
  constructor(directory = process.env.OPENCODE_GO_ROUTER_HOME || path.join(os.homedir(), '.config', 'opencode-go-router')) {
    this.directory = path.resolve(directory);
    this.filename = path.join(this.directory, 'state.json');
  }
  private async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const initial = this.filename + '.' + randomUUID() + '.init';
    try {
      const handle = await open(initial, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(empty())); await handle.sync(); } finally { await handle.close(); }
      // A hard link publishes a complete first file with exclusive creation.
      // Concurrent processes can then lock/read it immediately.
      try { await link(initial, this.filename); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    } finally { await unlink(initial).catch(() => {}); }
    await chmod(this.filename, 0o600);
  }
  private async read(): Promise<State> {
    const state = JSON.parse(await readFile(this.filename, 'utf8')) as State;
    if (state.version !== 1 || !Array.isArray(state.accounts) || !state.quotas || !state.blocks || !state.sessions || !Array.isArray(state.events)) {
      throw new Error('Unsupported or damaged Go router state; restore a backup before continuing.');
    }
    if (state.accounts.some(a => typeof a.id !== 'string' || typeof a.apiKey !== 'string'
      || typeof a.label !== 'string' || typeof a.enabled !== 'boolean' || !Number.isFinite(a.priority))) {
      throw new Error('Invalid Go router account record.');
    }
    return state;
  }
  async transaction<T>(update: (state: State) => T): Promise<T> {
    await this.initialize();
    const release = await lockfile.lock(this.filename, {
      realpath: false, stale: 10_000, update: 2000,
      retries: { retries: 100, factor: 1.15, minTimeout: 10, maxTimeout: 200 },
    });
    try {
      const state = await this.read();
      const result = update(state);
      const temporary = this.filename + '.' + randomUUID() + '.tmp';
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(state, null, 2) + '\n'); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temporary, this.filename);
      } finally { await unlink(temporary).catch(() => {}); }
      return result;
    } finally { await release(); }
  }
  async snapshot(): Promise<State> {
    // Initialization and reads share the lock: a second process can otherwise
    // observe the very first file between its creation and its initial write.
    return this.transaction(state => structuredClone(state));
  }
  async add(label: string, apiKey: string): Promise<string> {
    const key = apiKey.trim();
    if (!key || /\s/.test(key)) throw new Error('Enter a nonempty Go API key without whitespace.');
    if (!label.trim() || label.length > 100) throw new Error('Account label must contain 1–100 characters.');
    return this.transaction(state => {
      if (state.accounts.some(a => a.apiKey === key)) throw new Error('This key is already configured.');
      const account: Account = { id: randomUUID(), label: label.trim(), apiKey: key, enabled: true, priority: state.accounts.length };
      state.accounts.push(account); return account.id;
    });
  }
  async prefer(id: string) {
    return this.transaction(state => {
      const account = state.accounts.find(a => a.id === id || a.label === id);
      if (!account) throw new Error('Account not found.');
      const ordered = [account, ...state.accounts.filter(a => a.id !== account.id).sort((a, b) => a.priority - b.priority)];
      ordered.forEach((item, priority) => { item.priority = priority; });
    });
  }
  async change(id: string, action: 'enable' | 'disable' | 'remove') {
    return this.transaction(state => {
      const account = state.accounts.find(a => a.id === id || a.label === id);
      if (!account) throw new Error('Account not found.');
      if (action === 'remove') state.accounts = state.accounts.filter(a => a.id !== account.id);
      else account.enabled = action === 'enable';
      delete state.blocks[account.id]; delete state.quotas[account.id];
      for (const [session, selected] of Object.entries(state.sessions)) {
        if (selected.accountId === account.id) delete state.sessions[session];
      }
    });
  }
}

/** CLI/status identifier; the API key itself stays in the private store. */
export const fingerprint = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 12);
