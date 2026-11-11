/** Google sign-in for Gmail and Drive (Phase 6, Task 3): OAuth 2.0 with PKCE, run by the server.
 *
 * Against a fake Google on a local port, through the real dispatcher. What is
 * proved: the redirect comes from config, a tampered, reused or expired state is
 * refused without a token request, a reused code is refused, the refresh token
 * and client secret live only in the vault, a refresh that Google rejects turns
 * the connector to `reconnect`, and no secret is ever returned, logged or backed up.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {exportBackup} from '../src/backup.js';
import {googleFlows, googleAccessToken, GOOGLE_SCOPES} from '../src/google.js';
import {envelopeConnectors} from '../shared/connectors.js';
import {CLIENT, ACCOUNT} from './google-fixture.js';
import {rig, setup, start, finish, connect} from './google-rig.js';

test('setup keeps the client in the vault only, and only the owner can save it', async t => {
  const r = await rig(t);
  const out = await setup(r);
  assert.equal(out.status, 200);
  assert.equal(out.body.configured, true);
  assert.equal(out.body.redirectUri, 'https://bots.example.com/api/connectors/google/callback');
  const state = JSON.stringify(r.store.read().connectors);
  assert.equal(state.includes('GOCSPX'), false);
  assert.equal(state.includes(CLIENT.clientId), false);
  const row = r.store.get("SELECT * FROM credentials WHERE kind='google_client'");
  assert.ok(row);
  assert.equal(JSON.stringify(row).includes('GOCSPX'), false, 'encrypted at rest');
  const [connector] = (await r.call('GET', '/api/connectors')).body.connectors;
  assert.deepEqual([connector.id, connector.kind, connector.status, connector.account], ['google', 'google', 'setup', null]);
  assert.deepEqual((await r.call('GET', '/api/connectors')).body.google.configured, true);
  for (const bad of [{}, {clientId: 'x'}, {clientId: CLIENT.clientId}, {clientId: 'a b c', clientSecret: 'abcdefgh'}, {clientId: CLIENT.clientId, clientSecret: 'x'}, {clientId: CLIENT.clientId, clientSecret: 'x'.repeat(500)}]) {
    assert.equal((await r.call('POST', '/api/connectors/google/setup', {body: bad})).status, 400, JSON.stringify(bad));
  }
  const admin = await rig(t, {role: 'admin'});
  assert.equal((await setup(admin)).status, 403, 'an admin is not enough');
});

test('start sends the owner to Google with PKCE, a state and exactly the two scopes; the redirect comes from config', async t => {
  const r = await rig(t);
  assert.equal((await r.call('GET', '/api/connectors/google/start')).status, 409, 'not before the client is saved');
  await setup(r);
  const flow = await start(r);
  const {url} = flow;
  assert.equal(`${url.origin}${url.pathname}`, `${r.google.base}/auth`);
  const q = url.searchParams;
  assert.equal(q.get('client_id'), CLIENT.clientId);
  assert.equal(q.get('redirect_uri'), 'https://bots.example.com/api/connectors/google/callback');
  assert.equal(q.get('response_type'), 'code');
  assert.deepEqual(q.get('scope').split(' ').sort(), [...GOOGLE_SCOPES].sort());
  assert.deepEqual(GOOGLE_SCOPES, ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/drive.readonly']);
  assert.equal(q.get('access_type'), 'offline');
  assert.equal(q.get('prompt'), 'consent');
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.match(q.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  assert.match(q.get('state'), /^[a-f0-9]{64}$/);
  assert.ok(!q.has('client_secret') && !q.has('code_verifier'), 'the secret and the verifier never go in the address');
  const cookie = flow.out.headers['Set-Cookie'];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/, 'Lax, because Google sends the owner back from another site');
  assert.match(cookie, /Path=\/api\/connectors\/google/);
  assert.equal((await r.call('GET', '/api/connectors/google/start', {cookie: ''})).status, 401, 'a session is needed to start');
});

test('the redirect base is PUBLIC_BASE_URL, then PUBLIC_ORIGIN, then the address the request came to', async t => {
  const r = await rig(t, {env: {vars: {PUBLIC_BASE_URL: undefined, PUBLIC_ORIGIN: 'https://origin.example.org/'}}});
  assert.equal((await r.call('GET', '/api/connectors')).body.google.redirectUri, 'https://origin.example.org/api/connectors/google/callback');
  r.setEnv({PUBLIC_ORIGIN: undefined});
  assert.equal((await r.call('GET', '/api/connectors', {host: 'laptop.lan:4173'})).body.google.redirectUri, 'http://laptop.lan:4173/api/connectors/google/callback');
  r.setEnv({PUBLIC_BASE_URL: 'not a url'});
  assert.equal((await r.call('GET', '/api/connectors', {host: 'h.example.com'})).body.google.redirectUri, 'http://h.example.com/api/connectors/google/callback');
});

test('the Google code has no hard-coded local address: no localhost, no loopback', async () => {
  for (const file of ['src/google.js', 'src/connectors.js', 'src/routes-connectors.js', 'shared/connectors.js']) {
    const text = await fs.readFile(path.join(import.meta.dirname, '..', file), 'utf8');
    assert.doesNotMatch(text, /localhost|127\.0\.0\.1|\[::1\]/i, `${file} names a local address`);
  }
});

test('the callback exchanges the code with the PKCE verifier, keeps the refresh token in the vault and records the account', async t => {
  const r = await rig(t);
  const {done} = await connect(r);
  assert.equal(done.status, 302);
  assert.equal(done.headers.Location, 'https://bots.example.com/?google=connected');
  assert.match(done.headers['Set-Cookie'], /google_state=;.*Max-Age=0/, 'the flow cookie is cleared');
  const exchange = r.google.log.find(l => l.path === '/token');
  const form = new URLSearchParams(exchange.raw);
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('redirect_uri'), 'https://bots.example.com/api/connectors/google/callback');
  assert.match(form.get('code_verifier'), /^[A-Za-z0-9_-]{43,128}$/);
  assert.equal(form.get('client_secret'), CLIENT.clientSecret, 'the server presents its secret to Google');
  const [c] = (await r.call('GET', '/api/connectors')).body.connectors;
  assert.deepEqual([c.id, c.status, c.account], ['google', 'ready', ACCOUNT.toLowerCase()]);
  assert.deepEqual(c.actions.map(a => [a.name, a.write]), [['gmail.search', false], ['gmail.read', false], ['gmail.draft', true], ['gmail.send', true], ['drive.search', false], ['drive.read', false]]);
  assert.ok(r.store.get("SELECT id FROM credentials WHERE kind='google_token'"));
  assert.equal(googleFlows.size, 0, 'the flow is spent');
  // The profile call used the access token, nothing else was sent.
  assert.equal(r.google.calls('/gmail/v1/users/me/profile').length, 1);
});

test('Review focus 1: a tampered, unknown, reused or expired state, or a missing cookie, is refused with no token request', async t => {
  const r = await rig(t);
  await setup(r);
  const tokenCalls = () => r.google.calls('/token').length;
  const refused = async (flow, options, label) => {
    const out = await finish(r, flow, options);
    assert.equal(out.status, 302, label);
    assert.match(out.headers.Location, /\?google=error&reason=state$/, label);
    assert.equal(tokenCalls(), 0, `${label}: Google was not asked for a token`);
  };
  const flow = await start(r);
  await refused(flow, {state: flow.state.replace(/.$/, c => (c === 'a' ? 'b' : 'a'))}, 'a tampered state');
  await refused(flow, {state: 'f'.repeat(64)}, 'an unknown state');
  await refused(flow, {state: ''}, 'an empty state');
  await refused(flow, {cookie: ''}, 'no cookie');
  await refused(flow, {cookie: 'f'.repeat(64)}, 'the wrong cookie');
  assert.equal(googleFlows.size, 1, 'refusing a forged callback does not spend the real flow');
  // An expired flow.
  googleFlows.get(flow.state).createdAt -= 11 * 60000;
  await refused(flow, {}, 'an expired state');
  assert.equal(googleFlows.size, 0);
  // A state is single use.
  const second = await start(r);
  assert.equal((await finish(r, second)).headers.Location, 'https://bots.example.com/?google=connected');
  const calls = tokenCalls();
  const replay = await finish(r, second, {code: r.google.issueCode(second.challenge)});
  assert.match(replay.headers.Location, /reason=state$/);
  assert.equal(tokenCalls(), calls, 'a replayed callback never reaches Google');
});

test('Review focus 1: a reused code, a code for another verifier, no code, a denial and a reply with no refresh token are all refused', async t => {
  const r = await rig(t);
  await setup(r);
  const flow = await start(r);
  const code = r.google.issueCode(flow.challenge);
  assert.match((await finish(r, flow, {code})).headers.Location, /google=connected/);
  const again = await start(r);
  r.google.issueCode(again.challenge);
  const used = await finish(r, again, {code});
  assert.match(used.headers.Location, /\?google=error&reason=code$/, 'Google says invalid_grant for a used code');
  // A code that was issued for a different verifier.
  const third = await start(r);
  const wrong = r.google.issueCode('A'.repeat(43));
  assert.match((await finish(r, third, {code: wrong})).headers.Location, /reason=code$/);
  const fourth = await start(r);
  assert.match((await finish(r, fourth, {code: null})).headers.Location, /reason=code$/, 'no code at all');
  const fifth = await start(r);
  const denied = await r.call('GET', `/api/connectors/google/callback?error=access_denied&state=${fifth.state}`, {cookie: `google_state=${fifth.cookie}`});
  assert.match(denied.headers.Location, /\?google=error&reason=denied$/);
  assert.equal(googleFlows.size, 0, 'a denied flow is spent too');
  r.google.state.noRefreshToken = true;
  const sixth = await start(r);
  assert.match((await finish(r, sixth)).headers.Location, /reason=no-refresh-token$/);
  assert.equal(r.store.get("SELECT count(*) AS n FROM credentials WHERE kind='google_token'").n, 1, 'only the first, real connection holds a token');
  // The user-facing reason carries no Google text.
  assert.doesNotMatch(JSON.stringify([used.headers, denied.headers]), /invalid_grant|Bad Request/);
});

test('the access token is cached, refreshed after it expires, and one refresh at a time', async t => {
  const r = await rig(t);
  await connect(r);
  const store = r.store;
  const first = await googleAccessToken(store);
  assert.equal(await googleAccessToken(store), first, 'cached');
  assert.equal(r.google.calls('/token').filter(l => /refresh_token/.test(l.raw)).length, 0, 'the connect token is still good: no refresh yet');
  r.google.expireAccess();
  // The cache also notices expiry by its own clock; force it.
  const {resetGoogleTokenCache} = await import('../src/google.js');
  resetGoogleTokenCache();
  const [a, b, c] = await Promise.all([googleAccessToken(store), googleAccessToken(store), googleAccessToken(store)]);
  assert.equal(a, b);
  assert.equal(b, c);
  assert.notEqual(a, first);
  assert.equal(r.google.calls('/token').filter(l => /refresh_token/.test(l.raw)).length, 1, 'three callers, one refresh');
});

test('a refresh Google rejects (invalid_grant) turns the connector to reconnect, stops bots using it, and a new sign-in brings it back', async t => {
  const r = await rig(t);
  await connect(r);
  const {resetGoogleTokenCache} = await import('../src/google.js');
  resetGoogleTokenCache();
  r.google.revokeRefresh();
  await assert.rejects(googleAccessToken(r.store), error => error.code === 'reconnect' && /Reconnect Google/.test(error.message) && !/invalid_grant/.test(error.message));
  const [c] = (await r.call('GET', '/api/connectors')).body.connectors;
  assert.equal(c.status, 'reconnect');
  assert.match(c.statusMessage, /Reconnect Google/);
  assert.deepEqual(envelopeConnectors(r.store.read()), [], 'a bot is not offered a connector that needs reconnecting');
  // Reconnect: the same client, a new sign-in.
  const flow = await start(r);
  assert.match((await finish(r, flow)).headers.Location, /google=connected/);
  const [again] = (await r.call('GET', '/api/connectors')).body.connectors;
  assert.deepEqual([again.status, again.statusMessage], ['ready', '']);
  assert.equal(r.store.get("SELECT count(*) AS n FROM credentials WHERE kind='google_token'").n, 1, 'the old token was replaced, not kept beside it');
});

test('a Google outage on refresh is an error to retry, not a reconnect', async t => {
  const r = await rig(t);
  await connect(r);
  const {resetGoogleTokenCache} = await import('../src/google.js');
  resetGoogleTokenCache();
  r.setEnv({GOOGLE_TOKEN_URL: 'http://127.0.0.1:1/token'});
  await assert.rejects(googleAccessToken(r.store), error => error.code !== 'reconnect' && /Could not reach Google/.test(error.message));
  assert.equal((await r.call('GET', '/api/connectors')).body.connectors[0].status, 'ready');
});

test('Review focus 4: no secret is ever returned, logged or backed up; the client secret and refresh token live only in the vault', async t => {
  const logged = [];
  const spy = name => { const real = console[name]; console[name] = (...a) => { logged.push(a.map(String).join(' ')); }; return () => { console[name] = real; }; };
  const restore = ['log', 'error', 'warn', 'info'].map(spy);
  t.after(() => restore.forEach(f => f()));
  const r = await rig(t);
  const {flow} = await connect(r);
  const {resetGoogleTokenCache} = await import('../src/google.js');
  resetGoogleTokenCache();
  r.google.revokeRefresh();
  await googleAccessToken(r.store).catch(() => {});
  const everything = JSON.stringify([
    (await r.call('GET', '/api/connectors')).body, (await r.call('GET', '/api/state')).body, exportBackup(r.store), r.store.read().connectors,
    flow.url.toString(), flow.out.headers, logged,
  ]);
  assert.equal(everything.includes(CLIENT.clientSecret), false, 'the client secret leaked');
  assert.doesNotMatch(everything, /\brt-[0-9a-f]{12}\b/, 'a refresh token leaked');
  assert.doesNotMatch(everything, /\bat-\d+\b/, 'an access token leaked');
  assert.equal(everything.includes('code_verifier'), false);
  assert.ok(r.google.log.some(l => /rt-/.test(l.raw)), 'the fake did see the refresh token: the test can fail');
  // And the vault rows are ciphertext.
  for (const row of r.store.all("SELECT * FROM credentials WHERE kind LIKE 'google_%'")) assert.equal(JSON.stringify(row).includes('GOCSPX'), false);
});

test('disconnecting Google deletes both credentials; saving a different client forgets the old sign-in', async t => {
  const r = await rig(t);
  await connect(r);
  assert.equal((await r.call('POST', '/api/connectors/google/setup', {body: {clientId: 'other-456.apps.googleusercontent.com', clientSecret: 'GOCSPX-OTHER-SECRET-123456'}})).status, 200);
  assert.equal(r.store.get("SELECT count(*) AS n FROM credentials WHERE kind='google_token'").n, 0, 'a token made for another client is useless: it goes');
  assert.equal((await r.call('GET', '/api/connectors')).body.connectors[0].status, 'setup');
  assert.equal(r.store.get("SELECT count(*) AS n FROM credentials WHERE kind='google_client'").n, 1, 'the client was replaced in place');
  assert.equal((await r.call('DELETE', '/api/connectors/google')).status, 200);
  assert.equal(r.store.get("SELECT count(*) AS n FROM credentials").n, 0);
  assert.deepEqual((await r.call('GET', '/api/connectors')).body.connectors, []);
  assert.equal((await r.call('GET', '/api/connectors')).body.google.configured, false);
});
