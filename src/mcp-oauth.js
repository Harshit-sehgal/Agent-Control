/** Connect an app's official MCP server by signing in to it, the way Connect Google works, with no token to paste.
 *
 * The MCP spec's sign-in: the server answers 401 and names its protected-resource metadata (RFC 9728), which names
 * the authorization server; that server's metadata (RFC 8414) gives the sign-in, token and registration addresses.
 * This app registers itself there (RFC 7591, a public client with no secret), sends the owner to sign in with PKCE
 * (S256) and the `resource` the token is for (RFC 8707), and trades the code for tokens on the way back.
 *
 * Only an app in the catalogue with an `oauth` address can start this, so every address it reaches comes from that
 * server's own metadata and must be https. The tokens live in the vault with the address, as one credential, like a
 * pasted header; the connector record holds no secret. `mcpAuthHeaders` hands a live access token to each call and
 * refreshes it near its end; a refresh the server refuses marks the connector to sign in again.
 */
import crypto from 'node:crypto';
import {fail} from '../shared/errors.js';
import {appById} from '../shared/app-catalog.js';
import {newConnectorId, publicConnector} from '../shared/connectors.js';
import {mcpList, readText, TooLarge} from './mcp-client.js';
import * as credentials from './credentials.js';
import {guardedFetch} from './reach-guard.js';

export const MCP_CALLBACK = '/api/connectors/mcp/callback';
const FLOW_TTL_MS = 10 * 60 * 1000, MAX_FLOWS = 50, SKEW_MS = 60 * 1000, TIMEOUT_MS = 15000, MAX_BYTES = 256 * 1024;
const flows = new Map();
const connectorsOf = state => (state.connectors ??= []);
const now = () => new Date().toISOString();
const b64url = bytes => Buffer.from(bytes).toString('base64url');
const parse = text => { try { return JSON.parse(text); } catch { return null; } };
const problem = (message, status, reason) => Object.assign(new Error(message), {status, reason});

/** An address from a server's metadata: https only (plain http on this computer only in tests). */
function endpoint(value, what) {
  let url;
  try { url = new URL(String(value ?? '')); } catch { throw problem(`The server gave no usable ${what} address.`, 502, 'server'); }
  const loopback = process.env.MCP_OAUTH_ALLOW_HTTP === '1' && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !loopback) || url.username || url.password) throw problem(`The server's ${what} address is not https.`, 502, 'server');
  return url.href;
}

async function call(url, init = {}) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // Every address here comes from a server's metadata, so it is checked and pinned like the MCP address itself.
    const res = await guardedFetch(url, {redirect: 'manual', ...init, signal: controller.signal}, {what: 'An app\'s sign-in server'});
    return {status: res.status, headers: res.headers, text: await readText(res, MAX_BYTES)};
  } catch (error) {
    if (controller.signal.aborted) throw problem('The app\'s server did not answer in time.', 504, 'server');
    if (error instanceof TooLarge) throw problem('The app\'s server sent more than this app reads.', 502, 'server');
    // A private or metadata address is refused as such (src/reach-guard.js).
    if (error.status === 400) throw problem(error.message, 400, 'server');
    throw problem(`Could not reach the app's server (${error.cause?.code || 'network error'}).`, 502, 'server');
  } finally { clearTimeout(timer); }
}
const json = async (url, init) => { const r = await call(url, init); return {status: r.status, headers: r.headers, body: parse(r.text)}; };
/** Two addresses that name the same thing: the same URL, a trailing slash aside. */
const same = (a, b) => { try { return new URL(String(a)).href.replace(/\/+$/, '') === new URL(String(b)).href.replace(/\/+$/, ''); } catch { return false; } };
const wellKnown = (base, name) => { const u = new URL(base); const path = u.pathname.replace(/\/+$/, ''); return [`${u.origin}/.well-known/${name}${path === '' ? '' : path}`, `${u.origin}/.well-known/${name}`]; };

