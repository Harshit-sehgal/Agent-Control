/** Routes that work without a browser session: health, sign-in and password
 * reset, and the local-agent protocol. Each
 * one authenticates in its own way, or is safe to answer to anyone. */
import {healthOf} from './health.js';
import {lastSweepAt} from './queue.js';
import {activity} from '../shared/core.js';
import * as wf from '../shared/workflow.js';
import * as agent from './agent.js';
import {peek} from './sqlite-store.js';
import {hasFeature, BROWSER_ACCOUNTS_V1} from '../shared/device-features.js';
import {onAgentTaskResult, continueBrowserWork, setBrowserResultHooks, finishReplacement} from './bot-browser.js';
import {queueGroupRun, resumeBrowserRun} from './coordination.js';
import {runOneBot} from './routes-groups.js';
import {noticeSignins} from './signin-wait.js';
import {sessionCookie, clearCookie, DEFAULT_WORKSPACE, resolveAccount} from './auth.js';
import {sha256} from './vault.js';
import {fail, cookie, safeJson, clientIpOf, trustProxy as trustProxyEnv, forwardedHttps} from './http.js';
import {reply} from './router.js';
import {ownerGoogleConfig, startOwnerSignIn, takeOwnerFlow, finishOwnerSignIn, OWNER_CALLBACK} from './google-owner.js';
import {publicBaseUrl} from './connectors.js';

