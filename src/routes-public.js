/** Routes that work without a browser session: health, sign-in and password
 * reset, the extension's capture endpoint, and the local-agent protocol. Each
 * one authenticates in its own way, or is safe to answer to anyone. */
import {activity, candidateInput} from '../shared/core.js';
import * as wf from '../shared/workflow.js';
import * as agent from './agent.js';
import {sessionCookie, clearCookie} from './auth.js';
import {fail, cookie, timingEqual, safeJson} from './http.js';
import {reply} from './router.js';

const LOGIN_WINDOW_MS = 900000, LOGIN_ATTEMPTS = 8;

export function publicRoutes(router, {store, auth, version}) {
  // Failed sign-ins per address. A record only matters while its window is
  // open, so lapsed ones are dropped and a long-lived process cannot grow it.
  const attempts = new Map();
  const pruneExpired = () => { const now = Date.now(); for (const [ip, r] of attempts) if (now > r.until) attempts.delete(ip); };

  // Health checks and uptime probes commonly use HEAD; the server answers it bodyless.
  for (const method of ['GET', 'HEAD']) router.add(method, '/api/health', 'public', () => ({ok: true, version}));

  router.add('POST', '/api/login', 'public', async c => {
    const ip = c.req.socket.remoteAddress || 'unknown', record = attempts.get(ip) || {count: 0, until: 0};
    if (Date.now() > record.until) { record.count = 0; record.until = Date.now() + LOGIN_WINDOW_MS; }
    pruneExpired();
    if (record.count >= LOGIN_ATTEMPTS) fail('Too many attempts. Try again in 15 minutes.', 429);
    const b = await c.body();
    const result = auth.login({email: b.email, password: b.password}, {ip, userAgent: c.req.headers['user-agent']});
    if (!result.ok) { record.count++; attempts.set(ip, record); fail(result.error, result.status); }
    attempts.delete(ip);
    const secure = Boolean(c.req.socket.encrypted || c.req.headers['x-forwarded-proto'] === 'https');
    return reply(200, {ok: true, me: {email: result.user.email, role: result.role}}, {'Set-Cookie': sessionCookie(result.sessionId, {secure})});
  });
  router.add('POST', '/api/logout', 'public', c => {
    auth.logout(cookie(c.req, 'agent_session'));
    return reply(200, {ok: true}, {'Set-Cookie': clearCookie()});
  });

  // These two answer identically whether or not the address exists, so they
  // cannot be used to enumerate accounts.
  router.add('POST', '/api/auth/forgot', 'public', async c => {
    const b = await c.body();
    const token = auth.requestPasswordReset(b.email);
    // Local-first deployment: the console prints the token because there is no
    // mail transport configured. Do not log tokens in a public deployment.
    if (token) console.log(`\nPassword reset token for ${String(b.email || '').trim().toLowerCase()} (valid 1 hour, single use):\n  ${token}\n`);
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
    if (!token || !timingEqual(token, store.read().captureToken)) fail('Invalid extension token.', 401);
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
    const result = agent.redeemPairing(store, {code: b.code, name: b.name, permissions: b.permissions});
    await store.update(s => { activity(s, 'agent', `Paired local agent "${String(b.name || 'Local agent').slice(0, 60)}".`, {agentId: result.agentId}); });
    return reply(201, result);
  });
  router.add('POST', '/api/agent/heartbeat', 'agent', async c => {
    const device = agent.verifyAgentRequest(store, c.req.headers, 'POST', c.path, await c.raw());
    agent.touchAgent(store, device.id);
    const recovered = agent.recoverAgentTasks(store);
    const tasks = agent.claimAgentTasks(store, device.id).map(t => ({id: t.id, kind: t.kind, payload: JSON.parse(t.payload), attempts: t.attempts}));
    if (recovered) await store.update(s => { activity(s, 'agent', `Re-armed ${recovered} agent task(s) after a disconnect.`); });
    return {ok: true, serverTime: new Date().toISOString(), agent: {id: device.id, name: device.name}, tasks};
  });
  router.add('POST', '/api/agent/tasks/:id/result', 'agent', async c => {
    const raw = await c.raw();
    const device = agent.verifyAgentRequest(store, c.req.headers, 'POST', c.path, raw);
    const b = safeJson(raw);
    if (!b?.status) fail('A result status is required.', 400);
    const result = agent.completeAgentTask(store, device.id, c.params.id, {status: b.status, result: b.result, error: b.error});
    await store.update(s => activity(s, 'agent', `Agent task ${c.params.id} reported ${b.status}.`, {taskId: c.params.id}));
    return result;
  });
}
