/** Google sign-in for Gmail and Drive: OAuth 2.0 authorization code with PKCE, run by this server.
 *
 * The owner makes their own Google Cloud OAuth client and pastes its id and secret
 * (`saveGoogleClient`). "Connect Google" sends the browser to Google with a PKCE
 * challenge and a state nonce (`startGoogleSignIn`); Google sends it back to the
 * callback, which trades the code and the PKCE verifier for tokens
 * (`finishGoogleSignIn`). The client secret and the refresh token are vault
 * credentials, never in a record, a response, a backup or a log; the short-lived
 * access token is kept in memory only. When Google refuses the refresh token
 * (`invalid_grant`: the owner revoked it, or the app is in Testing and 7 days
 * passed) the connector becomes `reconnect`.
 *
 * The callback arrives as a cross-site navigation, so the session cookie (SameSite
 * Strict) is not sent with it. What ties the callback to the person who started the
 * flow is the state nonce, held only in this process, single use and ten minutes
 * old at most, plus a short-lived SameSite=Lax cookie holding the same nonce, so a
 * link someone else made cannot complete a flow the owner never started.
 *
 * Nothing here names a host: the redirect comes from `publicBaseUrl` (config), and
 * Google's addresses can be pointed elsewhere by environment for tests.
 */
import crypto from 'node:crypto';
import {cleanText} from '../shared/core.js';
import {fail, timingEqual} from './http.js';
import {GOOGLE_ID, GOOGLE_ACTIONS, publicConnector} from '../shared/connectors.js';
import * as credentials from './credentials.js';
import {connectorsOf, publicBaseUrl} from './connectors.js';
import {readText, TooLarge} from './mcp-client.js';

export const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/drive.readonly'];
export const GOOGLE_CALLBACK = '/api/connectors/google/callback';
export const FLOW_TTL_MS = 10 * 60000;
const MAX_FLOWS = 20;
const SKEW_MS = 60000;
const now = () => new Date().toISOString();

/** Google's addresses. The environment can point them at a test double; by default they are Google's own. */
export const googleEndpoints = () => ({
  auth: process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
  token: process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
  api: (process.env.GOOGLE_API_BASE || 'https://www.googleapis.com').replace(/\/+$/, ''),
});

/** Flows in progress: state nonce -> {workspaceId, verifier, redirectUri, createdAt (ms)}. In memory on purpose:
 * a restart cancels a half-done sign-in, which is safe. Exported so a test can age one. */
export const googleFlows = new Map();
const tokens = new WeakMap(); // store -> {token, expiresAt, pending}
/** Drop the cached access token (Google said 401): the next call refreshes. */
export const forgetGoogleToken = store => { tokenState(store).token = null; };
export const resetGoogleTokenCache = () => { for (const key of tokenKeys) tokens.delete(key); tokenKeys.clear(); };
const tokenKeys = new Set();
const tokenState = store => { let s = tokens.get(store); if (!s) { s = {token: null, expiresAt: 0, pending: null}; tokens.set(store, s); tokenKeys.add(store); } return s; };

const googleOf = state => connectorsOf(state).find(c => c.id === GOOGLE_ID && c.kind === 'google') || null;
const problem = (message, status, code) => Object.assign(new Error(message), {status, code});

/** One request to Google: time limit, size cap, no redirect followed. Returns {status, text}. */
async function google(url, init = {}, {timeoutMs = 20000, maxBytes = 2 * 1024 * 1024} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {...init, redirect: 'manual', signal: controller.signal});
    return {status: res.status, headers: res.headers, text: await readText(res, maxBytes)};
  } catch (error) {
    if (controller.signal.aborted) throw problem('Google did not answer in time.', 504, 'timeout');
    if (error instanceof TooLarge) throw problem('Google sent more than this app reads.', 502, 'too-large');
    throw problem(`Could not reach Google (${error.cause?.code || 'network error'}).`, 502, 'unreachable');
  } finally { clearTimeout(timer); }
}
const parse = text => { try { return JSON.parse(text); } catch { return null; } };
export {google as googleFetch};

// --- owner setup ---------------------------------------------------------------------------------------

/** Save the owner's own Google Cloud client. The pair is one vault credential. A different client id means any
 * sign-in made through the old one is useless, so it is forgotten and Google is `setup` again. */
