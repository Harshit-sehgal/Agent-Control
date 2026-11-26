// Signing in to an app's official MCP server, like Connect Google: discovery from the 401, self-registration, PKCE,
// tokens kept in the vault (never in the record or a reply), a live token on every call, renewal near its end, and a
// refused renewal asking the owner to sign in again. The app's server is a fake on a local port.
process.env.MCP_OAUTH_ALLOW_HTTP = '1';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {SqliteStore} from '../src/sqlite-store.js';
import * as agent from '../src/agent.js';
import {revealValue} from '../src/credentials.js';
import {startMcpSignIn, takeMcpFlow, finishMcpSignIn, discoverMcpAuth} from '../src/mcp-oauth.js';
import {mcpTarget, refreshConnector} from '../src/connectors.js';
import {useConnector} from '../src/connector-use.js';
import {publicConnectors} from '../shared/connectors.js';
import {createRouter} from '../src/router.js';
import {connectorRoutes} from '../src/routes-connectors.js';

/** An app server: MCP at /mcp behind a bearer token, with the OAuth metadata, registration and token endpoints. */
async function fakeApp({register = true, expiresIn = 3600, refuseRefresh = false, resource = null, issuer = null, forever = false} = {}) {
  const seen = {registered: [], tokens: [], bearers: []};
  let n = 0, codes = new Map(), live = new Set(), refresh = new Map();
  // `revoke()` ends every live token before its stated end; `refuseAll` refuses even a fresh one.
  const control = {refuseAll: false, revoke: () => live.clear()};
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8'), url = new URL(req.url, 'http://x'), base = `http://127.0.0.1:${server.address().port}`;
    const send = (status, body, headers = {}) => { res.writeHead(status, {'content-type': 'application/json', ...headers}); res.end(JSON.stringify(body)); };
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp') return send(200, {resource: resource === 'ORIGIN' ? base : resource || `${base}/mcp`, authorization_servers: [base], scopes_supported: ['read']});
    if (url.pathname === '/.well-known/oauth-authorization-server') return send(200, {issuer: issuer || base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, ...(register ? {registration_endpoint: `${base}/register`} : {}), code_challenge_methods_supported: ['S256']});
    if (url.pathname === '/register') { const body = JSON.parse(raw); seen.registered.push(body); return send(201, {client_id: 'client-1', redirect_uris: body.redirect_uris}); }
    if (url.pathname === '/token') {
      const form = new URLSearchParams(raw); seen.tokens.push(Object.fromEntries(form));
      if (form.get('grant_type') === 'authorization_code') {
        const want = codes.get(form.get('code'));
        if (!want || crypto.createHash('sha256').update(form.get('code_verifier')).digest('base64url') !== want) return send(400, {error: 'invalid_grant'});
      } else if (refuseRefresh || !refresh.has(form.get('refresh_token'))) return send(400, {error: 'invalid_grant'});
      const access = `AT-${++n}`, rt = `RT-${n}`; live.add(access); refresh.set(rt, true);
      // `forever`: a token with no end and no refresh token, as a GitHub OAuth app gives.
      return send(200, forever ? {access_token: access, token_type: 'bearer'} : {access_token: access, refresh_token: rt, token_type: 'Bearer', expires_in: expiresIn});
    }
    if (url.pathname === '/mcp') {
      const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
      seen.bearers.push(bearer);
      if (!live.has(bearer) || control.refuseAll) return send(401, {error: 'unauthorized'}, {'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`});
      const msg = JSON.parse(raw);
      if (msg.id === undefined) { res.writeHead(202); return res.end(); }
      if (msg.method === 'initialize') return send(200, {jsonrpc: '2.0', id: msg.id, result: {protocolVersion: '2025-06-18', capabilities: {tools: {}}, serverInfo: {name: 'fake', version: '1'}}});
      if (msg.method === 'tools/list') return send(200, {jsonrpc: '2.0', id: msg.id, result: {tools: [{name: 'search_pages', description: 'Find pages', annotations: {readOnlyHint: true}, inputSchema: {type: 'object'}}]}});
      return send(200, {jsonrpc: '2.0', id: msg.id, result: {content: [{type: 'text', text: 'ok'}]}});
    }
    send(404, {});
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  // What the owner does on the app's sign-in page: approve, and the browser comes back with a code.
  const approve = signInUrl => { const u = new URL(signInUrl); const code = `code-${codes.size + 1}`; codes.set(code, u.searchParams.get('code_challenge')); return {code, state: u.searchParams.get('state')}; };
  return {base, seen, approve, control, close: () => server.close(), app: {id: 'notion', name: 'Notion', oauth: `${base}/mcp`}};
}

async function rig(t, opts) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-oauth-'));
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  store.run("INSERT INTO workspaces (id,name,created_at) VALUES ('default','Primary workspace',?)", new Date().toISOString());
  agent.attachVault(store, path.join(dir, 'state.json'));
  const fake = await fakeApp(opts);
  t.after(async () => { fake.close(); await store.close(); await fs.rm(dir, {recursive: true, force: true}); });
  return {store, fake};
}
const signIn = async (store, fake) => {
  const {url, state} = await startMcpSignIn('default', 'http://app.example.com', 'notion', {app: fake.app});
  const flow = takeMcpFlow(state, state);
  const {code} = fake.approve(url);
  return {url, out: await finishMcpSignIn(store, flow, {code})};
};

test('sign-in is found from the 401, the app registers itself, and the owner is sent to sign in with PKCE', async t => {
  const {fake} = await rig(t);
  const auth = await discoverMcpAuth(fake.app.oauth);
  assert.equal(auth.resource, `${fake.base}/mcp`);
  const {url, state} = await startMcpSignIn('default', 'http://app.example.com', 'notion', {app: fake.app});
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, `${fake.base}/authorize`);
  assert.equal(u.searchParams.get('client_id'), 'client-1');
  assert.equal(u.searchParams.get('redirect_uri'), 'http://app.example.com/api/connectors/mcp/callback');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('resource'), `${fake.base}/mcp`);
  assert.equal(u.searchParams.get('state'), state);
  assert.deepEqual(fake.seen.registered[0].redirect_uris, ['http://app.example.com/api/connectors/mcp/callback']);
  assert.equal(fake.seen.registered[0].token_endpoint_auth_method, 'none');
  assert.equal(takeMcpFlow(state, 'f'.repeat(64)), null, 'the cookie must match');
});

