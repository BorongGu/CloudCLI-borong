import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { OpenCodeProviderAuth } from '@/modules/providers/list/opencode/opencode-auth.provider.js';
import { OpenCodeProviderModels } from '@/modules/providers/list/opencode/opencode-models.provider.js';
import { OpenCodeMcpProvider } from '@/modules/providers/list/opencode/opencode-mcp.provider.js';
import { opencodeRuntime } from '@/modules/providers/list/opencode/opencode-runtime.provider.js';
import { OpenCodeSessionSynchronizer } from '@/modules/providers/list/opencode/opencode-session-synchronizer.provider.js';
import { OpenCodeSessionsProvider } from '@/modules/providers/list/opencode/opencode-sessions.provider.js';
import { createProviderUsageService } from '@/modules/providers/services/provider-usage.service.js';
import type { AnyRecord, NormalizedMessage } from '@/shared/types.js';
import { getOpenCodeDatabasePath, openOpenCodeReadDatabase } from '@/shared/utils.js';

async function fixture(t: any) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-v2-compat-'));
  const previous = { ...process.env };
  process.env.XDG_DATA_HOME = root;
  process.env.OPENCODE_DB = 'custom.db';
  process.env.DATABASE_PATH = path.join(root, 'cloudcli.db');
  await mkdir(path.join(root, 'opencode'));
  const filename = getOpenCodeDatabasePath();
  const db = new Database(filename);
  db.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, parent_id TEXT, title TEXT,
      time_created INTEGER, time_updated INTEGER, time_archived INTEGER, model TEXT, agent TEXT,
      tokens_input INTEGER DEFAULT 10, tokens_output INTEGER DEFAULT 2, tokens_reasoning INTEGER DEFAULT 3,
      tokens_cache_read INTEGER DEFAULT 4, tokens_cache_write INTEGER DEFAULT 1);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
      time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE session_part (session_id TEXT, message_id TEXT, ordinal INTEGER, type TEXT, call_id TEXT,
      time_created INTEGER, time_updated INTEGER, data TEXT, PRIMARY KEY(message_id, ordinal));
    CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, active INTEGER, value TEXT);
    CREATE TABLE session (id TEXT PRIMARY KEY);
    INSERT INTO session VALUES ('legacy-ghost');
  `);
  db.prepare('INSERT INTO project VALUES (?, ?)').run('project', root);
  db.prepare(`INSERT INTO session_v2 (id, project_id, directory, title, time_created, time_updated, model)
    VALUES ('native', 'project', ?, 'V2 chat', 1000, 2000, ?)`).run(root, JSON.stringify({ id: 'test', providerID: 'opencode-go' }));
  const message = (id: string, type: string, data: AnyRecord, time = 1000) => db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'native', type, time, time, time, JSON.stringify(data));
  const part = (id: string, ordinal: number, data: AnyRecord, time = 1100) => db.prepare('INSERT INTO session_part VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('native', id, ordinal, data.type, data.id || null, time, time, JSON.stringify(data));
  t.after(async () => {
    db.close();closeConnection();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  });
  return { root, db, filename, message, part };
}

test('V2 completed and live history, ordinal ordering, indexing, model, credentials and quota share the native store', async t => {
  const f = await fixture(t);
  f.message('user', 'user', { text: 'hello', files: [] });
  const tool = { type: 'tool', id: 'call-1', name: 'bash', state: { status: 'completed', input: { command: 'pwd' },
    content: [{ type: 'text', text: '/workspace' }] }, time: { created: 1100, completed: 1200 } };
  const content = [...Array.from({ length: 12 }, (_, i) => ({ type: 'text', text: `line ${i}` })), tool];
  f.message('assistant', 'assistant', { content, model: { id: 'test', providerID: 'opencode-go' },
    tokens: { input: 10, output: 2, reasoning: 3, cache: { read: 4, write: 1 } } }, 2000);
  // A projection can still have pending rows while completed content has arrived.
  f.part('assistant', 0, content[0], 2000);
  f.message('pending', 'assistant', { model: { id: 'test', providerID: 'opencode-go' } }, 3000);
  f.part('pending', 0, { type: 'text', text: 'in progress' }, 3000);
  f.db.prepare('INSERT INTO kv VALUES (?, ?)').run('models-dev:v2:catalog', JSON.stringify({ body: JSON.stringify({ 'opencode-go': { models: { test: { limit: { context: 256000 } } } } }) }));
  f.db.prepare('INSERT INTO credential VALUES (?, ?, ?, ?)').run('active-go', 'opencode-go', 1, JSON.stringify({ type: 'key', key: 'fixture-secret' }));
  f.db.prepare('INSERT INTO credential VALUES (?, ?, ?, ?)').run('old-go', 'opencode-go', 0, JSON.stringify({ type: 'key', key: 'inactive-secret' }));

  closeConnection();await initializeDatabase();
  assert.equal(await new OpenCodeSessionSynchronizer().synchronize(), 1);
  assert.equal(sessionsDb.getSessionByProviderSessionId('native')?.custom_name, 'V2 chat');
  assert.equal(sessionsDb.getSessionByProviderSessionId('legacy-ghost'), null);
  const model = await new OpenCodeProviderModels().getCurrentActiveModel('native');
  assert.equal(model.model, 'opencode-go/test');
  assert.equal((await new OpenCodeProviderAuth().getStatus()).authenticated, true);

  const provider = new OpenCodeSessionsProvider();
  const history = await provider.fetchHistory('app', { providerSessionId: 'native' });
  assert.deepEqual(history.messages.filter(m => m.kind === 'text').map(m => m.content),
    ['hello', ...Array.from({ length: 12 }, (_, i) => `line ${i}`), 'in progress']);
  assert.equal((history.tokenUsage as AnyRecord)?.used, 20);
  const historyTool = history.messages.find(m => m.kind === 'tool_use')!;
  assert.equal(historyTool.toolName, 'bash');
  assert.equal(historyTool.toolId, 'call-1');
  assert.equal(historyTool.toolResult?.content, '/workspace');
  const live = provider.normalizeMessage({ type: 'tool_use', sessionID: 'native', part: {
    type: 'tool', partID: 'prt_event', id: 'call-1', messageID: 'assistant', tool: 'bash',
    state: { status: 'completed', input: { command: 'pwd' }, output: '/workspace' },
  } }, 'app')[0];
  assert.equal(live.id, historyTool.id);
  assert.equal(live.toolId, 'call-1');
  const liveText = provider.normalizeMessage({ type: 'text', part: { type: 'text', id: 'prt_text', messageID: 'assistant', text: 'line 10' } }, 'app')[0];
  assert.equal(liveText.id, history.messages.find(m => m.content === 'line 10')?.id);

  const service = createProviderUsageService({
    getSession: () => ({ provider: 'opencode', provider_session_id: 'native' }) as any,
    codexCall: async () => ({}), readJson: async () => ({}),
    fetch: async (_url, options) => {
      assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer fixture-secret');
      return new Response(JSON.stringify({ usage: { rolling: { percent: 70 } } }));
    },
  });
  const usage = await service.getUsage({ sessionId: 'app' });
  assert.equal(usage.context.used, 20);
  assert.equal(usage.context.limit, 256000);
  assert.equal(usage.context.model, 'opencode-go/test');
  assert.equal(usage.accounts.find(a => a.provider === 'opencode')?.windows[0].usedPercent, 70);
  assert.equal(JSON.stringify(usage).includes('secret'), false);
  assert.deepEqual(f.db.prepare('SELECT id FROM session').all(), [{ id: 'legacy-ghost' }]);
  assert.equal(f.db.prepare("SELECT name FROM sqlite_master WHERE name='message'").get(), undefined);
  process.env.OPENCODE_DB = f.filename;assert.equal(getOpenCodeDatabasePath(), f.filename);
});

test('V2 read views preserve native schemas and close cleanly across repeated opens', async t => {
  const { filename } = await fixture(t);
  for (let i = 0; i < 3; i++) {
    const db = openOpenCodeReadDatabase(filename);
    assert.deepEqual(db.prepare('SELECT id FROM session').all(), [{ id: 'native' }]);
    db.close();
  }
});

test('V2 CLI uses standalone/PWD, model variants, edited permission rules and owned abort', async t => {
  const f = await fixture(t);
  const capture = path.join(f.root, 'capture.json');
  const bin = path.join(f.root, 'bin');await mkdir(bin);
  const executable = path.join(bin, 'opencode');
  await writeFile(executable, `#!${process.execPath}