export async function saveGoogleClient(store, workspaceId, body, {createdBy = null} = {}) {
  const clientId = typeof body?.clientId === 'string' ? body.clientId.trim() : '', clientSecret = typeof body?.clientSecret === 'string' ? body.clientSecret.trim() : '';
  if (!/^[A-Za-z0-9._-]{10,200}$/.test(clientId)) fail('The client ID looks like 1234-abc.apps.googleusercontent.com. Paste it exactly as Google shows it.');
  if (!/^[\x21-\x7e]{8,200}$/.test(clientSecret)) fail('Paste the client secret exactly as Google shows it (8 to 200 characters, no spaces).');
  const existing = googleOf(store.read());
  let oldId = null;
  if (existing?.clientCredentialId) { try { oldId = JSON.parse(credentials.revealValue(store, existing.clientCredentialId)).clientId; } catch { /* Unreadable: treated as different. */ } }
  const value = JSON.stringify({clientId, clientSecret});
  let clientCredentialId = existing?.clientCredentialId || null;
  if (clientCredentialId) { try { credentials.replaceCredential(store, workspaceId, clientCredentialId, value); } catch (error) { if (error.status !== 404) throw error; clientCredentialId = null; } }
  if (!clientCredentialId) clientCredentialId = credentials.addCredential(store, workspaceId, {name: 'Google client', kind: 'google_client', value, createdBy}).id;
  const forget = existing?.tokenCredentialId && oldId !== clientId ? existing.tokenCredentialId : null;
  await store.update(s => {
    const list = connectorsOf(s);
    let c = list.find(x => x.id === GOOGLE_ID);
    if (!c) { c = {id: GOOGLE_ID, kind: 'google', name: 'Google', account: null, transport: null, host: null, agentServer: null, actions: [], status: 'setup', statusMessage: '', addedAt: now(), checkedAt: null}; list.push(c); }
    c.clientCredentialId = clientCredentialId;
    if (forget) { delete c.tokenCredentialId; Object.assign(c, {account: null, actions: [], status: 'setup', statusMessage: ''}); }
  });
  if (forget) { try { credentials.deleteCredential(store, workspaceId, forget); } catch (error) { if (error.status !== 404) throw error; } tokenState(store).token = null; }
  return {ok: true, configured: true};
}

const clientOf = store => {
  const c = googleOf(store.read());
  if (!c?.clientCredentialId) fail('Save your Google client first (Settings → Connectors → Google).', 409);
  try { return JSON.parse(credentials.revealValue(store, c.clientCredentialId)); }
  catch { fail('The saved Google client could not be read. Save it again.', 409); }
};

// --- sign-in ---------------------------------------------------------------------------------------------

const b64url = bytes => Buffer.from(bytes).toString('base64url');

