import { readFile } from 'node:fs/promises';

import { createGuestChatService, createGuestServer } from '@/modules/guest-chat/index.js';

const credentials = JSON.parse(await readFile(process.env.GUEST_CREDENTIALS || '/run/guest-credentials.json', 'utf8'));
if (!credentials.username || !/^[a-f0-9]{64}$/.test(credentials.passwordHash) || credentials.sessionSecret?.length < 40) throw new Error('Guest credentials are incomplete.');
const service = await createGuestChatService('/data/chat');
void service.warm().catch(() => console.log('Guest model will reconnect on the next request.'));
const server = createGuestServer(service, credentials, '/app/public');
server.listen(3002, '0.0.0.0', () => console.log('Guest chat ready on port 3002'));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  server.close();void service.close().finally(() => process.exit(0));
});