test('the way back saves the app with its tools; the tokens are only in the vault', async t => {
  const {store, fake} = await rig(t);
  const {out} = await signIn(store, fake);
  assert.equal(out.name, 'Notion');
  const [c] = store.read().connectors;
  assert.deepEqual([c.kind, c.app, c.status, c.actions.map(a => a.name).join()], ['mcp', 'notion', 'ready', 'search_pages']);
  const listed = JSON.stringify(publicConnectors(store.read()));
  assert.doesNotMatch(listed + JSON.stringify(store.read()), /AT-1|RT-1|credentialId":"[^"]+"[^}]*AT/, 'no token in the record or the listing');
  assert.doesNotMatch(listed, /credentialId/);
  assert.equal(JSON.parse(revealValue(store, c.credentialId)).oauth.refreshToken, 'RT-1');
  const target = await mcpTarget(store, c);
  assert.equal(target.headers.Authorization, 'Bearer AT-1');
  // Signing in again replaces the sign-in; it does not add a second Notion.
  await signIn(store, fake);
  assert.equal(store.read().connectors.length, 1);
});

test('a token near its end is renewed, and a refused renewal asks the owner to sign in again', async t => {
  const {store, fake} = await rig(t, {expiresIn: 30});
  await signIn(store, fake);
  const [c] = store.read().connectors;
  assert.equal((await mcpTarget(store, c)).headers.Authorization, 'Bearer AT-2', 'renewed before use');
  assert.equal(fake.seen.tokens.at(-1).grant_type, 'refresh_token');
  assert.equal(fake.seen.tokens.at(-1).resource, `${fake.base}/mcp`);
  assert.equal(JSON.parse(revealValue(store, c.credentialId)).oauth.accessToken, 'AT-2', 'the vault keeps the renewed token');
  assert.equal((await refreshConnector(store, c.id)).status, 'ready');
});

test('a refused renewal marks the app to sign in again', async t => {
  const {store, fake} = await rig(t, {expiresIn: 30, refuseRefresh: true});
  await signIn(store, fake);
  const [c] = store.read().connectors;
  await assert.rejects(mcpTarget(store, c), /sign in again/);
  assert.equal(store.read().connectors[0].status, 'reconnect');
});