/** Begin a sign-in: remember a verifier and a state, return the Google address and the cookie value to set. */
export function startGoogleSignIn(store, workspaceId, req) {
  const {clientId} = clientOf(store);
  const redirectUri = `${publicBaseUrl(req)}${GOOGLE_CALLBACK}`;
  const verifier = b64url(crypto.randomBytes(48));
  const state = crypto.randomBytes(32).toString('hex');
  const cutoff = Date.now() - FLOW_TTL_MS;
  for (const [key, flow] of googleFlows) if (flow.createdAt < cutoff) googleFlows.delete(key);
  while (googleFlows.size >= MAX_FLOWS) googleFlows.delete(googleFlows.keys().next().value);
  googleFlows.set(state, {workspaceId, verifier, redirectUri, createdAt: Date.now()});
  const url = new URL(googleEndpoints().auth);
  for (const [k, v] of Object.entries({client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: GOOGLE_SCOPES.join(' '), access_type: 'offline', prompt: 'consent', state, code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256'})) url.searchParams.set(k, v);
  return {url: url.toString(), state};
}

/** The flow a callback belongs to, or null. The state must be known, young, and the cookie must carry the same value.
 * A callback that fails this check changes nothing: it does not spend a real flow. */
export function takeGoogleFlow(state, cookieValue) {
  if (typeof state !== 'string' || !/^[a-f0-9]{64}$/.test(state) || typeof cookieValue !== 'string' || !timingEqual(state, cookieValue)) return null;
  const flow = googleFlows.get(state);
  if (!flow) return null;
  googleFlows.delete(state);
  return Date.now() - flow.createdAt > FLOW_TTL_MS ? null : flow;
}

/** The callback. Returns the reason it failed (a short code, never Google's own text), or `{account}` on success. */
export async function finishGoogleSignIn(store, flow, {code = null, error = null}) {
  if (error) return {reason: 'denied'};
  if (typeof code !== 'string' || !code || code.length > 2000) return {reason: 'code'};
  let client;
  try { client = clientOf(store); } catch { return {reason: 'setup'}; }
  const {token, api} = googleEndpoints();
  let reply;
  try {
    reply = await google(token, {method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({grant_type: 'authorization_code', code, redirect_uri: flow.redirectUri, client_id: client.clientId, client_secret: client.clientSecret, code_verifier: flow.verifier}).toString()});
  } catch { return {reason: 'google'}; }
  const body = parse(reply.text);
  if (reply.status !== 200 || !body) return {reason: body?.error === 'invalid_grant' ? 'code' : 'google'};
  if (typeof body.access_token !== 'string' || !body.access_token) return {reason: 'google'};
  if (typeof body.refresh_token !== 'string' || !body.refresh_token) return {reason: 'no-refresh-token'};
  let email;
  try {
    const profile = await google(`${api}/gmail/v1/users/me/profile`, {headers: {authorization: `Bearer ${body.access_token}`}});
    email = parse(profile.text)?.emailAddress;
  } catch { return {reason: 'google'}; }
  if (typeof email !== 'string' || !email.includes('@')) return {reason: 'google'};
  const account = cleanText(email, 200).toLowerCase();
  let tokenCredentialId = googleOf(store.read())?.tokenCredentialId || null;
  const value = JSON.stringify({refreshToken: body.refresh_token});
  if (tokenCredentialId) { try { credentials.replaceCredential(store, flow.workspaceId, tokenCredentialId, value); } catch (e) { if (e.status !== 404) throw e; tokenCredentialId = null; } }
  if (!tokenCredentialId) tokenCredentialId = credentials.addCredential(store, flow.workspaceId, {name: 'Google sign-in', kind: 'google_token', value}).id;
  const done = await store.update(s => {
    const c = googleOf(s);
    if (!c) return false;
    Object.assign(c, {tokenCredentialId, account, actions: GOOGLE_ACTIONS.map(a => ({...a})), status: 'ready', statusMessage: '', checkedAt: now()});
    return true;
  });
  if (!done) { try { credentials.deleteCredential(store, flow.workspaceId, tokenCredentialId); } catch { /* Gone. */ } return {reason: 'setup'}; }
  const cache = tokenState(store);
  cache.token = body.access_token;
  cache.expiresAt = Date.now() + (Number(body.expires_in) > 0 ? Number(body.expires_in) * 1000 : 3000000);
  return {account};
}

// --- using it --------------------------------------------------------------------------------------------

async function setStatus(store, status, statusMessage) {
  await store.update(s => { const c = googleOf(s); if (c) Object.assign(c, {status, statusMessage, checkedAt: now()}); });
}

/** A live access token, refreshed from the vaulted refresh token when the cached one is near its end. One refresh at
 * a time. A refresh Google refuses as `invalid_grant` makes the connector `reconnect` and throws code `reconnect`. */
export async function googleAccessToken(store) {
  const cache = tokenState(store);
  if (cache.token && cache.expiresAt - SKEW_MS > Date.now()) return cache.token;
  if (cache.pending) return cache.pending;
  cache.pending = (async () => {
    const c = googleOf(store.read());
    if (!c?.tokenCredentialId) throw problem('Google is not connected. Connect it in Settings → Connectors.', 422, 'not-connected');
    const client = clientOf(store);
    let refreshToken;
    try { refreshToken = JSON.parse(credentials.revealValue(store, c.tokenCredentialId)).refreshToken; }
    catch { throw problem('The saved Google sign-in could not be read. Reconnect Google.', 422, 'reconnect'); }
    const reply = await google(googleEndpoints().token, {method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({grant_type: 'refresh_token', refresh_token: refreshToken, client_id: client.clientId, client_secret: client.clientSecret}).toString()});
    const body = parse(reply.text);
    if (reply.status === 200 && typeof body?.access_token === 'string') {
      cache.token = body.access_token;
      cache.expiresAt = Date.now() + (Number(body.expires_in) > 0 ? Number(body.expires_in) * 1000 : 3000000);
      return cache.token;
    }
    cache.token = null;
    if (body?.error === 'invalid_grant') {
      const message = 'Google sign-in expired or was revoked. Reconnect Google in Settings → Connectors.';
      await setStatus(store, 'reconnect', message);
      throw problem(message, 401, 'reconnect');
    }
    if (body?.error === 'invalid_client') {
      const message = 'Google rejected the saved client. Save the client ID and secret again in Settings → Connectors.';
      await setStatus(store, 'error', message);
      throw problem(message, 502, 'client');
    }
    throw problem(`Google could not refresh the sign-in (${reply.status}). Try again.`, 502, 'google');
  })().finally(() => { cache.pending = null; });
  return cache.pending;
}

/** "Check connection": use the token once, so the connector's status says what is true now. */
export async function checkGoogle(store) {
  try { await googleAccessToken(store); await setStatus(store, 'ready', ''); }
  catch (error) { if (error.code !== 'reconnect' && error.code !== 'client') await setStatus(store, 'error', cleanText(error.message, 300)); }
  return publicConnector(googleOf(store.read()));
}

/** What Settings → Connectors → Google shows: whether the client is saved, the exact redirect address to register,
 * the scopes and the steps. */
export function googleSetup(store, req) {
  const c = googleOf(store.read());
  const redirectUri = `${publicBaseUrl(req)}${GOOGLE_CALLBACK}`;
  return {
    configured: Boolean(c?.clientCredentialId), connected: Boolean(c?.tokenCredentialId) && c.status === 'ready', status: c ? c.status : 'none', account: c?.account ?? null, redirectUri,
    scopes: [...GOOGLE_SCOPES],
    steps: [
      'Open the Google Cloud Console (console.cloud.google.com) and create a project, or pick one you already use.',
      'Under APIs & Services → Library, enable the Gmail API and the Google Drive API.',
      'Under APIs & Services → OAuth consent screen, choose External, fill in an app name and your email, and add your own Google account under Test users.',
      'Under APIs & Services → Credentials, create an OAuth client ID of type Web application.',
      `Under Authorized redirect URIs add exactly: ${redirectUri}`,
      'Copy the Client ID and Client secret, paste them here and save, then choose Connect Google.',
    ],
    testingNote: 'While the consent screen is in Testing, Google ends the sign-in after 7 days and this page shows Reconnect Google. Publishing the app (In production) for your own use removes the limit.',
  };
}
