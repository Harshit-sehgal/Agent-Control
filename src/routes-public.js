/** Routes that work without a browser session: health, sign-in and password
 * reset, the extension's capture endpoint, and the local-agent protocol. Each
 * one authenticates in its own way, or is safe to answer to anyone. */
import {activity, candidateInput} from '../shared/core.js';
import * as wf from '../shared/workflow.js';
import * as agent from './agent.js';
import {onAgentTaskResult, continueBrowserWork} from './bot-browser.js';
import {queueGroupRun, resumeFeedRun, resumeBrowserRun} from './coordination.js';
import {runOneBot} from './routes-groups.js';
import {sessionCookie, clearCookie, DEFAULT_WORKSPACE, resolveAccount} from './auth.js';
import {sha256} from './vault.js';
import {fail, cookie, safeJson} from './http.js';
import {reply} from './router.js';

// The per-account bucket is deliberately looser than the per-IP one: it exists to
// stop guesses spread across many addresses, not to let one client lock a
// mailbox out of the whole internet after eight tries.
const LOGIN_WINDOW_MS = 900000, LOGIN_ATTEMPTS = 8, LOGIN_ACCOUNT_ATTEMPTS = LOGIN_ATTEMPTS * 4;

export function publicRoutes(router, {auth, workspaces, version}) {
  // Failed sign-ins per client IP. A record only matters while its window is
  // open, so lapsed ones are dropped and a long-lived process cannot grow it.
  const attempts = new Map();
  const pruneExpired = () => { const now = Date.now(); for (const [ip, r] of attempts) if (now > r.until) attempts.delete(ip); };
  /** Count one try from `key` in the current window, or refuse with 429. */
  function attempt(key, limit) {
    pruneExpired();
    const record = attempts.get(key) || {count: 0, until: Date.now() + LOGIN_WINDOW_MS};
    attempts.set(key, record);
    if (record.count >= limit) fail('Too many attempts. Try again in 15 minutes.', 429);
    record.count++;
  }

  // Behind a reverse proxy the socket address is the proxy, so the limiter (and
  // the session's recorded ip) would collapse every client into one bucket.
  // The forwarded headers are only trusted when the operator says a proxy is in
  // front (TRUST_PROXY=1), for both the client ip and the https hint.
  const trustProxy = () => process.env.TRUST_PROXY === '1';
  const clientIp = req => {
    if (trustProxy()) {
      // The *rightmost* entry is the one the proxy in front of us appended. The
      // leftmost is whatever the client sent, so keying the limiter on it would
      // let an attacker rotate a fake X-Forwarded-For per guess and never be
      // counted.
      const hops = String(req.headers['x-forwarded-for'] || '').split(',').map(h => h.trim()).filter(Boolean);
      if (hops.length) return hops[hops.length - 1];
    }
    return req.socket.remoteAddress || 'unknown';
  };

  // The workspace a device was paired in. An unknown id falls through to the
  // first workspace, whose signature check refuses it.
  const agentStore = c => workspaces.holding('SELECT 1 AS x FROM agents WHERE id=?', String(c.req.headers['x-agent-id'] || '')) || workspaces.get(DEFAULT_WORKSPACE);

  // Health checks and uptime probes commonly use HEAD; the server answers it bodyless.
  for (const method of ['GET', 'HEAD']) router.add(method, '/api/health', 'public', () => ({ok: true, version}));

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
    const account = resolveAccount(b.email).slice(0, 200);
    if (account) {
      attempt(`login:account:${account}:${ip}`, LOGIN_ATTEMPTS);
      attempt(`login:account:${account}`, LOGIN_ACCOUNT_ATTEMPTS);
    }
    const result = auth.login({email: b.email, password: b.password}, {ip, userAgent: c.req.headers['user-agent']});
    if (!result.ok) fail(result.error, result.status);
    attempts.delete(`login:${ip}`);
    if (account) {
      attempts.delete(`login:account:${account}:${ip}`);
      attempts.delete(`login:account:${account}`);
    }
    const secure = Boolean(c.req.socket.encrypted || (trustProxy() && c.req.headers['x-forwarded-proto'] === 'https'));
    return reply(200, {ok: true, me: {email: result.user.email, role: result.role}}, {'Set-Cookie': sessionCookie(result.sessionId, {secure})});
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
    // Local-first: the console prints the token because no mail transport is
    // configured. Set RESET_TOKEN_CONSOLE=0 on a hosted deployment so reset
    // tokens never reach the logs.
    if (token && process.env.RESET_TOKEN_CONSOLE !== '0') console.log(`\nPassword reset token for ${String(b.email || '').trim().toLowerCase()} (valid 1 hour, single use):\n  ${token}\n`);
    return {ok: true};
  });
  router.add('POST', '/api/auth/reset', 'public', async c => {
    // Cheap to try many tokens locally; same per-IP budget as forgot/login.
    attempt(`reset:${clientIp(c.req)}`, LOGIN_ATTEMPTS);
    const b = await c.body();
    auth.consumePasswordReset(b.token, b.password);
    return {ok: true};
  });

  // A separate token limits the extension to adding a candidate and nothing else.
  router.add('POST', '/api/capture', 'public', async c => {
    const token = c.req.headers['x-capture-token'];
    // Read the token without copying the whole workspace: this runs before
    // the caller has proved anything.
    const store = token ? workspaces.byCaptureToken(token) : null;
    if (!store) fail('Invalid extension token.', 401);
    const body = candidateInput(await c.body());
    const add = async () => {
      const result = await store.update(s => wf.addCandidate(s, body));
      return reply(result.duplicate ? 200 : 201, result);
    };
    return store.trackWork ? store.trackWork(add) : add();
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
      const result = agent.redeemPairing(store, {code: b.code, name: b.name, permissions: b.permissions});
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
        try { await onAgentTaskResult(store, id, {resumeFeed: resumeFeedRun, resumeBrowser: resumeBrowserRun}); }
        catch (error) { console.error('Browser recovery:', error.message); }
      }
      const tasks = agent.claimAgentTasks(store, device.id).map(t => ({id: t.id, kind: t.kind, payload: JSON.parse(t.payload), attempts: t.attempts}));
      if (recovered) await store.update(s => { activity(s, 'agent', `Re-armed ${recovered} agent task(s) after a disconnect.`); });
      let permissions = [];
      try { permissions = JSON.parse(device.permissions || '[]'); } catch { /* Stored JSON. */ }
      return {ok: true, serverTime: new Date().toISOString(), agent: {id: device.id, name: device.name, permissions}, tasks};
    };
    return store.trackWork ? store.trackWork(heartbeat) : heartbeat();
  });
  router.add('POST', '/api/agent/tasks/:id/result', 'agent', async c => {
    const raw = await c.raw(), store = agentStore(c);
    const report = async () => {
      const device = agent.verifyAgentRequest(store, c.req.headers, 'POST', c.path, raw);
      const b = safeJson(raw);
      if (!b?.status) fail('A result status is required.', 400);
      const result = agent.completeAgentTask(store, device.id, c.params.id, {status: b.status, result: b.result, error: b.error});
      await store.update(s => activity(s, 'agent', `Agent task ${c.params.id} reported ${b.status}.`, {taskId: c.params.id}));
      // A bot's browser request reports back into its chat. The agent's result is
      // already recorded, so a failure here must not fail the agent's request.
      try { await onAgentTaskResult(store, c.params.id, {continueRun: (s, spec) => continueBrowserWork(s, spec, {runBot: runOneBot, runGroup: queueGroupRun}), resumeFeed: resumeFeedRun, resumeBrowser: resumeBrowserRun}); }
      catch (error) { console.error('Browser result:', error.message); }
      return result;
    };
    return store.trackWork ? store.trackWork(report) : report();
  });
}
