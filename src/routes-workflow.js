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
import {reply, allows} from './router.js';

const retentionSettings = s => ({...RETENTION_DEFAULTS, ...(s.settings?.retention || {})});

export function workflowRoutes(router, {auth}) {
  router.add('GET', '/api/state', 'viewer', c => {
    const s = c.store.read(), me = c.actor, live = aiAvailable(c.store);
    // The stored provider row holds the vault id and may carry a key inside a
    // pasted base URL. The snapshot the browser receives is metadata only.
    s.ai = publicAi(s);
    const hasSavedDefault = s.ai?.providers?.some(provider => provider.id === s.ai.defaultProviderId);
    const model = live ? (s.ai?.defaultModel || (hasSavedDefault ? 'auto' : aiModel())) : null;
    return {...s, aiEnabled: live, aiModel: model, me: {email: me.email, role: me.role}, workspaces: auth.listWorkspaces(me.userId).map(w => ({...w, current: w.id === me.workspaceId})), canCreateWorkspace: auth.roleOf(me.userId) === 'owner', retention: retentionSettings(s),
      notifications: notifications.listNotifications(c.store, me.userId, 50), unread: notifications.unreadCount(c.store, me.userId), serverTime: new Date().toISOString()};
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