/** Where an MCP server signs people in: its authorization server's addresses, and the resource a token is for. */
export async function discoverMcpAuth(mcpUrl) {
  const probe = await call(mcpUrl, {method: 'POST', headers: {'content-type': 'application/json', accept: 'application/json, text/event-stream'},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'Agent Control', version: '1'}}})});
  const named = /resource_metadata="([^"]+)"/.exec(probe.headers?.get('www-authenticate') || '')?.[1];
  let resource = null;
  for (const url of [...(named ? [endpoint(named, 'metadata')] : []), ...wellKnown(mcpUrl, 'oauth-protected-resource')]) {
    const r = await json(url).catch(() => null);
    if (r?.status === 200 && r.body && typeof r.body === 'object') { resource = r.body; break; }
  }
  // RFC 9728 §3.3: the metadata must be for this very server, or a token could be minted for another one.
  if (resource && !same(resource.resource, mcpUrl)) throw problem('That app\'s server described a different address than the one being connected, so it does not match and was not used.', 502, 'server');
  const issuer = endpoint(resource?.authorization_servers?.[0] || new URL(mcpUrl).origin, 'sign-in');
  let meta = null;
  for (const url of [...wellKnown(issuer, 'oauth-authorization-server'), ...wellKnown(issuer, 'openid-configuration')]) {
    const r = await json(url).catch(() => null);
    if (r?.status === 200 && r.body?.authorization_endpoint && r.body?.token_endpoint) { meta = r.body; break; }
  }
  if (!meta) throw problem('That app\'s server does not say where to sign in.', 502, 'server');
  // RFC 8414 §3.3: the metadata's issuer must be the authorization server it was fetched for.
  if (!same(meta.issuer, issuer)) throw problem('That app\'s sign-in server names a different issuer than the one it was asked for, so it does not match and was not used.', 502, 'server');
  if (!meta.registration_endpoint) throw problem('That app does not let an app sign in by itself yet. Connect it with a token instead.', 422, 'no-register');
  return {
    authorizationEndpoint: endpoint(meta.authorization_endpoint, 'sign-in'), tokenEndpoint: endpoint(meta.token_endpoint, 'token'),
    registrationEndpoint: endpoint(meta.registration_endpoint, 'registration'),
    resource: typeof resource?.resource === 'string' && resource.resource ? resource.resource : mcpUrl,
    scope: Array.isArray(resource?.scopes_supported) ? resource.scopes_supported.filter(s => typeof s === 'string').join(' ') : '',
  };
}

/** Begin a sign-in for a catalogue app: register this app with its server, remember a PKCE verifier and a state, and
 * return the address to send the owner to and the state for the flow cookie. `base` is this app's own address (the
 * callback is under it); `app` is for tests. */
