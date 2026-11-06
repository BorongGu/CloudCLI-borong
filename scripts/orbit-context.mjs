#!/usr/bin/env node
// One JSON/HTTP contract works from each harness's shell tool and from automation.
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
let requestId;
try {
  if (args.includes('--help')) {
    process.stdout.write('Usage: node orbit-context.mjs --connection <file> <prepare|outline|records|create|get|deliver|delivery|cancel|delete> < input.json\nConnection: {"url":"http://host:3001/api/context","apiKey":"..."} (or token for a browser JWT).\nprepare: {sessionId}; outline/records: {snapshotId,offset?,limit?,turn?,ref?};\ncreate: {snapshotId,scope,granularity,briefing,maxChars?}; get: {packageId};\nrecords also accepts {packageId,ref?,offset?,limit?}; deliver: {packageId,targetSessionId,instruction,mode?,requestId?}; delivery/cancel: {deliveryId}; delete: {snapshotId}.\n');
  } else {
    const flag = args.indexOf('--connection');
    if (flag < 0 || !args[flag + 1]) throw new Error('Provide --connection <file>; use --help for the operation contract.');
    const connection = JSON.parse(await readFile(args.splice(flag, 2)[1], 'utf8'));
    const operation = args[0];
    let raw = '';
    if (!process.stdin.isTTY) for await (const chunk of process.stdin) {
      raw += chunk;
      if (raw.length > 2_000_000) throw new Error('Input exceeds 2 MB.');
    }
    const input = raw.trim() ? JSON.parse(raw) : {};
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Input must be an object.');
    const id = key => {
      if (typeof input[key] !== 'string' || !input[key].trim()) throw new Error(`Provide ${key}.`);
      return encodeURIComponent(input[key]);
    };
    let endpoint; let method = 'GET'; let body;
    if (operation === 'prepare') { endpoint = '/prepare'; method = 'POST'; body = input; }
    else if (operation === 'outline') endpoint = `/snapshots/${id('snapshotId')}/outline`;
    else if (operation === 'records') endpoint = input.packageId ? `/packages/${id('packageId')}/records` : `/snapshots/${id('snapshotId')}/records`;
    else if (operation === 'create') { endpoint = '/packages'; method = 'POST'; body = input; }
    else if (operation === 'get') endpoint = `/packages/${id('packageId')}`;
    else if (operation === 'deliver') {
      endpoint = `/packages/${id('packageId')}/deliver`; method = 'POST';
      requestId = input.requestId || randomUUID(); body = { ...input, requestId }; delete body.packageId;
    } else if (operation === 'delete') {
      endpoint = `/snapshots/${id('snapshotId')}`; method = 'DELETE';
    } else if (operation === 'delivery' || operation === 'cancel') {
      endpoint = `/deliveries/${id('deliveryId')}`; method = operation === 'cancel' ? 'DELETE' : 'GET';
    } else throw new Error('Unknown operation. Use --help.');
    const url = new URL(String(connection.url).replace(/\/$/, '') + endpoint);
    if (method === 'GET') for (const field of ['offset', 'limit', 'turn', 'ref']) if (input[field] !== undefined) url.searchParams.set(field, String(input[field]));
    if (!connection.apiKey && !connection.token) throw new Error('The connection needs an Orbit apiKey or token.');
    const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...(connection.apiKey ? { 'x-api-key': connection.apiKey } : { Authorization: `Bearer ${connection.token}` }) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error?.message || result.error || `HTTP ${response.status}`);
    process.stdout.write(JSON.stringify(result.data) + '\n');
  }
} catch (error) {
  process.stderr.write(JSON.stringify({ error: error.message, ...(requestId ? { requestId, retry: 'Reuse this requestId with the same input.' } : {}) }) + '\n');
  process.exitCode = 1;
}