// The browser half of an owner Google sign-in: the state the callback must match, scoped to these routes and Lax so it
// survives the return from Google's own site.
const OWNER_COOKIE = 'owner_google_state';
const ownerCookie = (value, {secure, maxAge}) => `${OWNER_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/api/auth/google; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;

// A page read by this server's own browser finishes exactly where a device's
// result does: the same chat line, the same continuation. Those functions live
// in modules that import `bot-browser.js`, so the dependency is registered here
// instead of imported there (that would be a cycle).
setBrowserResultHooks({
  continueRun: (store, spec) => continueBrowserWork(store, spec, {runBot: runOneBot, runGroup: queueGroupRun}),
  resumeBrowser: resumeBrowserRun,
});

// The per-account bucket is deliberately looser than the per-IP one: it exists to
// stop guesses spread across many addresses, not to let one client lock a
// mailbox out of the whole internet after eight tries.
const LOGIN_WINDOW_MS = 900000, LOGIN_ATTEMPTS = 8, LOGIN_ACCOUNT_ATTEMPTS = LOGIN_ATTEMPTS * 4;
// A test install that only its owner can reach does not want a lockout of its
// own: one wrong guess from a laptop plus one from a phone share a bucket when
// the app is behind a tunnel. `AUTH_RATE_LIMIT=off` removes the limiter, and
// nothing else; the default stays on, because this is the only brake on
// password guessing.
// Local-first: with no mail transport the console is the only way a reset
// token reaches the owner, so a plain local install prints it. A hosted install
// (an https PUBLIC_ORIGIN) or one with SMTP configured keeps tokens out of its
// logs unless RESET_TOKEN_CONSOLE=1 asks; RESET_TOKEN_CONSOLE=0 always silences it.
const resetTokenToConsole = (env = process.env) => {
  const set = String(env.RESET_TOKEN_CONSOLE ?? '').trim();
  if (set === '0') return false;
  if (set === '1') return true;
  return !String(env.PUBLIC_ORIGIN || '').startsWith('https://') && !String(env.SMTP_HOST || '').trim();
};
const rateLimitOn = () => String(process.env.AUTH_RATE_LIMIT || '').toLowerCase() !== 'off';

/** A browser result carries a whole page (60,000 characters, often 3 bytes each,
 * plus links and controls), so the result route reads more than the default 64KB. */
export const RESULT_BODY_LIMIT = 1024 * 1024;

export function publicRoutes(router, {auth, workspaces, version}) {
  // Failed sign-ins per client IP. A record only matters while its window is
  // open, so lapsed ones are dropped and a long-lived process cannot grow it.
  const attempts = new Map();
  const pruneExpired = () => { const now = Date.now(); for (const [ip, r] of attempts) if (now > r.until) attempts.delete(ip); };
  const recordOf = key => { pruneExpired(); const record = attempts.get(key) || {count: 0, until: Date.now() + LOGIN_WINDOW_MS}; attempts.set(key, record); return record; };
  const tooMany = () => fail('Too many attempts. Try again in 15 minutes.', 429);
  /** Count one try from `key` in the current window, or refuse with 429. */
  function attempt(key, limit) {
    if (!rateLimitOn()) return;
    const record = recordOf(key);
    if (record.count >= limit) tooMany();
    record.count++;
  }
  /** Is `key`'s bucket full? Read only; `miss` counts a failure into it. */
  const full = (key, limit) => rateLimitOn() && recordOf(key).count >= limit;
  const miss = key => { if (rateLimitOn()) recordOf(key).count++; };

  const trustProxy = () => trustProxyEnv();
  const clientIp = clientIpOf;

  // The workspace a device was paired in. An unknown id falls through to the
  // first workspace, whose signature check refuses it.
  const agentStore = c => workspaces.holding('SELECT 1 AS x FROM agents WHERE id=?', String(c.req.headers['x-agent-id'] || '')) || workspaces.get(DEFAULT_WORKSPACE);

  // Health checks and uptime probes commonly use HEAD; the server answers it bodyless.
  // Ok only while every store answers and every started queue is sweeping; otherwise 503, which the container's
  // health check reads as unhealthy. The body says nothing about which part failed.
  const health = () => healthOf(workspaces.stores?.() || [], {lastSweep: lastSweepAt})
    ? {ok: true, version} : reply(503, {ok: false});
  for (const method of ['GET', 'HEAD']) router.add(method, '/api/health', 'public', health);

  router.add('POST', '/api/login', 'public', async c => {
    const ip = clientIp(c.req);
    // The attempt is counted before the body is read, so a burst of parallel
    // requests cannot all slip past the limit while the first is still open.
    attempt(`login:${ip}`, LOGIN_ATTEMPTS);
    const b = await c.body();
    // A per-account bucket as well: an attacker who can burn addresses one at a
    // time must still not get unlimited guesses at one mailbox. It is keyed on
    // the account the request is *about*, resolved the way `auth.login` resolves
    // it — a body with no email means the owner, and keying on the raw body
    // meant the guesses aimed at that one mailbox were counted per IP only.
    //
    // The across-addresses account bucket counts failures only, and a full one
    // still lets the right password through: otherwise anyone could keep the
    // owner locked out with 32 wrong guesses per window from rotating
    // addresses. The per-address buckets above still refuse everything.
    const account = resolveAccount(b.email).slice(0, 200);
    const accountKey = `login:account:${account}`;
    const accountFull = Boolean(account) && full(accountKey, LOGIN_ACCOUNT_ATTEMPTS);
    if (account) attempt(`${accountKey}:${ip}`, LOGIN_ATTEMPTS);
    const result = await auth.loginAsync({email: b.email, password: b.password}, {ip, userAgent: c.req.headers['user-agent']});
    if (!result.ok) {
      if (account) miss(accountKey);
      if (accountFull) tooMany();
      fail(result.error, result.status);
    }
    attempts.delete(`login:${ip}`);
    if (account) {
      attempts.delete(`login:account:${account}:${ip}`);
      attempts.delete(`login:account:${account}`);
    }
    const secure = Boolean(c.req.socket.encrypted || (trustProxy() && forwardedHttps(c.req)));
    return reply(200, {ok: true, me: {email: result.user.email, role: result.role}}, {'Set-Cookie': sessionCookie(result.sessionId, {secure})});
  });
  // How the sign-in screen may offer sign-in. Says only whether Google is set up, never for whom.
  router.add('GET', '/api/auth/methods', 'public', () => ({password: true, google: Boolean(ownerGoogleConfig())}));
  // The owner signs in with the Google address in OWNER_EMAIL (src/google-owner.js). Anything that goes wrong lands
  // on the sign-in screen with one message; the reason is in the server log only.
  router.add('GET', '/api/auth/google/start', 'public', c => {
    attempt(`google:${clientIp(c.req)}`, LOGIN_ATTEMPTS * 3);
    const base = publicBaseUrl(c.req), config = ownerGoogleConfig();
    if (!config) return reply(302, {ok: false}, {Location: `${base}/?signin=google-refused`});
    const {url, state} = startOwnerSignIn(config, base);
    return reply(302, {ok: true}, {Location: url, 'Set-Cookie': ownerCookie(state, {secure: base.startsWith('https:'), maxAge: 600})});
  });
  router.add('GET', OWNER_CALLBACK, 'public', async c => {
    const q = new URL(c.req.url, 'http://callback').searchParams;
    const flow = takeOwnerFlow(q.get('state') || '', cookie(c.req, OWNER_COOKIE));
    const base = flow ? new URL(flow.redirectUri).origin : publicBaseUrl(c.req);
    const secure = base.startsWith('https:');
    const refuse = reason => {
      console.warn(`Google sign-in refused: ${reason}`);
      return reply(302, {ok: false}, {Location: `${base}/?signin=google-refused`, 'Set-Cookie': ownerCookie('', {secure, maxAge: 0})});
    };
    const config = ownerGoogleConfig();
    if (!flow) return refuse('state');
    if (!config) return refuse('setup');
    const result = await finishOwnerSignIn(config, flow, {code: q.get('code'), error: q.get('error')});
    if (!result.ok) return refuse(result.reason);
    const login = auth.loginOwner({ip: clientIp(c.req), userAgent: c.req.headers['user-agent']});
    if (!login.ok) return refuse('no-owner');
    return reply(302, {ok: true}, {Location: `${base}/`, 'Set-Cookie': [sessionCookie(login.sessionId, {secure}), ownerCookie('', {secure, maxAge: 0})]});
  });
  router.add('POST', '/api/logout', 'public', c => {
    auth.logout(cookie(c.req, 'agent_session'));
    return reply(200, {ok: true}, {'Set-Cookie': clearCookie()});
  });

  // These two answer identically whether or not the address exists, so they
  // cannot be used to enumerate accounts.
  router.add('POST', '/api/auth/forgot', 'public', async c => {
    // Each request replaces the pending reset, so it is limited like sign-in.
    attempt(`forgot:${clientIp(c.req)}`, LOGIN_ATTEMPTS);
    const b = await c.body();
    // Same per-account budget as sign-in: reset requests must not be a cheaper
    // way to hammer one mailbox or probe whether it exists. No email, no
    // account bucket (see the note in /api/login).
    const email = String(b.email || '').trim().toLowerCase().slice(0, 200);
    // Its own bucket, not the sign-in one: naming a victim's address here must
    // not be a way to lock them out of signing in.
    if (email) attempt(`forgot:account:${email}`, LOGIN_ATTEMPTS);
    const token = auth.requestPasswordReset(b.email);
    if (token && resetTokenToConsole()) console.log(`\nPassword reset token for ${String(b.email || '').trim().toLowerCase()} (valid 1 hour, single use):\n  ${token}\n`);
    return {ok: true};
  });
  router.add('POST', '/api/auth/reset', 'public', async c => {
    // Cheap to try many tokens locally; same per-IP budget as forgot/login.
    attempt(`reset:${clientIp(c.req)}`, LOGIN_ATTEMPTS);
    const b = await c.body();
    auth.consumePasswordReset(b.token, b.password);
    return {ok: true};
  });

  // Local-agent protocol. Pairing redeems a one-time code; the other routes
  // verify an HMAC signature over the raw request bytes instead of a browser
  // session, because no browser is involved.
  router.add('POST', '/api/agent/pair', 'agent', async c => {
    const b = safeJson(await c.raw());
    if (!b?.code || typeof b.code !== 'string') fail('A pairing code is required.', 400);
    // A code that matches nothing is refused by the first workspace, with the
    // same answer a wrong code always got.
    const store = workspaces.holding('SELECT 1 AS x FROM pairing_codes WHERE code_hash=?', sha256(b.code)) || workspaces.get(DEFAULT_WORKSPACE);
    const pair = async () => {
      // A computer that proved it held the old secret keeps its accounts and bot pins: they move, and the old row is
      // retired, on the new id's first heartbeat, so a reply that never reaches the computer changes nothing.
      const result = agent.redeemPairing(store, {code: b.code, name: b.name, permissions: b.permissions, features: b.features, previous: b.previous});
      await store.update(s => { activity(s, 'agent', `Paired local agent "${String(b.name || 'Local agent').slice(0, 60)}".`, {agentId: result.agentId}); });
      return reply(201, result);
    };
    return store.trackWork ? store.trackWork(pair) : pair();
  });
  router.add('POST', '/api/agent/heartbeat', 'agent', async c => {
    const store = agentStore(c);
    const raw = await c.raw();
    const heartbeat = async () => {
      const device = agent.verifyAgentRequest(store, c.req.headers, 'POST', c.path, raw);
      agent.touchAgent(store, device.id);
      // A re-pair takes over the old computer's accounts now, before its report is read or its list is sent. A failure
      // fails this beat: an answer whose list missed the moved accounts would have the computer wipe their jars.
      await finishReplacement(store, device.id, {resumeBrowser: resumeBrowserRun});
      // Whether the owner's CLIs are signed in on that machine, as the CLIs' own
      // status commands said. Four words only; a malformed report changes nothing.
      let report = null, features, accounts, stopping = false;
      try { const beat = JSON.parse(raw || '{}'); report = beat?.cli; features = beat?.features; accounts = beat?.accounts; stopping = beat?.stopping === true; } catch { /* A beat that is not JSON carries no report. */ }
      agent.recordAgentCli(store, device.id, report);
      // What its app can do; a beat without the list (an older app) leaves none.
      agent.recordAgentFeatures(store, device.id, features);
      // The sign-in state of each browser account it holds; states only, never a cookie.
      const fell = agent.recordAccountReports(store, device.id, accounts);
      // An account that just signed out gets its sign-in card and one quiet push. A failure here is logged and never fails the beat.
      if (fell.length) {
        try { await noticeSignins(store, fell); }
        catch (error) { console.error('Sign-in card:', error.message); }
      }
      const nowMs = Date.now();
      // Renew this device's running leases first: it is heartbeating because it
      // is alive, so a task it is still executing (a slow page, a serial queue)
      // must not be re-armed by the recovery pass below and run twice.
      agent.renewAgentTaskLeases(store, device.id, {nowMs});
      const staleBrowserTasks = store.all(
        `SELECT id FROM agent_tasks WHERE kind='browser.action' AND status='running' AND (lease_until IS NULL OR lease_until<=?)`,
        new Date(nowMs).toISOString(),
      ).map(task => task.id);
      const recovered = agent.recoverAgentTasks(store, nowMs);
      for (const id of staleBrowserTasks) {
        try { await onAgentTaskResult(store, id, {resumeBrowser: resumeBrowserRun}); }
        catch (error) { console.error('Browser recovery:', error.message); }
      }
      // A device that is stopping beats only to keep its running leases: it is handed nothing new (an older server ignores the field).
      const claimed = (stopping ? [] : agent.claimAgentTasks(store, device.id)).map(t => ({id: t.id, kind: t.kind, payload: JSON.parse(t.payload), attempts: t.attempts}));
      // A task for a browser account goes only to an app that keeps them. One queued before this computer was rolled
      // back to an older app is failed here, never run in its default profile.
      const keepsAccounts = hasFeature(agent.readAgentFeatures(store, device.id), BROWSER_ACCOUNTS_V1);
      const refused = keepsAccounts ? [] : claimed.filter(t => t.payload?.account).map(t => t.id);
      if (refused.length) agent.failAgentTasks(store, refused, agent.missingFeatureLine(BROWSER_ACCOUNTS_V1));
      for (const id of refused) {
        try { await onAgentTaskResult(store, id, {resumeBrowser: resumeBrowserRun}); }
        catch (error) { console.error('Browser result:', error.message); }
      }
      const tasks = claimed.filter(t => !refused.includes(t.id));
      if (recovered) await store.update(s => { activity(s, 'agent', `Re-armed ${recovered} agent task(s) after a disconnect.`); });
      let permissions = [];
      try { permissions = JSON.parse(device.permissions || '[]'); } catch { /* Stored JSON. */ }
      // The accounts whose cookies this computer keeps, so it can drop a jar the owner moved or deleted.
      const held = (peek(store).browserAccounts || []).filter(a => a.deviceId === device.id).map(a => ({id: a.id, site: a.site}));
      return {ok: true, serverTime: new Date().toISOString(), agent: {id: device.id, name: device.name, permissions}, tasks, accounts: held};
    };
    return store.trackWork ? store.trackWork(heartbeat) : heartbeat();
  });
  router.add('POST', '/api/agent/tasks/:id/result', 'agent', async c => {
    const raw = await c.raw(RESULT_BODY_LIMIT), store = agentStore(c);
    const report = async () => {
      const device = agent.verifyAgentRequest(store, c.req.headers, 'POST', c.path, raw);
      const b = safeJson(raw);
      if (!b?.status) fail('A result status is required.', 400);
      const result = agent.completeAgentTask(store, device.id, c.params.id, {status: b.status, result: b.result, error: b.error, attempts: b.attempts});
      await store.update(s => activity(s, 'agent', `Agent task ${c.params.id} reported ${b.status}.`, {taskId: c.params.id}));
      // A bot's browser request reports back into its chat. The agent's result is
      // already recorded, so a failure here must not fail the agent's request.
      try { await onAgentTaskResult(store, c.params.id, {continueRun: (s, spec) => continueBrowserWork(s, spec, {runBot: runOneBot, runGroup: queueGroupRun}), resumeBrowser: resumeBrowserRun}); }
      catch (error) { console.error('Browser result:', error.message); }
      return result;
    };
    return store.trackWork ? store.trackWork(report) : report();
  });
}
