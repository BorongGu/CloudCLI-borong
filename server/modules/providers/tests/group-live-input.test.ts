import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createGroupPromptChannel } from '@/modules/providers/list/claude/claude-group-runtime.provider.js';
import { opencodeGroupRuntime } from '@/modules/providers/list/opencode/opencode-group-runtime.provider.js';
import type { ProviderRuntimeContext } from '@/shared/types.js';

test('Claude consumes group input through its held stream before the original prompt stream closes', async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const base = (async function* () {
    yield { type: 'user' as const, message: { role: 'user' as const, content: 'Initial task' }, parent_tool_use_id: null };
    await held;
  })();
  const channel = createGroupPromptChannel(base);
  const iterator = channel.stream[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.message.content, 'Initial task');
  const receiving = iterator.next();
  const accepted = channel.append('A finding from a peer');
  const injected = (await receiving).value!;
  assert.equal(injected.message.content, 'A finding from a peer');
  assert.equal(injected.priority, 'now');
  assert.equal(injected.isSynthetic, true);
  const next = iterator.next();
  await accepted;
  channel.close(); release();
  assert.equal((await next).done, true);
});

test('Claude preserves uncertainty when its stream closes before accepting queued input', async () => {
  const channel = createGroupPromptChannel((async function* () {})());
  const pending = assert.rejects(channel.append('Pending message'), /closed/);
  channel.close(); await pending;
});

for (const major of [1, 2]) {
  test(`OpenCode ${major} delivers authenticated native input while its attached CLI remains active`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'orbit-opencode-live-'));
    const prior = { PATH: process.env.PATH, ORBIT_TEST_MAJOR: process.env.ORBIT_TEST_MAJOR, ORBIT_TEST_TRACE: process.env.ORBIT_TEST_TRACE };
    const binary = path.join(root, 'opencode');
    await writeFile(binary, `#!${process.execPath}
const http = require('node:http'); const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log(process.env.ORBIT_TEST_MAJOR + '.0.0'); process.exit(0); }
if (args[0] === 'serve') {
 let done = false;
 const server = http.createServer(async (req,res) => {
  if (req.headers.authorization !== 'Basic '+Buffer.from('opencode:'+process.env.OPENCODE_SERVER_PASSWORD).toString('base64')) { res.writeHead(401).end(); return; }
  if (req.url.startsWith('/finish')) { res.end(JSON.stringify({ done })); return; }
  let body=''; for await (const chunk of req) body+=chunk;
  fs.writeFileSync(process.env.ORBIT_TEST_TRACE, JSON.stringify({ url:req.url, body:JSON.parse(body) }));
  done=true; res.writeHead(204).end();
 });
 server.listen(0,'127.0.0.1',()=>console.log('http://127.0.0.1:'+server.address().port));
} else if (args[0] === 'run') {
 const url=args[args.indexOf('--attach')+1];
 console.log(JSON.stringify({ type:'text',sessionID:'native-group',text:'working' }));
 const timer=setInterval(async()=>{
  const response=await fetch(url+'/finish',{headers:{Authorization:'Basic '+Buffer.from('opencode:'+process.env.OPENCODE_SERVER_PASSWORD).toString('base64')}});
  if ((await response.json()).done) { clearInterval(timer); process.exit(0); }
 },20);
}
`);
    await chmod(binary, 0o755);
    process.env.PATH = `${root}${path.delimiter}${prior.PATH}`;
    process.env.ORBIT_TEST_MAJOR = String(major);
    process.env.ORBIT_TEST_TRACE = path.join(root, 'trace.json');
    let ready!: () => void;
    const registered = new Promise<void>(resolve => { ready = resolve; });
    const context: ProviderRuntimeContext = {
      resolveProviderSessionId: () => null, resolveResumeModel: async () => 'test/model',
      getProviderModels: async () => ({ DEFAULT: 'test/model', OPTIONS: [] }), isProviderInstalled: async () => true,
      normalizeMessage: () => [],
    };
    const run = opencodeGroupRuntime.run('Initial task', { sessionId: 'group-live', cwd: root, groupSystemPrompt: 'Assess peers independently.' },
      { send: () => {}, setSessionId: () => ready() }, context);
    try {
      await Promise.race([registered, run.then(() => { throw new Error('Run finished before session registration'); })]);
      assert.equal((await opencodeGroupRuntime.steer!('group-live', 'A peer update')).status, 'accepted');
      await run;
      const trace = JSON.parse(await readFile(process.env.ORBIT_TEST_TRACE, 'utf8'));
      assert.ok(trace.url.startsWith(major >= 2 ? '/api/session/native-group/prompt' : '/session/native-group/prompt_async'));
      assert.equal(major >= 2 ? trace.body.text : trace.body.parts[0].text, 'A peer update');
      assert.equal((await opencodeGroupRuntime.steer!('group-live', 'Later')).status, 'idle');
    } finally {
      await opencodeGroupRuntime.abort('group-live');
      await run.catch(() => {});
      for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      await rm(root, { recursive: true, force: true });
    }
  });
}
