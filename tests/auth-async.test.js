/** Sign-in hashes the password off the event loop. loginAsync must answer exactly as login does, and it must
 * leave the loop free while the hash runs (a timer fires during the check). */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {SqliteStore} from '../src/sqlite-store.js';
import {Auth} from '../src/auth.js';

async function harness() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-auth-async-'));
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  const auth = new Auth(store);
  auth.ensureBootstrap('owner-secret-1');
  return {store, auth, dir};
}

test('loginAsync accepts the right password and refuses a wrong one, as login does', async () => {
  const {auth, store, dir} = await harness();
  try {
    const good = await auth.loginAsync({password: 'owner-secret-1'}, {ip: '127.0.0.1'});
    assert.equal(good.ok, true);
    assert.equal(typeof good.sessionId, 'string');
    const bad = await auth.loginAsync({password: 'wrong'});
    assert.deepEqual(bad, auth.login({password: 'wrong'}));
    assert.equal(bad.ok, false);
    const unknown = await auth.loginAsync({email: 'nobody@example.com', password: 'x'});
    assert.equal(unknown.status, 401);
    assert.equal(unknown.error, bad.error, 'an unknown address and a wrong password get the same answer');
  } finally {
    await store.close();
    await fs.rm(dir, {recursive: true, force: true});
  }
});

test('loginAsync leaves the event loop free while the password is checked', async () => {
  const {auth, store, dir} = await harness();
  try {
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 1);
    try {
      await auth.loginAsync({password: 'owner-secret-1'});
      assert.ok(ticks >= 1, 'a timer fired while the hash was being checked');
    } finally { clearInterval(timer); }
  } finally {
    await store.close();
    await fs.rm(dir, {recursive: true, force: true});
  }
});
