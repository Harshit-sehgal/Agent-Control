/** The owner signs in with Google: the address named in OWNER_EMAIL, through the OAuth client in .env
 * (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET, the one Gmail, Drive and Calendar already use).
 *
 * OpenID Connect's code flow: PKCE, a `state` bound to a cookie, and a `nonce` in the id_token. The id_token is read
 * from Google's token endpoint over TLS, as OpenID Connect allows, and its claims are checked here: issuer, audience,
 * expiry, nonce, a verified address, and that address being the owner's. Flows live in memory, so a restart cancels a
 * half-done sign-in, which is safe.
 */
import crypto from 'node:crypto';
import {timingEqual} from './http.js';
import {googleEndpoints} from './google.js';

export const OWNER_CALLBACK = '/api/auth/google/callback';
const FLOW_TTL_MS = 10 * 60000, MAX_FLOWS = 20, SKEW_S = 60, TIMEOUT_MS = 15000;
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const b64url = bytes => Buffer.from(bytes).toString('base64url');

/** Flows in progress: state -> {verifier, nonce, redirectUri, createdAt}. Exported so a test can see or age one. */
export const ownerFlows = new Map();

/** The owner's Google sign-in settings, or null when any of the three is missing or the address is not one. */
export function ownerGoogleConfig(env = process.env) {
  const ownerEmail = String(env.OWNER_EMAIL || '').trim().toLowerCase();
  const clientId = String(env.GOOGLE_CLIENT_ID || '').trim(), clientSecret = String(env.GOOGLE_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(ownerEmail)) return null;
  return {clientId, clientSecret, ownerEmail};
}

/** Begin a sign-in: the Google address to send the browser to, and the state its cookie must carry back. */
export function startOwnerSignIn(config, baseUrl) {
  const verifier = b64url(crypto.randomBytes(48)), nonce = b64url(crypto.randomBytes(24));
  const state = crypto.randomBytes(32).toString('hex'), redirectUri = `${baseUrl}${OWNER_CALLBACK}`;
  const cutoff = Date.now() - FLOW_TTL_MS;
  for (const [key, flow] of ownerFlows) if (flow.createdAt < cutoff) ownerFlows.delete(key);
  while (ownerFlows.size >= MAX_FLOWS) ownerFlows.delete(ownerFlows.keys().next().value);
  ownerFlows.set(state, {verifier, nonce, redirectUri, createdAt: Date.now()});
  const url = new URL(googleEndpoints().auth);
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  for (const [k, v] of Object.entries({client_id: config.clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email',
    state, nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account'})) url.searchParams.set(k, v);
  return {url: url.toString(), state};
}

/** The flow a callback belongs to, or null. The state must be known and young, and the cookie must carry the same
 * value; a callback that fails this does not spend a real flow. */
export function takeOwnerFlow(state, cookieValue) {
  if (typeof state !== 'string' || !/^[a-f0-9]{64}$/.test(state) || typeof cookieValue !== 'string' || !timingEqual(state, cookieValue)) return null;
  const flow = ownerFlows.get(state);
  if (!flow) return null;
  ownerFlows.delete(state);
  return Date.now() - flow.createdAt > FLOW_TTL_MS ? null : flow;
}

const claimsOf = token => {
  try { return JSON.parse(Buffer.from(String(token).split('.')[1] || '', 'base64url').toString('utf8')); } catch { return null; }
};

/** The callback: trade the code for an id_token and check it. `{ok: true, email}` only for the owner's verified
 * address; otherwise `{ok: false, reason}`, a short code for the server log, never shown to the visitor. */
export async function finishOwnerSignIn(config, flow, {code = null, error = null} = {}, {fetcher = fetch, now = Date.now} = {}) {
  if (error) return {ok: false, reason: 'denied'};
  if (typeof code !== 'string' || !code || code.length > 2000) return {ok: false, reason: 'code'};
  let status, body;
  try {
    const res = await fetcher(googleEndpoints().token, {method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'}, signal: AbortSignal.timeout(TIMEOUT_MS),
      body: new URLSearchParams({grant_type: 'authorization_code', code, redirect_uri: flow.redirectUri, client_id: config.clientId, client_secret: config.clientSecret, code_verifier: flow.verifier}).toString()});
    status = res.status;
    body = JSON.parse(await res.text());
  } catch { return {ok: false, reason: 'google'}; }
  if (status !== 200 || typeof body?.id_token !== 'string') return {ok: false, reason: 'token'};
  const claims = claimsOf(body.id_token);
  if (!claims || !ISSUERS.includes(claims.iss) || claims.aud !== config.clientId) return {ok: false, reason: 'token'};
  if (!(Number(claims.exp) + SKEW_S > now() / 1000)) return {ok: false, reason: 'expired'};
  if (typeof claims.nonce !== 'string' || !timingEqual(claims.nonce, flow.nonce)) return {ok: false, reason: 'nonce'};
  if (claims.email_verified !== true) return {ok: false, reason: 'unverified'};
  const email = String(claims.email || '').trim().toLowerCase();
  if (email !== config.ownerEmail) return {ok: false, reason: 'not-owner'};
  return {ok: true, email};
}
