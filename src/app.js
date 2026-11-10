/** The request dispatcher and the per-workspace start-up, without a listener.
 *
 * `src/server.js` is the only file that opens a port. Everything that has to
 * exist before a request can be answered — the route table, the
 * anonymous-then-role check, the static file server, the candidate-drafting
 * pipeline, and the background services a workspace starts — lives here, so a
 * test can build the same dispatcher the running server uses and call it with a
 * fake request, without binding a socket or spawning a process.
 *
 * The split is deliberate: importing `server.js` used to *start a server*, which
 * is why the dispatcher that guards every route had never been exercised
 * in-process. Now `server.js` wires the real services into `createApp`, and a
 * test can wire fakes into the same function.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ASSETS} from '../shared/assets.js';
import {scoreCandidate,CSP} from '../shared/core.js';
import * as wf from '../shared/workflow.js';
import * as agent from './agent.js';
import {makeDraft} from './ai.js';
import {resolveConfig} from './ai-providers.js';
import {startScheduler,startRetention} from './scheduler.js';
import {markInterrupted} from './coordination.js';
import {createQueue,recoverQueue} from './queue.js';
import {taskHandlers,createNotifier} from './handlers.js';
import {fail,send,cookie,checkOrigin,rawBody,safeJson,SECURITY} from './http.js';
import {createRouter,isReply,allows} from './router.js';
import {publicRoutes} from './routes-public.js';
import {workflowRoutes} from './routes-workflow.js';
import {groupRoutes} from './routes-groups.js';
import {accountRoutes} from './routes-account.js';
import {workspaceRoutes} from './routes-workspaces.js';
import {pushRoutes} from './routes-push.js';
import {aiRoutes} from './routes-ai.js';
import {memoryRoutes} from './routes-memory.js';

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'shared');

/** Score a candidate and produce a draft, releasing the candidate if anything
 * fails so a transient provider error never strands it. Shared by the HTTP route
 * and the queue worker. */
export async function processCandidate(store, id) {
  const context = await store.update(s => wf.beginProcessing(s, id));
  try {
    const evaluation = scoreCandidate(context.candidate, context.settings.topics);
    const result = await makeDraft(context.candidate, context.settings, '', resolveConfig(store, null));
    return await store.update(s => wf.finishProcessing(s, id, evaluation, result));
  } catch (e) {
    // The candidate may have been deleted (or the write may have failed) while
    // the provider was working. Recording the failure must never replace the
    // real drafting error with the transition's own 404 or leave the row in
    // `processing`, so the fallback writes the stored document directly.
    try { await store.update(s => wf.failProcessing(s, id, e.message)); }
    catch (releaseError) {
      try { store.failCandidate(id); }
      catch (resetError) { console.error(`Could not release candidate ${id}:`, resetError.message); }
      if (releaseError?.status !== 404) console.error(`Could not record the draft failure for ${id}:`, releaseError.message);
    }
    throw e;
  }
}

/** Agent-protocol retention. Pairing codes and agent tasks are not part of the
 * workflow document, so `pruneState()` never sees them; this is the same daily
 * sweep for those two tables. Work is tracked so a workspace being restored
 * never has raw SQL run against its file mid-swap. */
function startAgentRetention(ws, intervalMs = 86400000) {
  let busy = false, stopped = false;
  const run = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const report = ws.trackWork ? await ws.trackWork(async () => ws.pruneAgentRows()) : ws.pruneAgentRows();
      if (report.pairingCodes || report.agentTasks) console.log(`Retention pruned ${report.pairingCodes} pairing code(s), ${report.agentTasks} agent task record(s).`);
    } catch (e) { if (e?.status !== 503) console.error('Agent retention error:', e.message); }
    finally { busy = false; }
  };
  void run();
  const timer = setInterval(() => void run(), intervalMs); timer.unref();
  return async () => { stopped = true; clearInterval(timer); if (busy) await new Promise(resolve => setTimeout(resolve, 50)); };
}

/** Build the `start(store, id)` a workspace opener calls. Everything that runs in
 * the background for one workspace — the handoff clock, retention and the task
 * queue — is bound to that workspace's store, and the returned function stops
 * them. `auth` and `push` are the running server's, because a notification fans
 * out to the member's devices. */
export function createWorkspaceStarter({auth, push}) {
  return function startWorkspace(ws, workspaceId) {
    const ready = (async () => {
      await ws.update(s => { wf.migrate(s); wf.recoverInterrupted(s); });
      await markInterrupted(ws);
      await recoverQueue(ws);
    })();
    // Tasks orphaned by a disconnected agent are re-armed at boot rather
    // than left leased to a process that no longer exists.
    const recoveredAgentTasks = agent.recoverAgentTasks(ws);
    if (recoveredAgentTasks) console.log(`Re-armed ${recoveredAgentTasks} agent task(s) from a previous run.`);
    // Notifications enqueue themselves as queue tasks and fan out to the member's
    // devices; the queue handler map lives in src/handlers.js.
    const notify = createNotifier({ws, workspaceId, auth, push});
    const queue = createQueue(ws, taskHandlers({ws, workspaceId, auth, push, notify, processCandidate}), {onFail: (task, error) => task.payload?.channel === 'push' ? null : Promise.resolve(notify({title: 'A background task failed', body: `${task.title}: ${error.message}`, kind: 'task-failure', meta: {taskId: task.id}}))});
    // Nothing runs until recovery has finished, so a stalled task is re-armed
    // before the first sweep can see it.
    let stops = [], stopped = false;
    ready.then(() => { if (!stopped) stops = [startScheduler(ws), startRetention(ws), startAgentRetention(ws), queue.start()]; }).catch(error => console.error(`Workspace ${workspaceId} failed to start:`, error.message));
    const stop = async () => { stopped = true; await ready.catch(() => {}); for (const s of stops) await s(); };
    stop.ready = ready;
    return stop;
  };
}

