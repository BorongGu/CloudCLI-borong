#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store, fingerprint } from './store.js';
import { Router } from './router.js';

const store = new Store();
async function main() {
  const [command = 'help', argument, ...rest] = process.argv.slice(2);
  if (command === 'add') {
    if (!argument || !rest.includes('--key-stdin')) throw new Error('Usage: opencode-go-router add LABEL --key-stdin');
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    const key = Buffer.concat(chunks).toString('utf8');
    console.log('Added account:', await store.add(argument, key)); return;
  }
  if (command === 'import-current') {
    const authFile = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode', 'auth.json');
    const auth = JSON.parse(await readFile(authFile, 'utf8')) as Record<string, { type: string; key?: string }>;
    const current = auth['opencode-go'];
    if (current?.type !== 'api' || !current.key) throw new Error('Connect OpenCode Go first.');
    console.log('Imported account:', await store.add(argument || 'Primary Go', current.key)); return;
  }
  if (['enable', 'disable', 'remove'].includes(command)) {
    if (!argument) throw new Error('Specify the account id or label.');
    await store.change(argument, command as 'enable' | 'disable' | 'remove'); console.log('Account updated.'); return;
  }
  if (command === 'prefer') {
    if (!argument) throw new Error('Specify the account id or label.');
    await store.prefer(argument); console.log('Preferred account updated for new sessions.'); return;
  }
  if (['list', 'status', 'quota'].includes(command)) {
    if (command === 'quota') await new Router(store).refreshQuotas(true);
    const state = await store.snapshot();
    console.log(JSON.stringify({ accounts: state.accounts.slice().sort((a, b) => a.priority - b.priority).map(({ apiKey, ...account }) => ({
      ...account, fingerprint: fingerprint(apiKey), quota: state.quotas[account.id] || null,
      cooldowns: state.blocks[account.id] || {},
    })), recentSwitches: state.events.slice(-15) }, null, 2)); return;
  }
  console.log('OpenCode Go account router\n\nCommands:\n  import-current [LABEL]\n  add LABEL --key-stdin\n  list | quota | status\n  prefer ID\n  enable ID | disable ID | remove ID\n\nPrivate state directory: OPENCODE_GO_ROUTER_HOME or ~/.config/opencode-go-router');
}
main().catch(() => { console.error('Go router command failed. Check arguments, account labels and state file.'); process.exitCode = 1; });