test('a token the app refuses before its end is renewed once and the call goes through', async t => {
  const {store, fake} = await rig(t);
  await signIn(store, fake);
  const [c] = store.read().connectors;
  fake.control.revoke();
  assert.deepEqual(await useConnector(store, c, 'search_pages', {}), {ok: true, text: 'ok'});
  assert.equal(fake.seen.tokens.at(-1).grant_type, 'refresh_token', 'renewed after the 401, not before');
  assert.equal(JSON.parse(revealValue(store, c.credentialId)).oauth.accessToken, 'AT-2');
  assert.equal(store.read().connectors[0].status, 'ready');
});

test('a second refusal after renewing asks the owner to sign in again, not to check headers', async t => {
  const {store, fake} = await rig(t);
  await signIn(store, fake);
  const [c] = store.read().connectors;
  fake.control.refuseAll = true;
  await assert.rejects(useConnector(store, c, 'search_pages', {}), error => error.reason === 'reconnect' && /sign in again/.test(error.message) && !/headers/.test(error.message));
  assert.deepEqual([store.read().connectors[0].status, store.read().connectors[0].statusMessage], ['reconnect', 'Sign in to Notion again.']);
  // Refreshing the connector from Settings keeps saying so.
  const checked = await refreshConnector(store, c.id);
  assert.equal(checked.status, 'reconnect');
});

test('an app that will not let this app register says so, and a wrong code saves nothing', async t => {
  const {store, fake} = await rig(t, {register: false});
  await assert.rejects(startMcpSignIn('default', 'http://app.example.com', 'notion', {app: fake.app}), /token instead/);
  const other = await fakeApp();
  t.after(() => other.close());
  const {state} = await startMcpSignIn('default', 'http://app.example.com', 'notion', {app: other.app});
  assert.deepEqual(await finishMcpSignIn(store, takeMcpFlow(state, state), {code: 'made-up'}), {reason: 'code'});
  assert.deepEqual(await finishMcpSignIn(store, {app: other.app}, {error: 'access_denied'}), {reason: 'denied'});
  assert.equal((store.read().connectors || []).length, 0);
});

test('the routes: start refuses an app with no sign-in back to the page, and a stray callback changes nothing', async t => {
  const {store} = await rig(t);
  const router = createRouter();
  connectorRoutes(router, {workspaces: {get: () => store}});
  const run = async (target, actor = {userId: 'u1', role: 'admin', workspaceId: 'default', email: 'o@localhost'}) => {
    const found = router.find('GET', target.split('?')[0]);
    const out = await found.route.handler({params: found.params, actor, store, req: {url: target, headers: {host: 'app.example.com'}, socket: {}}, body: async () => ({})});
    return out.headers?.Location;
  };
  assert.match(await run('/api/connectors/mcp/start?app=figma'), /\?connect=error&app=figma&reason=server/);
  assert.match(await run('/api/connectors/mcp/start?app=github'), /\?connect=error&app=github&reason=no-client/, 'no GitHub client in .env');
  assert.match(await run('/api/connectors/mcp/callback?state=' + 'a'.repeat(64) + '&code=x'), /\?connect=error&app=&reason=state/);
});

test('RFC 9728 §3.3: protected-resource metadata for another resource is refused', async t => {
  const {fake} = await rig(t, {resource: 'https://evil.example/mcp'});
  await assert.rejects(discoverMcpAuth(fake.app.oauth), /does not match|not the one/);
});

test('RFC 8414 §3.3: authorization-server metadata naming another issuer is refused', async t => {
  const {fake} = await rig(t, {issuer: 'https://evil.example'});
  await assert.rejects(discoverMcpAuth(fake.app.oauth), /does not match|not the one/);
});

/* ---------- a client from the server's .env, for an app that does not let apps register (Google, Slack, GitHub) ---------- */

