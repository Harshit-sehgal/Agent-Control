import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {SqliteStore} from '../src/sqlite-store.js';
import {Auth, DEFAULT_WORKSPACE} from '../src/auth.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function harness() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-auth-'));
  const db = path.join(dir, 'state.db');
  const store = await new SqliteStore(db, path.join(dir, 'state.json')).init();
  const auth = new Auth(store);
  return {dir, store, auth};
}

test('first boot bootstraps exactly one owner account bound to the default workspace', async () => {
  const {store, auth, dir} = await harness();
  auth.ensureBootstrap('owner-secret-1');
  auth.ensureBootstrap('different-password'); // idempotent
  assert.equal(store.get('SELECT count(*) AS n FROM users').n, 1);
  const member = store.get('SELECT role FROM workspace_members WHERE workspace_id=?', DEFAULT_WORKSPACE);
  assert.equal(member.role, 'owner');
  assert.equal(store.get('SELECT count(*) AS n FROM workspaces').n, 1);
  await fs.rm(dir, {recursive: true, force: true});
});

test('login, sessions, expiry and revocation behave like real credentials', async () => {
  const {store, auth, dir} = await harness();
  auth.ensureBootstrap('owner-secret-1');
  const bad = auth.login({password: 'wrong'});
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 401);
  const good = auth.login({password: 'owner-secret-1', ip: '127.0.0.1'});
  assert.equal(good.ok, true);
  assert.equal(good.role, 'owner');
  const session = auth.session(good.sessionId);
  assert.equal(session.email, 'owner@localhost');
  assert.equal(auth.session('not-a-session'), null);
  assert.equal(auth.listSessions(good.user.id).length, 1);
  auth.logout(good.sessionId);
  assert.equal(auth.session(good.sessionId), null, 'Logout must invalidate the session.');
  // Expiry is enforced, not just recorded.
  const again = auth.login({password: 'owner-secret-1'}).sessionId;
  const handle = auth.session(again).sessionId;
  assert.notEqual(handle, again, 'The table must hold a hash of the session id, never the id the cookie carries.');
  assert.equal(store.get('SELECT count(*) AS n FROM sessions WHERE id=?', again).n, 0);
  assert.equal(auth.session(handle), null, 'A stored handle must not work as a login.');
  assert.equal(auth.listSessions(good.user.id).some(s => s.id === again), false, 'The sessions list must not expose live tokens.');
  store.run('UPDATE sessions SET expires_at=? WHERE id=?', new Date(Date.now() - 1000).toISOString(), handle);
  assert.equal(auth.session(again), null);
  // An unknown address and a wrong password are indistinguishable.
  const unknown = auth.login({email: 'nobody@example.com', password: 'x'}), wrong = auth.login({password: 'x'});
  assert.deepEqual({status: unknown.status, error: unknown.error}, {status: wrong.status, error: wrong.error});
  assert.equal(unknown.status, 401);
  await fs.rm(dir, {recursive: true, force: true});
});

test('a password change revokes every other session', async () => {
  const {auth, dir} = await harness();
  auth.ensureBootstrap('owner-secret-1');
  const owner = auth.login({password: 'owner-secret-1'});
  const a = owner.sessionId;
  const b = auth.login({password: 'owner-secret-1'}).sessionId;
  assert.throws(() => auth.changePassword('00000000-0000-0000-0000-000000000000', 'owner-secret-1', 'brand-new-pass'), /not found/);
  assert.throws(() => auth.changePassword(owner.userId, 'wrong', 'brand-new-pass'), /incorrect/);
  auth.changePassword(owner.userId, 'owner-secret-1', 'brand-new-pass');
  assert.equal(auth.session(a), null, 'The old session must be revoked after a password change.');
  assert.equal(auth.session(b), null);
  assert.equal(auth.login({password: 'owner-secret-1'}).ok, false, 'The old password must stop working.');
  assert.equal(auth.login({password: 'brand-new-pass'}).ok, true);
  await fs.rm(dir, {recursive: true, force: true});
});

