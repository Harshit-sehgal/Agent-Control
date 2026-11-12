/** The workspace over HTTP: the state snapshot, the task queue and retention. The rules
 * live in `shared/`; a route only reads the request and applies one transition. */
import {cleanText} from '../shared/core.js';
import * as tasks from '../shared/tasks.js';
import * as wf from '../shared/workflow.js';
import {pruneState, RETENTION_DEFAULTS} from '../shared/retention.js';
import * as notifications from './notifications.js';
import {aiModel} from './ai.js';
import {aiAvailable, publicAi} from './ai-providers.js';
import {fail} from './http.js';
import {activityPage} from '../shared/activity-log.js';
import {publicConnectors} from '../shared/connectors.js';
import {reply, allows} from './router.js';
import {peek} from './sqlite-store.js';
import crypto from 'node:crypto';

const retentionSettings = s => ({...RETENTION_DEFAULTS, ...(s.settings?.retention || {})});

/** The poll snapshot leaves out what only the server reads. A captured page
 * (up to tens of KB per browser request) and a run's full step outputs were
 * sent on every poll; the UI shows a 240-character step line and never the
 * page. A short excerpt keeps every field present and truthy. */
const EXCERPT = 200, STEP_TEXT = 600;
const excerpt = (text, max = EXCERPT) => (typeof text === 'string' && text.length > max ? text.slice(0, max) : text);
export function slimRequest(r) {
  if (!r?.result || typeof r.result !== 'object' || typeof r.result.page !== 'string') return r;
  return {...r, result: {...r.result, page: excerpt(r.result.page)}};
}
export function slimRun(r) {
  if (!r || typeof r !== 'object') return r;
  const out = {...r};
  if (Array.isArray(r.trace)) out.trace = r.trace.map(step => (typeof step?.output === 'string' && step.output.length > STEP_TEXT ? {...step, output: step.output.slice(0, STEP_TEXT)} : step));
  if (typeof r.browserPage === 'string') out.browserPage = excerpt(r.browserPage);
  if (typeof r.task?.feedText === 'string') out.task = {...r.task, feedText: excerpt(r.task.feedText)};
  return out;
}
const tagHash = value => crypto.createHash('sha1').update(value).digest('base64url').slice(0, 16);

export function workflowRoutes(router, {auth}) {
  router.add('GET', '/api/state', 'viewer', c => {
    // Read-only: the cached document is never mutated here. Every field this
    // route changes is replaced on a shallow copy.
    const doc = peek(c.store), me = c.actor, live = aiAvailable(c.store);
    const s = {...doc};
    // The stored provider row holds the vault id and may carry a key inside a
    // pasted base URL. The snapshot the browser receives is metadata only.
    // `publicAi` normalises its argument in place, so it gets its own copy.
    s.ai = publicAi({ai: structuredClone(doc.ai)});
    // A connector record is metadata (its secrets are vault credentials), but the snapshot gets the public view anyway.
    s.connectors = publicConnectors({connectors: structuredClone(doc.connectors)});
    // An email waiting out its Undo window carries its text; the snapshot never does.
    delete s.heldSends;
    // The log can be thousands of entries; the snapshot the browser polls leaves it out. GET /api/activity pages it.
    delete s.activity;
    s.browserRequests = Array.isArray(doc.browserRequests) ? doc.browserRequests.map(slimRequest) : doc.browserRequests;
    s.groupRuns = Array.isArray(doc.groupRuns) ? doc.groupRuns.map(slimRun) : doc.groupRuns;
    const hasSavedDefault = s.ai?.providers?.some(provider => provider.id === s.ai.defaultProviderId);
    const model = live ? (s.ai?.defaultModel || (hasSavedDefault ? 'auto' : aiModel())) : null;
    const extra = {aiEnabled: live, aiModel: model, me: {email: me.email, role: me.role}, workspaces: auth.listWorkspaces(me.userId).map(w => ({...w, current: w.id === me.workspaceId})), canCreateWorkspace: auth.roleOf(me.userId) === 'owner', retention: retentionSettings(s),
      notifications: notifications.listNotifications(c.store, me.userId, 50), unread: notifications.unreadCount(c.store, me.userId)};
    const body = {...s, ...extra, serverTime: new Date().toISOString()};
    // The document version names everything read from the store; the rest of
    // the answer (who is asking, their workspaces and notifications) is small
    // and hashed whole. `serverTime` is left out: the UI never reads it. A
    // caller without a request (a test driving the handler) gets the body.
    const version = c.req && typeof c.store.stateTag === 'function' ? c.store.stateTag() : null;
    if (!version) return body;
    const etag = `W/"${version}-${tagHash(JSON.stringify([me.userId, me.workspaceId, extra]))}"`;
    if (c.req.headers?.['if-none-match'] === etag) return reply(304, null, {ETag: etag});
    return reply(200, body, {ETag: etag});
  });
  // The activity log, a page at a time: ?filter=outside|perm|bots|all (default all),
  // ?before=<entry id> for older entries, ?limit= and ?bot=<bot id> for one profile's own section.
  // Read only: nothing edits or deletes an entry.
  router.add('GET', '/api/activity', 'viewer', c => {
    const q = new URL(c.req.url, 'http://local').searchParams;
    const limit = q.has('limit') ? Number(q.get('limit')) : undefined;
    if (q.has('limit') && !Number.isFinite(limit)) fail('Limit must be a number.');
    return activityPage(c.store.read(), {filter: q.get('filter') || undefined, before: q.get('before') || null, limit, botId: q.get('bot') || null});
  });
  // Structured task queue: the same records the internal worker executes.
  router.add('POST', '/api/tasks', 'member', async c => {
    const b = await c.body();
    // Delivery tasks are created by the server from a user's own preferences.
    // Taken from a request, one would send to any stored webhook.
    // Compare what the queue will actually store: `enqueueTask` normalizes the
    // kind with `cleanText`, so `" notification"` passed a raw comparison and
    // became a real delivery task addressed to any stored webhook.
    if (cleanText(b.kind, 64) === 'notification') fail('Notification deliveries are queued by the server, not by request.', 403);
    // A job for a paired device carries an action the device will run in the
    // signed-in browser. Every other browser path (a bot's reply, a feed read)
    // files an approval card first; this one had none, so any member could click
    // and type in the owner's session with no record and no card. Devices are
    // administered by an admin, and so is this.
    if (cleanText(b.kind, 64) === 'agent-job' && !allows(c.actor.role, 'admin')) fail('Only an admin can dispatch a job to a paired device.', 403);
    const result = await c.store.update(s => tasks.enqueueTask(s, b));
    return reply(result.duplicate ? 200 : 201, result.task);
  });
  router.add('POST', '/api/tasks/:id/retry', 'member', c => c.store.update(s => tasks.retryTask(s, c.params.id)));
  router.add('DELETE', '/api/tasks/:id', 'member', c => c.store.update(s => tasks.cancelTask(s, c.params.id)));

  // Retention: preview, then apply the workspace policy.
  router.add('GET', '/api/retention/preview', 'viewer', c => { const state = c.store.read(); return {policy: retentionSettings(state), preview: pruneState(state, {dryRun: true})}; });
  router.add('POST', '/api/retention/prune', 'admin', c => c.store.update(s => pruneState(s)));
  // The retention policy itself. Only the window sizes change; pruning is the route above.
  router.add('PATCH', '/api/retention', 'admin', async c => {
    const body = await c.body();
    return c.store.update(s => { wf.updateRetention(s, body); return retentionSettings(s); });
  });
}