const withEnv = (t, vars) => {
  const old = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  Object.assign(process.env, vars);
  t.after(() => { for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
};
const envSignIn = async (store, app) => {
  const {url, state} = await startMcpSignIn('default', 'http://app.example.com', app.id, {app});
  const flow = takeMcpFlow(state, state);
  return {url, flow};
};

test('an app with no registration signs in with the server\'s own client, and Google gets a lasting sign-in', async t => {
  const {store, fake} = await rig(t, {register: false, expiresIn: 30});
  withEnv(t, {GOOGLE_CLIENT_ID: 'gid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'g-secret'});
  const app = {id: 'gmail', name: 'Gmail', oauth: fake.app.oauth, client: 'google', scopes: ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.compose']};
  const {url, flow} = await envSignIn(store, app);
  const u = new URL(url);
  assert.equal(u.searchParams.get('client_id'), 'gid.apps.googleusercontent.com');
  assert.equal(u.searchParams.get('access_type'), 'offline', 'Google gives a refresh token only for offline access');
  assert.equal(u.searchParams.get('prompt'), 'consent');
  assert.equal(u.searchParams.get('scope'), app.scopes.join(' '), 'the app\'s own scopes, not every scope the server lists');
  assert.equal(u.searchParams.get('resource'), null, 'Google is not sent a resource');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(fake.seen.registered.length, 0, 'nothing is registered');
  assert.doesNotMatch(url, /g-secret/);
  const {code} = fake.approve(url);
  assert.equal((await finishMcpSignIn(store, flow, {code})).name, 'Gmail');
  assert.equal(fake.seen.tokens[0].client_secret, 'g-secret');
  assert.equal(fake.seen.tokens[0].resource, undefined);
  const [c] = store.read().connectors;
  const saved = JSON.parse(revealValue(store, c.credentialId)).oauth;
  assert.equal(saved.client, 'google');
  assert.equal(saved.clientSecret, null, 'the .env secret is not copied into the vault');
  // Renewing reads the secret from .env again, so a rotated secret is used.
  process.env.GOOGLE_CLIENT_SECRET = 'g-secret-2';
  assert.equal((await mcpTarget(store, c)).headers.Authorization, 'Bearer AT-2');
  assert.equal(fake.seen.tokens.at(-1).client_secret, 'g-secret-2');
});

test('with no client in .env, the sign-in says so and reaches nothing', async t => {
  const {fake} = await rig(t, {register: false});
  withEnv(t, {SLACK_CLIENT_ID: '', SLACK_CLIENT_SECRET: ''});
  const app = {id: 'slack', name: 'Slack', oauth: fake.app.oauth, client: 'slack'};
  await assert.rejects(startMcpSignIn('default', 'http://app.example.com', 'slack', {app}), e => e.reason === 'no-client' && /SLACK_CLIENT_ID/.test(e.message));
  assert.equal(fake.seen.bearers.length, 0);
});

test('a token with no end and no refresh token (GitHub) keeps working, and a refusal asks to sign in again', async t => {
  const {store, fake} = await rig(t, {register: false, forever: true});
  withEnv(t, {GITHUB_CLIENT_ID: 'gh-id', GITHUB_CLIENT_SECRET: 'gh-secret'});
  const app = {id: 'github', name: 'GitHub', oauth: fake.app.oauth, client: 'github'};
  const {url, flow} = await envSignIn(store, app);
  assert.equal(new URL(url).searchParams.get('resource'), `${fake.base}/mcp`, 'other servers still get the resource');
  await finishMcpSignIn(store, flow, {code: fake.approve(url).code});
  const [c] = store.read().connectors;
  assert.equal((await mcpTarget(store, c)).headers.Authorization, 'Bearer AT-1');
  assert.equal(fake.seen.tokens.length, 1, 'nothing to renew');
  fake.control.revoke();
  await assert.rejects(useConnector(store, c, 'search_pages', {}), e => e.reason === 'reconnect');
});

test('a server whose metadata names its own origin as the resource (Slack) is accepted', async t => {
  const {fake} = await rig(t, {resource: 'ORIGIN'});
  const auth = await discoverMcpAuth(fake.app.oauth);
  assert.equal(auth.resource, fake.base);
});

test('the connectors list says which sign-in clients the server has, never their values', async t => {
  const {store} = await rig(t);
  withEnv(t, {GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'g-secret', GITHUB_CLIENT_ID: '', SLACK_CLIENT_ID: ''});
  const router = createRouter();
  connectorRoutes(router, {workspaces: {get: () => store}});
  const found = router.find('GET', '/api/connectors');
  const out = await found.route.handler({params: {}, actor: {userId: 'u1', role: 'viewer', workspaceId: 'default'}, store, req: {url: '/api/connectors', headers: {host: 'app.example.com'}, socket: {}}, body: async () => ({})});
  assert.deepEqual(out.clients, {google: true, slack: false, github: false});
  assert.doesNotMatch(JSON.stringify(out), /gid|g-secret/);
});
