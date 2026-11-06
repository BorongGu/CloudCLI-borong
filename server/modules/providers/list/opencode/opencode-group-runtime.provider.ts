import { randomBytes } from 'node:crypto';

import crossSpawn from 'cross-spawn';

import { opencodeRuntime } from '@/modules/providers/list/opencode/opencode-runtime.provider.js';
import { getOpenCodeMajorVersion } from '@/shared/utils.js';
import type { IProviderRuntime } from '@/shared/interfaces.js';

type LiveSession = { url: string; password: string; cwd: string; nativeId: string | null; major: number };
const sessions = new Map<string, LiveSession>();

/** OpenCodeProvider uses an owned native server for group input while retaining its normal CLI event stream. */
export const opencodeGroupRuntime: IProviderRuntime = {
  ...opencodeRuntime,
  async steer(sessionId, content) {
    const session = sessions.get(sessionId);
    if (!session?.nativeId || !session.url) return { status: 'idle' };
    const pathname = session.major >= 2 ? `/api/session/${encodeURIComponent(session.nativeId)}/prompt`
      : `/session/${encodeURIComponent(session.nativeId)}/prompt_async`;
    const url = new URL(pathname, session.url); url.searchParams.set('directory', session.cwd);
    const response = await fetch(url, { method: 'POST', headers: {
      Authorization: `Basic ${Buffer.from(`opencode:${session.password}`).toString('base64')}`, 'Content-Type': 'application/json',
    }, body: JSON.stringify(session.major >= 2 ? { text: content } : { parts: [{ type: 'text', text: content }] }), signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`OpenCode live input failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
    await response.body?.cancel();
    return { status: 'accepted' };
  },
  async run(command, options, writer, context) {
    if (!options.groupSystemPrompt || typeof options.sessionId !== 'string') return opencodeRuntime.run(command, options, writer, context);
    const sessionId = options.sessionId;
    const cwd = String(options.cwd || options.projectPath || process.cwd());
    const state: LiveSession = { url: '', password: randomBytes(24).toString('hex'), cwd,
      nativeId: context.resolveProviderSessionId(sessionId), major: getOpenCodeMajorVersion() };
    const child = crossSpawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
      cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PWD: cwd, OPENCODE_SERVER_PASSWORD: state.password },
    });
    child.stderr?.resume();
    try {
      await new Promise<void>((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error('OpenCode group server startup timed out.')), 30_000);
        child.stdout?.on('data', chunk => {
          output = (output + String(chunk)).slice(-4000);
          const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
          if (match) { state.url = match[0]; clearTimeout(timer); resolve(); }
        });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', () => { clearTimeout(timer); reject(new Error('OpenCode group server exited.')); });
      });
      sessions.set(sessionId, state);
      const observed = new Proxy(writer, {
        get(target, key) {
          if (key === 'setSessionId') return (id: string) => { state.nativeId = id; target.setSessionId?.(id); };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      return await opencodeRuntime.run(`${options.groupSystemPrompt}\n\n${command}`, {
        ...options, groupAttachUrl: state.url, groupServerPassword: state.password,
      }, observed, context);
    } finally {
      if (sessions.get(sessionId) === state) sessions.delete(sessionId);
      child.kill('SIGTERM');
    }
  },
};
