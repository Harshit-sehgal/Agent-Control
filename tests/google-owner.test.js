/** The owner signs in with the Google address named in OWNER_EMAIL, and only that one.
 *
 * The flow is OpenID Connect's code flow with PKCE, a state bound to a cookie and a nonce. The id_token comes straight
 * from Google's token endpoint over TLS, so its claims are read, then checked: the issuer, the audience (our client),
 * the expiry, the nonce, a verified address, and that address being the owner's.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerGoogleConfig, startOwnerSignIn, takeOwnerFlow, finishOwnerSignIn, ownerFlows, OWNER_CALLBACK} from '../src/google-owner.js';

const env = {OWNER_EMAIL: 'Me@Example.com', GOOGLE_CLIENT_ID: 'client-1.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'shh'};
const config = ownerGoogleConfig(env);
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const idToken = claims => `${b64({alg: 'RS256'})}.${b64(claims)}.signature`;
const NOW = Date.UTC(2026, 10, 26, 12);

function begin() {
  const {url, state} = startOwnerSignIn(config, 'https://dash.example.com');
  const flow = takeOwnerFlow(state, state);
  return {url: new URL(url), state, flow};
}
const claims = (flow, extra = {}) => ({iss: 'https://accounts.google.com', aud: env.GOOGLE_CLIENT_ID, exp: NOW / 1000 + 600, nonce: flow.nonce, email: 'me@example.com', email_verified: true, ...extra});
const tokenReply = (body, status = 200) => async () => ({status, text: async () => JSON.stringify(body)});
const finish = (flow, fetcher, query = {code: 'abc'}) => finishOwnerSignIn(config, flow, query, {fetcher, now: () => NOW});

test('Google sign-in is offered only with the owner address and the whole client', () => {
  assert.equal(ownerGoogleConfig({}), null);
  assert.equal(ownerGoogleConfig({...env, GOOGLE_CLIENT_SECRET: ''}), null);
  assert.equal(ownerGoogleConfig({...env, OWNER_EMAIL: 'not-an-address'}), null);
  assert.deepEqual(ownerGoogleConfig(env), {clientId: env.GOOGLE_CLIENT_ID, clientSecret: 'shh', ownerEmail: 'me@example.com'});
});

test('the start address asks Google for the email only, with PKCE, a state and a nonce', () => {
  const {url, state} = startOwnerSignIn(config, 'https://dash.example.com');
  const q = new URL(url).searchParams;
  assert.equal(q.get('client_id'), env.GOOGLE_CLIENT_ID);
  assert.equal(q.get('redirect_uri'), `https://dash.example.com${OWNER_CALLBACK}`);
  assert.equal(q.get('scope'), 'openid email');
  assert.equal(q.get('response_type'), 'code');
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.equal(q.get('state'), state);
  assert.ok(q.get('nonce') && q.get('code_challenge'));
});

test('a full set of sign-ins in progress refuses a new one and keeps the owner\'s', () => {
  ownerFlows.clear();
  const owners = startOwnerSignIn(config, 'https://dash.example.com');
  for (let i = 0; i < 19; i++) startOwnerSignIn(config, 'https://dash.example.com');
  assert.throws(() => startOwnerSignIn(config, 'https://dash.example.com'), error => error.status === 429);
  assert.ok(takeOwnerFlow(owners.state, owners.state), 'the first flow is still there');
  ownerFlows.clear();
});

test('a state is spent once, and only with the cookie that carries it', () => {
  const {state} = startOwnerSignIn(config, 'https://dash.example.com');
  assert.equal(takeOwnerFlow(state, 'f'.repeat(64)), null, 'a wrong cookie');
  assert.equal(takeOwnerFlow(state, ''), null, 'no cookie');
  assert.ok(takeOwnerFlow(state, state), 'the failed tries did not spend it');
  assert.equal(takeOwnerFlow(state, state), null, 'a replay');
  assert.equal(takeOwnerFlow('nonsense', 'nonsense'), null);
});

test('the owner address, verified, signs in; the token request carries the code and the verifier', async () => {
  const {flow} = begin();
  let sent;
  const fetcher = async (url, init) => { sent = {url, body: new URLSearchParams(init.body)}; return tokenReply({id_token: idToken(claims(flow, {email: 'ME@example.com'}))})(); };
  assert.deepEqual(await finish(flow, fetcher), {ok: true, email: 'me@example.com'});
  assert.equal(sent.url, 'https://oauth2.googleapis.com/token');
  assert.equal(sent.body.get('code'), 'abc');
  assert.equal(sent.body.get('code_verifier'), flow.verifier);
  assert.equal(sent.body.get('client_secret'), 'shh');
  assert.equal(sent.body.get('redirect_uri'), flow.redirectUri);
});

test('anything else is refused', async () => {
  const cases = {
    'another account': {email: 'someone@example.com'},
    'an unverified address': {email_verified: false},
    'a string false': {email_verified: 'false'},
    'another client': {aud: 'other.apps.googleusercontent.com'},
    'another issuer': {iss: 'https://evil.example.com'},
    'another nonce': {nonce: 'x'},
    'an expired token': {exp: NOW / 1000 - 3600},
  };
  for (const [name, extra] of Object.entries(cases)) {
    const {flow} = begin();
    const result = await finish(flow, tokenReply({id_token: idToken(claims(flow, extra))}));
    assert.equal(result.ok, false, name);
  }
  const {flow} = begin();
  assert.equal((await finish(flow, tokenReply({error: 'invalid_grant'}, 400))).ok, false, 'a refused code');
  assert.equal((await finish(flow, tokenReply({}))).ok, false, 'no id_token');
  assert.equal((await finish(flow, tokenReply({id_token: 'garbage'}))).ok, false, 'a malformed token');
  assert.equal((await finish(flow, async () => { throw new Error('offline'); })).ok, false, 'Google unreachable');
  assert.deepEqual(await finish(flow, tokenReply({}), {error: 'access_denied'}), {ok: false, reason: 'denied'});
  assert.equal(ownerFlows.size >= 0, true);
});
