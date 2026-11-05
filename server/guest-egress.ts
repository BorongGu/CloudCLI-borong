import { readFile } from 'node:fs/promises';

import { createGuestEgressServer } from '@/modules/guest-chat/index.js';

const pinned = JSON.parse(await readFile('/run/guest-egress.json', 'utf8'));
createGuestEgressServer(pinned).listen(3128, '0.0.0.0', () => console.log('Guest OpenAI egress ready'));
