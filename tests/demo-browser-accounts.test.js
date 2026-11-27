// The Pages demo has no computer, so no browser account: it lists none and refuses a change, in the sentence the server's demo uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {installWebLocks} from './web-locks.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const map = new Map();
globalThis.window = globalThis.window || {};
Object.defineProperty(globalThis, 'localStorage', {configurable: true, value: {getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value))}});
installWebLocks();
await import(path.join(root, 'shared/local-api.js'));

const SENTENCE = 'The demo has no computer to keep browser accounts on. Run the full app with the local agent to use them.';

test('the demo lists no browser account and refuses to add, change or delete one', async () => {
  const request = globalThis.window.AGENT_LOCAL_API;
  assert.deepEqual(await request('/api/browser-accounts'), {accounts: [], demo: true});
  for (const [url, method] of [['/api/browser-accounts', 'POST'], ['/api/browser-accounts/0a1b2c3d-1111-4222-8333-444455556666', 'PATCH'], ['/api/browser-accounts/0a1b2c3d-1111-4222-8333-444455556666', 'DELETE']]) {
    await assert.rejects(request(url, method, {}), e => e.status === 409 && e.message === SENTENCE, `${method} ${url}`);
  }
});
