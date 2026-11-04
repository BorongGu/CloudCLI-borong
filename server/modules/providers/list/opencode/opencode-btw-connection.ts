import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { copyFile, mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { getOpenCodeDatabasePath, getOpenCodeMajorVersion } from '@/shared/utils.js';

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
  private major = 1;
  private v2Requests = new Map<string, string>();
  private v2Texts = new Map<string, string>();

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
    if (this.major >= 2) return this.requestV2(method, pathname, body);
    const response = await this.response(method, pathname, body);
    return response.status === 204 ? null : response.json();
  }

  private translateV2Event(event: any): void {
    if (typeof event?.type !== 'string') return;
    const p = event.data || {};
    const sessionID = p.sessionID || p.form?.sessionID;
    const emit = (type: string, properties: any) => this.emit('notification', { type, properties });
    if (event.type === 'permission.asked' || event.type === 'form.created') {
      const request = p.form || p;
      this.v2Requests.set(request.id, sessionID);
      emit(event.type === 'permission.asked' ? 'permission.asked' : 'question.asked', { ...request, sessionID });
    }
    if (event.type.startsWith('session.execution.')) {
      if (event.type === 'session.execution.failed') emit('session.error', { sessionID, error: p.error });
      emit('session.status', { sessionID, status: { type: event.type.endsWith('.started') ? 'busy' : 'idle' } });
    }
    const messageID = p.assistantMessageID;
    if (!sessionID || !messageID) return;
    emit('message.updated', { info: { id: messageID, role: 'assistant', sessionID } });
    if (/^session\.(text|reasoning)\.(started|delta|ended)$/.test(event.type)) {
      const type = event.type.split('.')[1];
      const id = `${messageID}_${type}_${p.ordinal}`;
      const text = event.type.endsWith('.ended') ? p.text || '' : (this.v2Texts.get(id) || '') + (p.delta || '');
      this.v2Texts.set(id, text);
      emit('message.part.updated', { part: { id, sessionID, messageID, type, text } });
    }
    if (event.type.startsWith('session.tool.')) {
      emit('message.part.updated', { part: { id: p.id, sessionID, messageID, type: 'tool', tool: p.name || 'Tool',
        state: { status: event.type.endsWith('.success') || event.type.endsWith('.failed') ? 'completed' : 'running' } } });
    }
    if (event.type === 'session.step.failed') emit('session.error', { sessionID, error: p.error });
  }

  private async requestV2(method: string, pathname: string, body?: any): Promise<any> {
    const session = pathname.match(/^\/session\/([^/]+)\/(.+)$/);
    if (session) {
      const [, id, action] = session;
      if (action === 'message' && method === 'GET') {
        const exported: any = await (await this.response('GET', `/api/experimental/session/${id}/export`)).json();
        return (exported.messages || []).map((message: any) => ({ info: { id: message.id, role: message.type } }));
      }
      if (action === 'prompt_async') {
        if (body?.model) await this.response('POST', `/api/session/${id}/model`, { model: {
          id: body.model.modelID, providerID: body.model.providerID, ...(body.variant ? { variant: body.variant } : {}),
        } });
        if (body?.agent) await this.response('POST', `/api/session/${id}/agent`, { agent: body.agent });
        pathname = `/session/${id}/prompt`;
        body = { text: [body?.system, ...(body?.parts || []).map((part: any) => part.text || '')].filter(Boolean).join('\n\n') };
      }
      if (action === 'abort') { pathname = `/session/${id}/interrupt`;body = {}; }
    }
    const permission = pathname.match(/^\/(permission|question)\/([^/]+)\/(reply|reject)$/);
    if (permission) {
      const [, kind, id] = permission;
      const sessionId = this.v2Requests.get(decodeURIComponent(id));
      if (!sessionId) return null;
      pathname = `/session/${encodeURIComponent(sessionId)}/${kind === 'permission' ? 'permission' : 'form'}/${id}${kind === 'permission' ? '/reply' : ''}`;
      method = kind === 'permission' ? 'POST' : 'DELETE';
      body = kind === 'permission' ? { decision: body.reply } : undefined;
    }
    const response = await this.response(method, `/api${pathname}`, body);
    if (response.status === 204) return null;
    const value: any = await response.json();return value.data ?? value;
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
            if (this.major >= 2) this.translateV2Event(event);
            else this.emit('notification', event);
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
    this.major = getOpenCodeMajorVersion(this.binary);
    const dataDir = path.join(this.directory, 'data');
    await mkdir(path.join(dataDir, 'opencode'), { recursive: true });
    const env = { ...process.env, PWD: this.cwd, XDG_DATA_HOME: dataDir, XDG_STATE_HOME: path.join(this.directory, 'state'),
      OPENCODE_DB: path.join(dataDir, 'opencode', 'opencode.db'),
      OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_SERVER_PASSWORD: this.password, OPENCODE_PASSWORD: this.password,
      OPENCODE_DISABLE_AUTOUPDATE: '1' };
    if (this.major >= 2) {
      // V2 stores credentials alongside its projected history. A consistent private
      // SQLite backup preserves both while the native fork stays disposable.
      const source = new Database(getOpenCodeDatabasePath(), { readonly: true, fileMustExist: true });
      try { await source.backup(env.OPENCODE_DB); } finally { source.close(); }
    } else {
      const exportPath = path.join(this.directory, 'source.json');
      const file = await open(exportPath, 'w', 0o600);
      try { await this.run(['export', this.sourceId], process.env, file.fd); } finally { await file.close(); }
      try { await copyFile(path.join(path.dirname(getOpenCodeDatabasePath()), 'auth.json'), path.join(dataDir, 'opencode', 'auth.json')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await this.run(['import', exportPath], env);
    }
    await this.startServer(env);
    const stream = await this.response('GET', this.major >= 2 ? '/api/event' : '/event', undefined, true);void this.readEvents(stream);
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
