import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { copyFile, mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { getOpenCodeDatabasePath } from '@/shared/utils.js';

type OwnedProcess = { child: ChildProcess; done: Promise<{ code: number | null; error: Error | null }> };

/** The OpenCode BTW service uses this private server and data store to own a disposable native fork. */
export class OpenCodeBtwConnection extends EventEmitter {
  private readonly controller = new AbortController();
  private readonly processes = new Set<OwnedProcess>();
  private readonly password = randomBytes(24).toString('hex');
  private directory: string | null = null;
  private baseUrl: string | null = null;
  private preparing: Promise<{ id: string }> | null = null;
  private closing: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly sourceId: string, private readonly cwd: string,
    private readonly binary = process.env.OPENCODE_BTW_BIN || 'opencode') { super(); }

  private checkOpen(): void {
    if (this.stopped) throw new Error('The temporary conversation has ended.');
  }

  private launch(args: string[], env: NodeJS.ProcessEnv, stdout?: number): OwnedProcess {
    this.checkOpen();
    const child = spawn(this.binary, args, { cwd: this.cwd, env,
      detached: process.platform !== 'win32', stdio: ['ignore', stdout ?? 'pipe', 'pipe'] });
    let error: Error | null = null;
    child.on('error', cause => { error = cause; });
    const owned = { child, done: new Promise<{ code: number | null; error: Error | null }>(resolve => {
      child.once('close', code => { this.processes.delete(owned); resolve({ code, error }); });
    }) };
    this.processes.add(owned);
    return owned;
  }

  private kill(owned: OwnedProcess, signal: NodeJS.Signals): void {
    try {
      if (process.platform !== 'win32' && owned.child.pid) process.kill(-owned.child.pid, signal);
      else owned.child.kill(signal);
    } catch { /* The owned process has already exited. */ }
  }

  private async run(args: string[], env: NodeJS.ProcessEnv, stdout?: number): Promise<void> {
    const owned = this.launch(args, env, stdout);
    let errorText = '';
    owned.child.stderr?.on('data', chunk => { errorText = (errorText + String(chunk)).slice(-2000); });
    owned.child.stdout?.resume();
    const timeout = setTimeout(() => this.kill(owned, 'SIGKILL'), 30_000);
    try {
      const result = await owned.done;
      if (result.error || result.code !== 0) throw result.error || new Error(`OpenCode ${args[0]} failed. ${errorText.trim().split('\n').at(-1) || ''}`);
    } finally { clearTimeout(timeout); }
  }

  private async startServer(env: NodeJS.ProcessEnv): Promise<void> {
    const owned = this.launch(['serve', '--hostname', '127.0.0.1', '--port', '0'], env);
    await new Promise<void>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('OpenCode side server startup timed out.')), 30_000);
      owned.child.stdout?.on('data', chunk => {
        output = (output + String(chunk)).slice(-4000);
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) { this.baseUrl = match[0]; clearTimeout(timer); resolve(); }
      });
      owned.child.stderr?.resume();
      void owned.done.then(result => {
        clearTimeout(timer);
        const error = result.error || new Error('OpenCode side server exited.');
        reject(error);
        if (!this.stopped && this.baseUrl) this.emit('disconnect', error);
      });
    });
  }

  private async response(method: string, pathname: string, body?: unknown, stream = false): Promise<Response> {
    this.checkOpen();
    if (!this.baseUrl) throw new Error('The OpenCode side server is preparing.');
    const url = new URL(pathname, this.baseUrl);url.searchParams.set('directory', this.cwd);
    const response = await fetch(url, { method,
      headers: { Authorization: `Basic ${Buffer.from(`opencode:${this.password}`).toString('base64')}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: stream ? this.controller.signal : AbortSignal.any([this.controller.signal, AbortSignal.timeout(30_000)]),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenCode side request failed (${response.status}): ${text.slice(0, 800)}`);
    }
    return response;
  }

  async request(method: string, pathname: string, body?: unknown): Promise<any> {
    const response = await this.response(method, pathname, body);
    return response.status === 204 ? null : response.json();
  }

  private async readEvents(response: Response): Promise<void> {
    const reader = response.body!.getReader();const decoder = new TextDecoder();let pending = '';
    try {
      while (!this.stopped) {
        const { done, value } = await reader.read();
        if (done) { if (!this.stopped) throw new Error('OpenCode side event stream ended.');break; }
        pending += decoder.decode(value, { stream: true });
        let boundary: number;
        while ((boundary = pending.indexOf('\n\n')) >= 0) {
          const frame = pending.slice(0, boundary);pending = pending.slice(boundary + 2);
          const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (data) {
            let event: unknown;
            try { event = JSON.parse(data); } catch { continue; }
            this.emit('notification', event);
          }
        }
      }
    } catch (error) { if (!this.stopped) this.emit('disconnect', error); }
    finally { await reader.cancel().catch(() => {}); }
  }

  initialize(): Promise<{ id: string }> {
    if (this.preparing) return this.preparing;
    this.preparing = this.prepare();
    return this.preparing;
  }

  private async prepare(): Promise<{ id: string }> {
    this.checkOpen();
    this.directory = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-btw-opencode-'));
    this.checkOpen();
    const exportPath = path.join(this.directory, 'source.json');
    const file = await open(exportPath, 'w', 0o600);
    try { await this.run(['export', this.sourceId], process.env, file.fd); }
    finally { await file.close(); }
    const dataDir = path.join(this.directory, 'data');
    await mkdir(path.join(dataDir, 'opencode'), { recursive: true });
    try {
      await copyFile(path.join(path.dirname(getOpenCodeDatabasePath()), 'auth.json'), path.join(dataDir, 'opencode', 'auth.json'));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const env = { ...process.env, XDG_DATA_HOME: dataDir, XDG_STATE_HOME: path.join(this.directory, 'state'),
      OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_SERVER_PASSWORD: this.password, OPENCODE_DISABLE_AUTOUPDATE: '1' };
    await this.run(['import', exportPath], env);
    await this.startServer(env);
    const stream = await this.response('GET', '/event', undefined, true);void this.readEvents(stream);
    // Both the copied source and its native fork live only in the private store.
    const fork = await this.request('POST', `/session/${encodeURIComponent(this.sourceId)}/fork`, {});
    if (typeof fork?.id !== 'string' || fork.id === this.sourceId) throw new Error('OpenCode returned an invalid side fork.');
    return { id: fork.id };
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;this.controller.abort();
    this.closing = (async () => {
      const children = [...this.processes];children.forEach(child => this.kill(child, 'SIGTERM'));
      const force = setTimeout(() => children.forEach(child => this.kill(child, 'SIGKILL')), 1500);
      try {
        await this.preparing?.catch(() => {});
        await Promise.all(children.map(child => child.done));
        if (this.directory) await rm(this.directory, { recursive: true, force: true });
      } finally { clearTimeout(force); }
    })();
    return this.closing;
  }
}
