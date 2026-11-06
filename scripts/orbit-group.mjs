#!/usr/bin/env node
// Provider-neutral group primitives. Each connection file is scoped to one member.
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const flag = args.indexOf('--connection');
let requestId;
try {
  if (flag < 0 || !args[flag + 1]) throw new Error('Usage: orbit-group --connection <file> <send|publish|request|reply|read> < input.json');
  const file = args.splice(flag, 2)[1];
  const operation = args[0];
  if (!['send', 'publish', 'request', 'reply', 'read'].includes(operation)) throw new Error('Choose send, publish, request, reply, or read.');
  let raw = '';
  if (!process.stdin.isTTY) {
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (raw.length > 100_000) throw new Error('Input exceeds 100 KB.');
    }
  }
  const input = raw.trim() ? JSON.parse(raw) : {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Input must be a JSON object.');
  if (operation !== 'read') {
    requestId = input.requestId || randomUUID();
    input.requestId = requestId;
  }
  const connection = JSON.parse(await readFile(file, 'utf8'));
  const response = await fetch(`${connection.url}/${operation}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` },
    body: JSON.stringify(input), signal: AbortSignal.timeout(20_000),
  });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(result.error?.message || `Group request failed (${response.status}).`);
  process.stdout.write(JSON.stringify({ ...result.data, ...(requestId ? { requestId } : {}) }) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ error: error.message, ...(requestId ? { requestId, retry: 'Reuse this requestId with the same operation and content.' } : {}) }) + '\n');
  process.exitCode = 1;
}
