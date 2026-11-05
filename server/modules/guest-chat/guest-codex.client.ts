import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';

/** Guest chat owns this dedicated app-server, configured and isolated by its container. */
export class GuestCodexClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  async initialize(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const child = spawn(process.env.GUEST_CODEX_BIN || '/usr/local/bin/codex', ['app-server', '--strict-config', '--stdio'], {
        cwd: '/workspace', env: process.env, stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;
      const lines = createInterface({ input: child.stdout });
      child.stderr.resume();
      child.stdin.on('error', () => {});
      child.once('error', () => this.disconnected());
      child.once('close', () => { lines.close();this.disconnected(); });
      lines.on('line', line => {
        let frame: any;
        try { frame = JSON.parse(line); } catch { return; }
        if (frame.method) {
          if (frame.id !== undefined) {
            child.stdin.write(JSON.stringify({ id: frame.id, error: { code: -32601, message: 'This chat supports text and image answers. Ask clarifying questions in your reply.' } }) + '\n');
          } else this.emit('notification', frame);
          return;
        }
        const task = this.pending.get(frame.id);
        if (!task) return;
        clearTimeout(task.timer);this.pending.delete(frame.id);
        if (frame.error) task.reject(new Error(frame.error.message || '模型连接暂时中断，请重试。'));
        else task.resolve(frame.result);
      });
      await this.call('initialize', { clientInfo: { name: 'cloudcli_guest', version: '1.0.0' }, capabilities: { experimentalApi: true } });
      child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    })();
    try { await this.ready; } catch (error) { this.ready = null;throw error; }
  }

  private disconnected(): void {
    if (!this.child) return;
    this.child = null;this.ready = null;
    for (const task of this.pending.values()) { clearTimeout(task.timer);task.reject(new Error('模型连接已断开，请重试。')); }
    this.pending.clear();this.emit('disconnect');
  }

  call(method: string, params: unknown): Promise<any> {
    if (!this.child) return Promise.reject(new Error('模型连接正在准备。'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id);reject(new Error('模型响应超时，请重试。')); }, 60_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  close(): void { this.child?.kill('SIGTERM');this.disconnected(); }
}