test('reset tokens are single-use, time-limited and never reveal account existence', async () => {
  const {auth, dir} = await harness();
  auth.ensureBootstrap('owner-secret-1');
  assert.equal(auth.requestPasswordReset('nobody@example.com'), null);
  const token = auth.requestPasswordReset('owner@localhost');
  assert.ok(token);
  assert.throws(() => auth.consumePasswordReset(token, 'short'), /8 characters/);
  auth.consumePasswordReset(token, 'reset-pass-123');
  assert.equal(auth.login({password: 'reset-pass-123'}).ok, true);
  assert.throws(() => auth.consumePasswordReset(token, 'another-pass'), /not valid/);
  // A fresh request invalidates the previous outstanding token.
  const stale = auth.requestPasswordReset('owner@localhost');
  auth.requestPasswordReset('owner@localhost');
  assert.throws(() => auth.consumePasswordReset(stale, 'later-pass-1'), /not valid/);
  await fs.rm(dir, {recursive: true, force: true});
});

test('role escalation is impossible in every direction', async () => {
  const {auth, dir} = await harness();
  auth.ensureBootstrap('owner-secret-1');
  const owner = auth.login({password: 'owner-secret-1'});
  const member = auth.createUser(owner, {email: 'member@example.com', password: 'member-pass-1', role: 'member'});
  assert.equal(member.role, 'member');
  const memberSession = auth.login({email: 'member@example.com', password: 'member-pass-1'});
  // A member cannot invite, cannot create equal-or-higher roles, and cannot touch admins.
  assert.throws(() => auth.createUser(memberSession, {email: 'x@example.com', password: 'x-password-1'}), /Only admins/);
  assert.throws(() => auth.createUser(memberSession, {email: 'x@example.com', password: 'x-password-1', role: 'viewer'}), /Only admins/);
  const admin = auth.createUser(owner, {email: 'admin@example.com', password: 'admin-pass-1', role: 'admin'});
  const adminSession = auth.login({email: 'admin@example.com', password: 'admin-pass-1'});
  const dupe = auth.createUser(owner, {email: 'dupe@example.com', password: 'dupe-password', role: 'member'});
  assert.throws(() => auth.createUser(owner, {email: 'dupe@example.com', password: 'another-pass', role: 'member'}), /already/);
  assert.throws(() => auth.createUser(adminSession, {email: 'boss@example.com', password: 'boss-password-1', role: 'owner'}), /at or above/);
  assert.throws(() => auth.createUser(adminSession, {email: 'not-an-email', password: 'boss-password-1', role: 'viewer'}), /valid email/);
  const viewer = auth.createUser(adminSession, {email: 'viewer@example.com', password: 'viewer-pass-1', role: 'viewer'});
  const viewerSession = auth.login({email: 'viewer@example.com', password: 'viewer-pass-1'});
  // Admin can change a lower role, cannot touch the owner, cannot self-disable.
  assert.throws(() => auth.updateUser(adminSession, owner.user.id, {role: 'viewer'}), /at or above/);
  assert.throws(() => auth.updateUser(adminSession, admin.id, {disabled: true}), /own account/);
  auth.updateUser(adminSession, viewer.id, {disabled: true});
  assert.equal(auth.session(viewerSession.sessionId), null, 'Disabling a user revokes their sessions.');
  const users = auth.listUsers();
  assert.deepEqual(users.map(u => u.email).sort(), ['admin@example.com', 'dupe@example.com', 'member@example.com', 'owner@localhost', 'viewer@example.com']);
  assert.throws(() => auth.deleteUser(adminSession, adminSession.userId), /account deletion/);
  assert.throws(() => auth.deleteUser(adminSession, owner.user.id), /at or above/);
  auth.deleteUser(adminSession, viewer.id);
  assert.equal(auth.listUsers().some(u => u.id === viewer.id), false);
  await fs.rm(dir, {recursive: true, force: true});
});

test('self account deletion requires the password and wipes the account', async () => {
  const {auth, dir} = await harness();
  auth.ensureBootstrap('owner-secret-1');
  const session = auth.login({password: 'owner-secret-1'});
  assert.throws(() => auth.selfDeleteAccount(session.userId, 'wrong-password'), /incorrect/);
  auth.selfDeleteAccount(session.userId, 'owner-secret-1');
  assert.equal(auth.session(session.sessionId), null);
  assert.equal(auth.listUsers().length, 0);
  // A fresh bootstrapped owner can be created again afterwards.
  auth.ensureBootstrap('fresh-owner-1');
  assert.equal(auth.login({password: 'fresh-owner-1'}).ok, true);
  await fs.rm(dir, {recursive: true, force: true});
});

