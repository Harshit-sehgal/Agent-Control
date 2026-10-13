/** Routes that work without a browser session: health, sign-in and password
 * reset, the extension's capture endpoint, and the local-agent protocol. Each
 * one authenticates in its own way, or is safe to answer to anyone. */
import {activity, candidateInput} from '../shared/core.js';
import * as wf from '../shared/workflow.js';
import * as agent from './agent.js';
import {sessionCookie, clearCookie, DEFAULT_WORKSPACE} from './auth.js';
import {sha256} from './vault.js';
import {fail, cookie, safeJson} from './http.js';
import {reply} from './router.js';

const LOGIN_WINDOW_MS = 900000, LOGIN_ATTEMPTS = 8;

export function publicRoutes(router, {auth, workspaces, version}) {
  // Failed sign-ins per address. A record only matters while its window is
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
    if (trustProxy()) { const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(); if (fwd) return fwd; }
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
    attempt(ip, LOGIN_ATTEMPTS);
    const b = await c.body();
    const result = auth.login({email: b.email, password: b.password}, {ip, userAgent: c.req.headers['user-agent']});
    if (!result.ok) fail(result.error, result.status);
    attempts.delete(ip);
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
    const token = auth.requestPasswordReset(b.email);
    // Local-first: the console prints the token because no mail transport is
    // configured. Set RESET_TOKEN_CONSOLE=0 on a hosted deployment so reset
    // tokens never reach the logs.
    if (token && process.env.RESET_TOKEN_CONSOLE !== '0') console.log(`\nPassword reset token for ${String(b.email || '').trim().toLowerCase()} (valid 1 hour, single use):\n  ${token}\n`);
    return {ok: true};
  });
  router.add('POST', '/api/auth/reset', 'public', async c => {
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
    const result = await store.update(s => wf.addCandidate(s, body));
    return reply(result.duplicate ? 200 : 201, result);
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
    const result = agent.redeemPairing(store, {code: b.code, name: b.name, permissions: b.permissions});
    await store.update(s => { activity(s, 'agent', `Paired local agent "${String(b.name || 'Local agent').slice(0, 60)}".`, {agentId: result.agentId}); });
    return reply(201, result);
  });
  router.add('POST', '/api/agent/heartbeat', 'agent', async c => {
    const store = agentStore(c);
    const device = agent.verifyAgentRequest(store, c.req.headers, 'POST', c.path, await c.raw());
    agent.touchAgent(store, device.id);
    const recovered = agent.recoverAgentTasks(store);
    const tasks = agent.claimAgentTasks(store, device.id).map(t => ({id: t.id, kind: t.kind, payload: JSON.parse(t.payload), attempts: t.attempts}));
    if (recovered) await store.update(s => { activity(s, 'agent', `Re-armed ${recovered} agent task(s) after a disconnect.`); });
    return {ok: true, serverTime: new Date().toISOString(), agent: {id: device.id, name: device.name}, tasks};
  });
  router.add('POST', '/api/agent/tasks/:id/result', 'agent', async c => {
    const raw = await c.raw(), store = agentStore(c);
    const device = agent.verifyAgentRequest(store, c.req.headers, 'POST', c.path, raw);
    const b = safeJson(raw);
    if (!b?.status) fail('A result status is required.', 400);
    const result = agent.completeAgentTask(store, device.id, c.params.id, {status: b.status, result: b.result, error: b.error});
    await store.update(s => activity(s, 'agent', `Agent task ${c.params.id} reported ${b.status}.`, {taskId: c.params.id}));
    return result;
  });
}
