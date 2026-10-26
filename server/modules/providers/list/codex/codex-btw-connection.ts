import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';

/** Used by the BTW service: each window owns an app-server and its in-memory fork. */
export class CodexBtwConnection extends EventEmitter {
  private readonly child;
  private readonly reader;
  private nextId = 0;
  private stopped = false;
  private closing: Promise<void> | null = null;
  private stderr = '';
  private readonly exited: Promise<void>;
  private readonly pending = new Map<number, {
    resolve(value: any): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(binary = process.env.CODEX_BTW_BIN || 'codex') {
    super();
    // A dedicated process group lets close also reap tools started by this fork.
    this.child = spawn(binary, ['app-server'], {
      env: process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    this.reader = readline.createInterface({ input: this.child.stdout });
    this.reader.on('line', line => this.receive(line));
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + String(chunk)).slice(-2000); });
    this.child.stdin.on('error', error => this.fail(error));
    this.child.stdout.on('error', error => this.fail(error));
    this.child.stderr.on('error', () => {});
    this.child.on('error', error => this.fail(error));
    this.exited = new Promise(resolve => {
      this.child.once('close', () => {
        this.fail(new Error(`Codex side conversation exited.${this.stderr ? ` ${this.stderr.trim().split('\n').at(-1)}` : ''}`));
        resolve();
      });
    });
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    if (!this.stopped) { this.stopped = true; this.emit('disconnect', error); }
  }

  private receive(line: string): void {
    let message: any;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method) {
      if (message.id !== undefined) {
        // Side questions use ordinary replies for clarification; returning an
        // RPC error also lets unexpected interactive tools recover promptly.
        this.child.stdin.write(`${JSON.stringify({ id: message.id, error: {
          code: -32601, message: 'Ask for clarification in a normal reply in this side conversation.',
        } })}\n`);
      } else this.emit('notification', message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id); clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message || 'Codex BTW request failed.'));
    else pending.resolve(message.result);
  }

  call(method: string, params: unknown): Promise<any> {
    if (this.stopped) return Promise.reject(new Error('The temporary conversation has ended.'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error(`Codex BTW request timed out: ${method}`));
      }, 30_000);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  async initialize(): Promise<void> {
    await this.call('initialize', {
      clientInfo: { name: 'cloudcli_btw', title: 'CloudCLI BTW', version: '1' },
      capabilities: { experimentalApi: true },
    });
    this.child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      this.stopped = true;
      this.fail(new Error('The temporary conversation has ended.'));
      const kill = (signal: NodeJS.Signals) => {
        try {
          if (process.platform !== 'win32' && this.child.pid) process.kill(-this.child.pid, signal);
          else this.child.kill(signal);
        } catch { /* The owned process has already exited. */ }
      };
      kill('SIGTERM');
      const force = setTimeout(() => kill('SIGKILL'), 1500);
      force.unref?.();
      await this.exited;
      clearTimeout(force); this.reader.close();
    })();
    return this.closing;
  }
}