test('the API enforces the role matrix on every protected route', {timeout: 30000}, async () => {
  const {spawn} = await import('node:child_process');
  const net = await import('node:net');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-auth-api-'));
  const port = await new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); });
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {...process.env, AGENT_SKIP_DOTENV: '1', AI_API_KEY: '', OPENAI_API_KEY: '', AI_BASE_URL: '', DASHBOARD_PASSWORD: 'owner-secret-1', HOST: '127.0.0.1', PORT: String(port), DATA_FILE: path.join(dir, 'state.json')},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const wait = async () => { for (let i = 0; i < 90; i++) { if (child.exitCode !== null) return false; try { if ((await fetch(base + '/api/health')).ok) return true; } catch {} await new Promise(r => setTimeout(r, 70)); } return false; };
  try {
    assert.equal(await wait(), true);
    const send = async (method, url, body, cookie) => {
      const r = await fetch(base + url, {method, headers: {'Content-Type': 'application/json', ...(cookie ? {Cookie: cookie} : {})}, body: body === undefined ? undefined : JSON.stringify(body)});
      const value = await r.json().catch(() => null);
      return {status: r.status, body: value, cookie: r.headers.get('set-cookie')};
    };
    const ownerCookie = (await send('POST', '/api/login', {password: 'owner-secret-1'})).cookie.split(';')[0];
    assert.equal((await send('GET', '/api/me', undefined, ownerCookie)).body.role, 'owner');
    assert.equal((await send('POST', '/api/users', {email: 'viewer@example.com', password: 'viewer-pass-1', role: 'viewer'}, ownerCookie)).status, 201);
    assert.equal((await send('POST', '/api/users', {email: 'member@example.com', password: 'member-pass-1', role: 'member'}, ownerCookie)).status, 201);
    const viewerCookie = (await send('POST', '/api/login', {email: 'viewer@example.com', password: 'viewer-pass-1'})).cookie.split(';')[0];
    const memberCookie = (await send('POST', '/api/login', {email: 'member@example.com', password: 'member-pass-1'})).cookie.split(';')[0];
    // A viewer can read but not write.
    assert.equal((await send('GET', '/api/state', undefined, viewerCookie)).status, 200);
    assert.equal((await send('POST', '/api/candidates', {url: 'https://x.com/a/status/1', text: 'A candidate long enough to pass validation.', author: 'A'}, viewerCookie)).status, 403);
    assert.equal((await send('GET', '/api/users', undefined, viewerCookie)).status, 403);
    // A member can write but not administer users.
    const created = await send('POST', '/api/candidates', {url: 'https://x.com/a/status/2', text: 'Another candidate long enough to pass.', author: 'B'}, memberCookie);
    assert.equal(created.status, 201);
    assert.equal((await send('GET', '/api/users', undefined, memberCookie)).status, 403);
    // Sessions can be listed and revoked individually.
    const sessions = (await send('GET', '/api/sessions', undefined, memberCookie)).body.sessions;
    assert.equal(sessions.length, 1);
    const revoke = await send('DELETE', `/api/sessions/${sessions[0].id}`, undefined, memberCookie);
    assert.equal(revoke.status, 200);
    assert.equal((await send('GET', '/api/state', undefined, memberCookie)).status, 401, 'A revoked session must stop authenticating.');
    // The account survives revocation of sessions (it is a different concern).
    const reLogin = await send('POST', '/api/login', {email: 'member@example.com', password: 'member-pass-1'});
    assert.equal(reLogin.status, 200);
    // Public auth routes answer identically for unknown addresses.
    const forgot = await send('POST', '/api/auth/forgot', {email: 'nobody@example.com'});
    assert.equal(forgot.status, 200);
    assert.deepEqual(forgot.body, {ok: true});
    assert.equal((await send('POST', '/api/auth/reset', {token: 'bogus', password: 'new-password-1'})).status, 400);
  } finally { child.kill('SIGINT'); await new Promise(r => child.once('exit', r)); await fs.rm(dir, {recursive: true, force: true}); }
});