const TYPES = {'html': 'text/html; charset=utf-8', 'js': 'text/javascript; charset=utf-8', 'css': 'text/css; charset=utf-8', 'svg': 'image/svg+xml', 'png': 'image/png', 'ico': 'image/x-icon', 'webmanifest': 'application/manifest+json'};
// The served files are the same list the Pages build ships (shared/assets.js),
// so a UI module cannot be added to one and forgotten in the other.
const SERVED = new Set(ASSETS);

/** Build the route table and the request handler. `store`, `auth`, `workspaces`,
 * `push` and `version` are the live services; a test can pass the same shapes
 * with fakes. Returns the handler plus the pieces it is made of, so a caller can
 * exercise the dispatcher directly. */
export function createApp({store, auth, workspaces, push, version, process = processCandidate}) {
  // Every API route lives in a route module and is registered with the access it
  // needs (see src/router.js). This function only wires them together.
  const router = createRouter();
  const app = {store, auth, workspaces, push, processCandidate: process, version};
  publicRoutes(router, app);
  workflowRoutes(router, app);
  groupRoutes(router, app);
  accountRoutes(router, app);
  workspaceRoutes(router, app);
  pushRoutes(router, app);
  aiRoutes(router, app);
  memoryRoutes(router);

  async function api(req, res, u) {
    const found = router.find(req.method, u.pathname), access = found?.route.access;
    let actor = null;
    // A session is checked before the route is, so an anonymous caller learns
    // nothing about which paths exist. Then the route's declared role applies,
    // before the body is read.
    if (access !== 'public' && access !== 'agent') {
      actor = auth.session(cookie(req, 'agent_session'));
      if (!actor) fail('Sign in first.', 401);
      if (!found) {
        // The path exists, the verb does not. Anonymous callers still get the same
        // "sign in first" above, so this tells a signed-in client nothing it could
        // not already read from the UI.
        const methods = router.methodsFor(u.pathname);
        if (!methods.length) fail('Unknown endpoint.', 404);
        throw Object.assign(new Error('Method not allowed.'), {status: 405, allow: methods.join(', ')});
      }
      if (!allows(actor.role, access)) fail(`This action needs the ${access} role or higher.`, 403);
    }
    // Bodies are read on demand: a handler that rate-limits or verifies a
    // signature does so before any JSON is parsed.
    // A signed-in request works on its session's workspace and no other. Routes
    // without a session find their workspace from what the caller presents.
    const scope = actor ? workspaces.get(actor.workspaceId) : null;
    if (actor && !scope) fail('This workspace is no longer available. Sign in again.', 401);
    let raw, parsed;
    const context = {req, path: u.pathname, params: found.params, actor, store: scope,
      raw: async () => raw ??= await rawBody(req),
      // An optional limit lets a route that legitimately carries a large document
      // (a backup restore) ask for more than the 128 KB default.
      body: async (limit = 128 * 1024) => parsed ??= safeJson(await rawBody(req, limit))};
    const invoke = () => found.route.handler(context);
    // A route that manages the whole workspace (restore, delete) runs outside the
    // work tracker: the tracker exists so those operations can wait for in-flight
    // requests, so the operation itself must not count as one and wait on itself.
    const result = scope?.trackWork && found.route.tracksWork
      ? await scope.trackWork(invoke)
      : await invoke();
    const {status, body, headers} = isReply(result) ? result : {status: 200, body: result, headers: {}};
    if (req.method === 'HEAD') { res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY, ...headers}); return res.end(); }
    send(res, status, body, headers);
  }

  async function serve(req, res, u) {
    let rel = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
    if (!SERVED.has(rel)) return send(res, 404, {error: 'Not found'});
    try { const body = await fs.readFile(path.join(PUBLIC, rel)); res.writeHead(200, {'Content-Type': TYPES[rel.split('.').pop()] || 'application/octet-stream', 'Content-Security-Policy': CSP, ...SECURITY, 'Cache-Control': 'no-store'}); res.end(req.method === 'HEAD' ? undefined : body); } catch { return send(res, 404, {error: 'Missing asset'}); }
  }

  const handler = async (req, res) => {
    try {
      const host = req.headers.host || 'localhost'; const url = new URL(req.url, `http://${host}`);
      checkOrigin(req);
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else if (req.method === 'GET' || req.method === 'HEAD') await serve(req, res, url);
      else fail('Method not allowed.', 405);
    } catch (e) {
      let status = e.status || 500;
      console.error(status === 500 ? 'Server error: ' + e.message : '');
      if (res.headersSent) { res.end(); return; }
      send(res, status, {error: status === 500 ? 'Internal server error' : e.message}, e.allow ? {Allow: e.allow} : undefined);
    }
  };
  return {router, app, handler, api, serve};
}