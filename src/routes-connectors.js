/** Connectors over HTTP: Google and MCP servers a bot may use.
 *
 * Reading is for any signed-in member (no secret is ever in the answer: see
 * `publicConnector`); adding, refreshing and removing one is the admin's, and
 * saving the Google client is the owner's. Every use of a connector by a bot goes
 * through the ask mechanism, not here.
 *
 * Google's sign-in comes back to `GET /api/connectors/google/callback`, the one
 * connector route that answers without a session: the browser arrives from another
 * site, so the Strict session cookie is not sent. It is tied to the owner who
 * started the flow by the state nonce and a short-lived Lax cookie (src/google.js).
 */
import {publicConnectors, GOOGLE_ID} from '../shared/connectors.js';
import {addMcpConnector, addSiteConnector, refreshConnector, removeConnector, publicBaseUrl} from './connectors.js';
import {saveGoogleClient, startGoogleSignIn, takeGoogleFlow, finishGoogleSignIn, checkGoogle, googleSetup, resetGoogleTokenCache, GOOGLE_CALLBACK} from './google.js';
import {cookie} from './http.js';
import {undoHeldSend} from './held-sends.js';
import {reply} from './router.js';

export {GOOGLE_CALLBACK};
const FLOW_COOKIE = 'google_state';
const flowCookie = (value, {secure, maxAge}) => `${FLOW_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/api/connectors/google; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;

export function connectorRoutes(router, app = {}) {
  router.add('GET', '/api/connectors', 'viewer', c => ({
    connectors: publicConnectors(c.store.read()),
    google: googleSetup(c.store, c.req),
  }));
  router.add('POST', '/api/connectors', 'admin', async c => {
    const body = await c.body();
    // Connect apps, one tap: the app is signed in to in the shared browser, so there is no server or token to save.
    if (body?.kind === 'site') return reply(201, await addSiteConnector(c.store, body));
    return reply(201, await addMcpConnector(c.store, c.actor.workspaceId, body, {createdBy: c.actor.email}));
  });
  router.add('POST', '/api/connectors/:id/refresh', 'admin', c => (c.params.id === GOOGLE_ID ? checkGoogle(c.store) : refreshConnector(c.store, c.params.id)));
  router.add('DELETE', '/api/connectors/:id', 'admin', async c => {
    const out = await removeConnector(c.store, c.actor.workspaceId, c.params.id);
    if (c.params.id === GOOGLE_ID) resetGoogleTokenCache();
    return out;
  });

  // Undo a send the owner had Always-allowed, while its window (activity entry `undoUntil`) is open.
  router.add('POST', '/api/activity/:id/undo', 'admin', c => undoHeldSend(c.store, c.params.id));

  // Google. The owner pastes their own Cloud client; the secret goes straight to the vault.
  router.add('POST', '/api/connectors/google/setup', 'owner', async c => {
    const out = await saveGoogleClient(c.store, c.actor.workspaceId, await c.body(), {createdBy: c.actor.email});
    return {...out, redirectUri: googleSetup(c.store, c.req).redirectUri};
  });
  // The browser navigates here (a link, not fetch): it answers 302 to Google.
  router.add('GET', '/api/connectors/google/start', 'admin', c => {
    const {url, state} = startGoogleSignIn(c.store, c.actor.workspaceId, c.req);
    return reply(302, {ok: true}, {Location: url, 'Set-Cookie': flowCookie(state, {secure: publicBaseUrl(c.req).startsWith('https:'), maxAge: 600})});
  });
  router.add('GET', GOOGLE_CALLBACK, 'public', async c => {
    const q = new URL(c.req.url, 'http://callback').searchParams;
    const flow = takeGoogleFlow(q.get('state') || '', cookie(c.req, FLOW_COOKIE));
    const base = flow ? new URL(flow.redirectUri).origin : publicBaseUrl(c.req);
    const back = reason => reply(302, {ok: !reason}, {Location: `${base}/?google=${reason ? `error&reason=${reason}` : 'connected'}`, 'Set-Cookie': flowCookie('', {secure: base.startsWith('https:'), maxAge: 0})});
    if (!flow) return back('state');
    const store = app.workspaces?.get(flow.workspaceId);
    if (!store) return back('setup');
    const run = () => finishGoogleSignIn(store, flow, {code: q.get('code'), error: q.get('error')});
    const result = await (store.trackWork ? store.trackWork(run) : run());
    return back(result.reason || null);
  });
}