export async function startMcpSignIn(workspaceId, base, appId, {app = appById(appId)} = {}) {
  if (!app?.oauth) fail('That app does not sign in by itself. Connect it with a token instead.', 400);
  const redirectUri = `${base}${MCP_CALLBACK}`;
  const auth = await discoverMcpAuth(app.oauth);
  const reg = await json(auth.registrationEndpoint, {method: 'POST', headers: {'content-type': 'application/json', accept: 'application/json'},
    body: JSON.stringify({client_name: 'Agent Control', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none'})});
  const clientId = reg.body?.client_id;
  if (![200, 201].includes(reg.status) || typeof clientId !== 'string' || !clientId) throw problem(`${app.name} did not let this app register for sign-in.`, 502, 'register');
  const clientSecret = typeof reg.body.client_secret === 'string' ? reg.body.client_secret : null;
  const verifier = b64url(crypto.randomBytes(48)), state = crypto.randomBytes(32).toString('hex');
  const cutoff = Date.now() - FLOW_TTL_MS;
  for (const [key, flow] of flows) if (flow.createdAt < cutoff) flows.delete(key);
  while (flows.size >= MAX_FLOWS) flows.delete(flows.keys().next().value);
  flows.set(state, {workspaceId, app: {id: app.id, name: app.name, oauth: app.oauth}, verifier, redirectUri, clientId, clientSecret, ...auth, createdAt: Date.now()});
  const url = new URL(auth.authorizationEndpoint);
  const params = {response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state, code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', resource: auth.resource, ...(auth.scope ? {scope: auth.scope} : {})};
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return {url: url.toString(), state};
}

/** The flow a callback belongs to, or null: a known, young state that the flow cookie carries too. Used once. */
export function takeMcpFlow(state, cookieValue) {
  if (typeof state !== 'string' || !/^[a-f0-9]{64}$/.test(state) || typeof cookieValue !== 'string' || state.length !== cookieValue.length
    || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(cookieValue))) return null;
  const flow = flows.get(state);
  if (!flow) return null;
  flows.delete(state);
  return Date.now() - flow.createdAt > FLOW_TTL_MS ? null : flow;
}

const tokenBody = (flow, extra) => new URLSearchParams({...extra, client_id: flow.clientId, ...(flow.clientSecret ? {client_secret: flow.clientSecret} : {}), resource: flow.resource}).toString();
const tokensFrom = (body, old = {}) => ({
  accessToken: body.access_token, refreshToken: typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : old.refreshToken || null,
  expiresAt: Date.now() + (Number(body.expires_in) > 0 ? Number(body.expires_in) * 1000 : 3600 * 1000),
});

/** The callback: trade the code for tokens, list the server's tools with them, and save the connector (or sign an
 * existing one in again). Returns `{name}`, or `{reason}` (a short code, never the server's own words). */
export async function finishMcpSignIn(store, flow, {code = null, error = null}) {
  if (error) return {reason: 'denied'};
  if (typeof code !== 'string' || !code || code.length > 4000) return {reason: 'code'};
  let reply;
  try { reply = await json(flow.tokenEndpoint, {method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded', accept: 'application/json'}, body: tokenBody(flow, {grant_type: 'authorization_code', code, redirect_uri: flow.redirectUri, code_verifier: flow.verifier})}); }
  catch { return {reason: 'server'}; }
  if (reply.status !== 200 || typeof reply.body?.access_token !== 'string' || !reply.body.access_token) return {reason: reply.body?.error === 'invalid_grant' ? 'code' : 'server'};
  const oauth = {tokenEndpoint: flow.tokenEndpoint, clientId: flow.clientId, clientSecret: flow.clientSecret, resource: flow.resource, ...tokensFrom(reply.body)};
  let tools;
  try { ({tools} = await mcpList({transport: 'http', url: flow.app.oauth, headers: {Authorization: `Bearer ${oauth.accessToken}`}})); }
  catch { return {reason: 'server'}; }
  const value = JSON.stringify({url: flow.app.oauth, headers: {}, oauth});
  const host = new URL(flow.app.oauth).host.toLowerCase();
  const had = connectorsOf(store.read()).find(c => c.kind === 'mcp' && c.app === flow.app.id);
  let credentialId = had?.credentialId || null;
  if (credentialId) { try { credentials.replaceCredential(store, flow.workspaceId, credentialId, value); } catch (e) { if (e.status !== 404) throw e; credentialId = null; } }
  if (!credentialId) credentialId = credentials.addCredential(store, flow.workspaceId, {name: `MCP · ${flow.app.name}`, kind: 'connector_mcp', value}).id;
  return store.update(s => {
    const list = connectorsOf(s), live = list.find(c => c.kind === 'mcp' && c.app === flow.app.id);
    const fields = {status: 'ready', statusMessage: '', actions: tools, credentialId, checkedAt: now()};
    if (live) Object.assign(live, fields);
    else list.push({id: newConnectorId(s, flow.app.name), kind: 'mcp', app: flow.app.id, name: flow.app.name, transport: 'http', host, agentServer: null, account: host, signedIn: true, addedAt: now(), ...fields});
    return {name: flow.app.name, connector: publicConnector(live || list[list.length - 1])};
  });
}

const refreshing = new Map();
/** The headers a call to this server sends: the pasted ones, or a live access token from a sign-in, refreshed from the
 * vaulted refresh token when it is near its end. A refusal marks the connector to sign in again and throws. */
/** Mark a signed-in connector to sign in again, and throw the error that says so. */
export async function askToSignInAgain(store, connector) {
  await store.update(s => { const c = connectorsOf(s).find(x => x.id === connector.id); if (c) Object.assign(c, {status: 'reconnect', statusMessage: `Sign in to ${connector.name} again.`, checkedAt: now()}); });
  throw problem(`${connector.name} needs you to sign in again (Settings → Connectors).`, 422, 'reconnect');
}
/** `force` renews even a token that has not reached its end: the server refused it already. */
export async function mcpAuthHeaders(store, connector, secret, {force = false} = {}) {
  const oauth = secret?.oauth;
  if (!oauth) return secret?.headers || {};
  if (!force && oauth.accessToken && oauth.expiresAt - SKEW_MS > Date.now()) return {Authorization: `Bearer ${oauth.accessToken}`};
  const key = connector.credentialId;
  if (!refreshing.has(key)) refreshing.set(key, (async () => {
    const again = () => askToSignInAgain(store, connector);
    if (!oauth.refreshToken) return again();
    const reply = await json(oauth.tokenEndpoint, {method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded', accept: 'application/json'}, body: tokenBody(oauth, {grant_type: 'refresh_token', refresh_token: oauth.refreshToken})});
    if (reply.status !== 200 || typeof reply.body?.access_token !== 'string') {
      if (reply.status >= 500) throw problem(`${connector.name}'s server could not renew the sign-in just now. Try again.`, 502, 'server');
      return again();
    }
    const next = {...secret, oauth: {...oauth, ...tokensFrom(reply.body, oauth)}};
    credentials.replaceValue(store, key, JSON.stringify(next));
    secret.oauth = next.oauth;
    return {Authorization: `Bearer ${next.oauth.accessToken}`};
  })().finally(() => refreshing.delete(key)));
  return refreshing.get(key);
}

/** The reason codes a callback may carry back to the page, for a one-line message there. */
export const MCP_REASONS = ['state', 'denied', 'code', 'server', 'register', 'no-register', 'setup'];
export const reasonOf = error => (MCP_REASONS.includes(error?.reason) ? error.reason : 'server');