import fs from 'node:fs';
if (process.argv[2] === '--version') { console.log('opencode v2.2.5');process.exit(0); }
if (process.argv[2] === 'models') { console.log('custom/test');process.exit(0); }
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),pwd:process.env.PWD,config:JSON.parse(process.env.OPENCODE_CONFIG_CONTENT)}));
console.log(JSON.stringify({type:'text',sessionID:'native',part:{id:'part',messageID:'message',type:'text',text:'reply'}}));
if (process.argv.includes('hold')) setInterval(()=>{}, 1000);
`);
  await chmod(executable, 0o700);
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: 'custom/test', permissions: [{ action: 'bash', resource: '*', effect: 'ask' }] });
  const provider = new OpenCodeSessionsProvider();
  const context = { resolveProviderSessionId: () => 'native', resolveResumeModel: async () => 'custom/test',
    getProviderModels: async () => ({ DEFAULT: 'custom/test', OPTIONS: [{ value: 'custom/test', label: 'Test', effort: {
      values: [{ value: 'high', label: 'High' }], default: 'high', label: 'Effort' } }] }),
    normalizeMessage: (raw: unknown, id: string | null) => provider.normalizeMessage(raw, id), isProviderInstalled: async () => true };
  const messages: NormalizedMessage[] = [];
  const options = { sessionId: 'app', cwd: f.root, effort: 'high', permissionMode: 'acceptEdits' };
  await opencodeRuntime.run('hello', options, { send: e => messages.push(e as NormalizedMessage) }, context);
  const call = JSON.parse(await readFile(capture, 'utf8'));
  assert.deepEqual(call.args, ['run', '--format', 'json', '--standalone', '--session', 'native', '--model', 'custom/test#high', 'hello']);
  assert.equal(call.cwd, f.root);assert.equal(call.pwd, f.root);
  assert.deepEqual(call.config.permissions, [{ action: 'bash', resource: '*', effect: 'ask' }, { action: 'edit', resource: '*', effect: 'allow' }]);
  assert.equal(messages.filter(m => m.kind === 'complete').length, 1);
  assert.ok((await new OpenCodeProviderModels().getSupportedModels()).OPTIONS.some(m => m.value === 'custom/test'));
  messages.length = 0;
  const run = opencodeRuntime.run('hold', options, { send: e => messages.push(e as NormalizedMessage) }, context);
  const stopped = assert.rejects(run, /terminated/);
  try {
    for (let i = 0; i < 100 && !messages.some(m => m.content === 'reply'); i++) await new Promise(r => setTimeout(r, 20));
    assert.ok(messages.some(m => m.content === 'reply'));
  } finally { assert.equal(opencodeRuntime.abort('app'), true); }
  await stopped;
  assert.equal(messages.filter(m => m.kind === 'complete').length, 0);
});

test('V2 MCP edits preserve nested server configuration and shared options', async t => {
  const f = await fixture(t);
  const bin = path.join(f.root, 'bin');await mkdir(bin);
  const executable = path.join(bin, 'opencode');
  await writeFile(executable, `#!${process.execPath}\nconsole.log('opencode v2.2.5');\n`);
  await chmod(executable, 0o700);
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  process.env.OPENCODE_CONFIG_DIR = path.join(f.root, 'config');
  await mkdir(process.env.OPENCODE_CONFIG_DIR);
  const configPath = path.join(process.env.OPENCODE_CONFIG_DIR, 'opencode.json');
  await writeFile(configPath, JSON.stringify({ mcp: { timeout: { execution: 10000 }, servers: {} }, model: 'custom/test' }));
  const mcp = new OpenCodeMcpProvider();
  await mcp.upsertServer({ scope: 'user', name: 'local', transport: 'stdio', command: 'node', args: ['server.mjs'], workspacePath: f.root });
  await mcp.upsertServer({ scope: 'user', name: 'remote', transport: 'http', url: 'https://example.com/mcp', workspacePath: f.root });
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(config.model, 'custom/test');
  assert.deepEqual(config.mcp.timeout, { execution: 10000 });
  assert.deepEqual(config.mcp.servers.local, { type: 'local', command: ['node', 'server.mjs'], disabled: false, environment: {} });
  assert.deepEqual(config.mcp.servers.remote, { type: 'remote', url: 'https://example.com/mcp', disabled: false, headers: {} });
  assert.equal((await mcp.listServers({ workspacePath: f.root })).user.length, 2);
  await mcp.removeServer({ scope: 'user', name: 'local', workspacePath: f.root });
  const after = JSON.parse(await readFile(configPath, 'utf8'));
  assert.deepEqual(Object.keys(after.mcp.servers), ['remote']);
  assert.deepEqual(after.mcp.timeout, { execution: 10000 });
});
