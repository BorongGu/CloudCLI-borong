import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { OpenCodeBtwConnection } from '@/modules/providers/list/opencode/opencode-btw-connection.js';

async function fixture(slowExport = false) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-btw-fixture-'));
  const binary = path.join(cwd, 'opencode.mjs');
  await writeFile(binary, `#!${process.execPath}
import fs from 'node:fs';
import http from 'node:http';
const command = process.argv[2];
if (command === '--version') { console.log('1.18.32');process.exit(0); }
fs.appendFileSync('audit.jsonl', JSON.stringify({ command, pid: process.pid, data: process.env.XDG_DATA_HOME }) + '\\n');
if (command === 'export') {
  ${slowExport ? "setInterval(() => {}, 1000);" : "process.stdout.write(JSON.stringify({ info: { id: 'source' }, messages: [] }));"}
} else if (command === 'import') {
  if (!JSON.parse(fs.readFileSync(process.argv[3])).info) process.exit(2);
} else if (command === 'serve') {
  const authorization = 'Basic ' + Buffer.from('opencode:' + process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
  const server = http.createServer((request, response) => {
    if (request.headers.authorization !== authorization) { response.writeHead(401).end();return; }
    if (request.url.startsWith('/event')) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: invalid-keepalive\\n\\n');
      response.write('data: ' + JSON.stringify({ type: 'server.connected', properties: {} }) + '\\n\\n');
    } else if (request.url.startsWith('/session/source/fork')) response.end(JSON.stringify({ id: 'private-fork' }));
    else response.writeHead(204).end();
  });
  server.listen(0, '127.0.0.1', () => console.log('opencode server listening on http://127.0.0.1:' + server.address().port));
}
`);
  await chmod(binary, 0o700);
  return { cwd, client: new OpenCodeBtwConnection('source', cwd, binary),
    audit: async () => (await readFile(path.join(cwd, 'audit.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)) };
}

test('OpenCode owns an isolated data store and reaps its server and files on close', async () => {
  const { cwd, client, audit } = await fixture();
  try {
    const events: any[] = [];client.on('notification', event => events.push(event));
    assert.deepEqual(await client.initialize(), { id: 'private-fork' });
    assert.ok(events.some(event => event.type === 'server.connected'));
    const commands = await audit();assert.deepEqual(commands.map(item => item.command), ['export', 'import', 'serve']);
    assert.equal(commands[1].data, commands[2].data);assert.notEqual(commands[0].data, commands[1].data);
    const temporaryRoot = path.dirname(commands[1].data);await access(temporaryRoot);
    await client.close();await client.close();
    await assert.rejects(access(temporaryRoot), /ENOENT/);
    assert.throws(() => process.kill(commands[2].pid, 0), /ESRCH/);
  } finally { await client.close();await rm(cwd, { recursive: true, force: true }); }
});

test('closing during OpenCode export reaps preparation and removes its private directory', async () => {
  const { cwd, client, audit } = await fixture(true);
  try {
    const initializing = client.initialize();const failure = assert.rejects(initializing);
    let commands: any[] = [];
    for (let count = 0; count < 100 && commands.length === 0; count++) {
      try { commands = await audit(); } catch { /* Wait for the fixture to enter export. */ }
      if (!commands.length) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(commands[0]?.command, 'export');
    await client.close();await failure;
    assert.throws(() => process.kill(commands[0].pid, 0), /ESRCH/);
    assert.equal((await audit()).length, 1);
  } finally { await client.close();await rm(cwd, { recursive: true, force: true }); }
});

test('V2 private BTW translates API routes, event envelopes, permission replies, form dismissal and interruption', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-btw-v2-'));
  const previousDb = process.env.OPENCODE_DB;
  const source = path.join(cwd, 'source.db');
  const db = new Database(source);
  db.exec("CREATE TABLE sentinel (value TEXT);INSERT INTO sentinel VALUES ('source');");db.close();
  process.env.OPENCODE_DB = source;
  const binary = path.join(cwd, 'opencode.mjs');
  await writeFile(binary, `#!${process.execPath}
import fs from 'node:fs';import http from 'node:http';
if(process.argv[2]==='--version'){console.log('opencode v2.2.5');process.exit(0);}
fs.writeFileSync('env.json',JSON.stringify({pwd:process.env.PWD,db:process.env.OPENCODE_DB,pid:process.pid}));
let stream;
const event=(type,data)=>stream.write('data: '+JSON.stringify({type,data})+'\\n\\n');
const server=http.createServer((req,res)=>{
  if(req.headers.authorization!=='Basic '+Buffer.from('opencode:'+process.env.OPENCODE_PASSWORD).toString('base64')){res.writeHead(401).end();return;}
  const url=new URL(req.url,'http://localhost').pathname;
  if(url==='/api/event'){stream=res;res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: {}\\n\\n');return;}
  let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
    fs.appendFileSync('requests.jsonl',JSON.stringify({method:req.method,url,body:body?JSON.parse(body):null})+'\\n');
    if(url==='/api/session/source/fork'){res.end(JSON.stringify({data:{id:'fork'}}));return;}
    if(url==='/api/experimental/session/fork/export'){res.end(JSON.stringify({data:{id:'fork'},messages:[{id:'inherited',type:'assistant'}]}));return;}
    if(url==='/api/session/fork/prompt'){
      const base={sessionID:'fork',assistantMessageID:'message',ordinal:0};
      event('session.execution.started',{sessionID:'fork'});
      event('session.text.started',base);event('session.text.delta',{...base,delta:'hello'});event('session.text.ended',{...base,text:'hello'});
      event('permission.asked',{id:'perm',sessionID:'fork'});
      event('form.created',{form:{id:'form',sessionID:'fork'}});
      event('session.step.failed',{...base,error:{type:'ProviderError',message:'at capacity'}});
      event('session.execution.succeeded',{sessionID:'fork'});
    }
    res.end(JSON.stringify({data:{}}));
  });
});server.listen(0,'127.0.0.1',()=>console.log('server listening on http://127.0.0.1:'+server.address().port));
`);
  await chmod(binary, 0o700);
  const client = new OpenCodeBtwConnection('source', cwd, binary);
  const events: any[] = [];client.on('notification', event => events.push(event));
  try {
    assert.deepEqual(await client.initialize(), { id: 'fork' });
    assert.deepEqual(await client.request('GET', '/session/fork/message'), [{ info: { id: 'inherited', role: 'assistant' } }]);
    await client.request('POST', '/session/fork/prompt_async', {
      model: { providerID: 'custom', modelID: 'test' }, variant: 'high', agent: 'plan', system: 'Side conversation', parts: [{ type: 'text', text: 'hello' }],
    });
    for (let n = 0; n < 100 && !events.some(e => e.type === 'question.asked'); n++) await new Promise(r => setTimeout(r, 10));
    await client.request('POST', '/permission/perm/reply', { reply: 'once' });
    await client.request('POST', '/question/form/reject');
    await client.request('POST', '/session/fork/abort');
    const requests = (await readFile(path.join(cwd, 'requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(requests.slice(2), [
      { method: 'POST', url: '/api/session/fork/model', body: { model: { id: 'test', providerID: 'custom', variant: 'high' } } },
      { method: 'POST', url: '/api/session/fork/agent', body: { agent: 'plan' } },
      { method: 'POST', url: '/api/session/fork/prompt', body: { text: 'Side conversation\n\nhello' } },
      { method: 'POST', url: '/api/session/fork/permission/perm/reply', body: { decision: 'once' } },
      { method: 'DELETE', url: '/api/session/fork/form/form', body: null },
      { method: 'POST', url: '/api/session/fork/interrupt', body: {} },
    ]);
    assert.deepEqual(events.filter(e => e.type === 'session.status').map(e => e.properties.status.type), ['busy', 'idle']);
    assert.equal(events.filter(e => e.type === 'message.part.updated').at(-1)?.properties.part.text, 'hello');
    assert.equal(events.find(e => e.type === 'session.error')?.properties.error.message, 'at capacity');
    const env = JSON.parse(await readFile(path.join(cwd, 'env.json'), 'utf8'));
    assert.equal(env.pwd, cwd);assert.notEqual(env.db, source);
    const copy = new Database(env.db, { readonly: true });
    assert.deepEqual(copy.prepare('SELECT * FROM sentinel').all(), [{ value: 'source' }]);copy.close();
    await client.close();await assert.rejects(access(env.db), /ENOENT/);
    assert.throws(() => process.kill(env.pid, 0), /ESRCH/);
    await access(source);
  } finally {
    await client.close();
    if (previousDb === undefined) delete process.env.OPENCODE_DB;else process.env.OPENCODE_DB = previousDb;
    await rm(cwd, { recursive: true, force: true });
  }
});
