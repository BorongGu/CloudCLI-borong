import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { OpenCodeBtwConnection } from '@/modules/providers/list/opencode/opencode-btw-connection.js';

async function fixture(slowExport = false) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-btw-fixture-'));
  const binary = path.join(cwd, 'opencode.mjs');
  await writeFile(binary, `#!${process.execPath}
import fs from 'node:fs';
import http from 'node:http';
const command = process.argv[2];
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
