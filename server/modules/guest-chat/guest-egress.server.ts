import { lookup } from 'node:dns/promises';
import { createServer } from 'node:http';
import { connect } from 'node:net';

const ALLOWED = new Set(['chatgpt.com', 'auth.openai.com', 'api.openai.com', 'ab.chatgpt.com']);

/** Egress startup and tests share an exact authority allowlist; only public IPv4 destinations are accepted. */
export function allowedGuestDestination(authority: string, address: string, pinned: Record<string, string[]> = {}): boolean {
  if (!ALLOWED.has(authority.replace(/:443$/, '')) || !authority.endsWith(':443')) return false;
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  // Some deployments resolve OpenAI through a private model gateway. An operator
  // pins that exact host/address pair; it grants no general private-network access.
  if (pinned[authority.replace(/:443$/, '')]?.includes(address)) return true;
  const [a, b] = octets;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0))
    || (a === 198 && [18, 19].includes(b)));
}

/** A separate container exposes only CONNECT to OpenAI, with no credentials or company data mounted. */
export function createGuestEgressServer(pinned: Record<string, string[]> = {}) {
  const server = createServer((_req, res) => { res.writeHead(403);res.end(); });
  server.on('connect', (req, socket, head) => {
    socket.on('error', () => {});
    void (async () => {
      const authority = req.url || '';
      const host = authority.replace(/:443$/, '');
      if (!ALLOWED.has(host) || !authority.endsWith(':443')) throw new Error('Destination denied');
      const addresses = pinned[host]?.length ? pinned[host].map(address => ({ address })) : await lookup(host, { family: 4, all: true });
      const target = addresses.find(item => allowedGuestDestination(authority, item.address, pinned));
      if (!target) throw new Error('Destination denied');
      const upstream = connect({ host: target.address, port: 443 });
      upstream.setTimeout(300_000, () => upstream.destroy());
      upstream.on('error', () => socket.destroy());socket.once('close', () => upstream.destroy());
      upstream.once('connect', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(socket);socket.pipe(upstream);
      });
    })().catch(() => { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); });
  });
  return server;
}
