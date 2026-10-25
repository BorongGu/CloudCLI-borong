import { EventEmitter } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: Record<string, any>;
  result?: any;
  error?: { code?: number; message?: string };
};

/** JSON-RPC transport used by the Codex runtime and its protocol tests. */
export class SharedCodexConnection extends EventEmitter {
  private socket: WebSocket | null = null;
  private opening: Promise<void> | null = null;
  private ready = false;
  private nextId = 0;
  private serverRequests = new Map<number | string, RpcMessage>();
  private pending = new Map<number, {
    resolve(value: any): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(private readonly socketPath = process.env.CODEX_APP_SERVER_SOCKET
    || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
      'app-server-control', 'app-server-control.sock')) {
    super();
    this.setMaxListeners(0);
  }

  private request(method: string, params: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, 60_000);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket!.send(JSON.stringify({ id, method, params })); }
      catch (error) {
        this.pending.delete(id); clearTimeout(timer); reject(error);
      }
    });
  }

  private receive(raw: WebSocket.RawData): void {
    let message: RpcMessage;
    try { message = JSON.parse(String(raw)) as RpcMessage; } catch { return; }
    if (message.method) {
      if (message.id !== undefined) this.serverRequests.set(message.id, message);
      if (message.method === 'serverRequest/resolved') this.serverRequests.delete(message.params?.requestId);
      this.emit(message.id === undefined ? 'notification' : 'serverRequest', message);
      return;
    }
    const pending = typeof message.id === 'number' ? this.pending.get(message.id) : null;
    if (!pending) return;
    this.pending.delete(message.id as number); clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message || 'Codex RPC failed'));
    else pending.resolve(message.result);
  }

  private disconnect(socket: WebSocket, error: Error): void {
    if (this.socket !== socket) return;
    this.socket = null; this.ready = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer); pending.reject(error);
    }
    this.pending.clear(); this.serverRequests.clear(); this.emit('disconnect', error);
  }

  async connect(): Promise<void> {
    if (this.ready && this.socket?.readyState === WebSocket.OPEN) return;
    if (this.opening) return this.opening;
    this.opening = (async () => {
      const socket = new WebSocket('ws://localhost/', {
        createConnection: () => net.createConnection(this.socketPath),
        handshakeTimeout: 10_000, maxPayload: 64 * 1024 * 1024,
      });
      this.socket = socket;
      socket.on('message', raw => this.receive(raw));
      socket.on('close', () => this.disconnect(socket, new Error('Codex app-server connection closed')));
      socket.on('error', error => this.disconnect(socket, error));
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve); socket.once('error', reject);
        socket.once('close', () => reject(new Error('Codex app-server closed during connection')));
      });
      await this.request('initialize', {
        clientInfo: { name: 'cloudcli_shared', title: 'CloudCLI', version: '1.37.5-shared.1' },
        capabilities: { experimentalApi: true },
      });
      socket.send(JSON.stringify({ method: 'initialized', params: {} }));
      this.ready = true;
    })();
    try { await this.opening; }
    catch (error) { this.socket?.terminate(); throw error; }
    finally { this.opening = null; }
  }

  async call(method: string, params: unknown): Promise<any> {
    await this.connect(); return this.request(method, params);
  }

  /** Used by the Codex question bridge to answer on the initiating connection. */
  respond(id: number | string, result: unknown): void {
    if (!this.ready || this.socket?.readyState !== WebSocket.OPEN) throw new Error('Codex connection is recovering. Retry your answer.');
    this.socket.send(JSON.stringify({ id, result }));
  }

  /** Replays native requests received before the runtime bound its app session. */
  pendingRequests(threadId: string) {
    return [...this.serverRequests.values()].filter(message => message.params?.threadId === threadId)
      .map(message => ({ id: message.id!, method: message.method!, params: message.params! }));
  }

  /** Releases the test/runtime transport while the shared daemon keeps running. */
  close(): void { this.socket?.close(); }
}

/** Shared by the thread runtime and goal API so native state changes reach live chats. */
export const sharedCodexConnection = new SharedCodexConnection();
