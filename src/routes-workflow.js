/** The X-engage workflow over HTTP: the state snapshot, settings, posts,
 * drafts and their evidence, reminders, the task queue and retention. The rules
 * live in `shared/`; a route only reads the request and applies one transition. */
import {DEMO_SAMPLES, cleanText} from '../shared/core.js';
import * as wf from '../shared/workflow.js';
import * as tasks from '../shared/tasks.js';
import * as evidence from '../shared/evidence.js';
import {pruneState, RETENTION_DEFAULTS} from '../shared/retention.js';
import * as notifications from './notifications.js';
import {aiModel, makeDraft} from './ai.js';
import {aiAvailable, resolveConfig, publicAi} from './ai-providers.js';
import {fail} from './http.js';
import {reply, allows} from './router.js';

const retentionSettings = s => ({...RETENTION_DEFAULTS, ...(s.settings?.retention || {})});

export function workflowRoutes(router, {auth, processCandidate}) {
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
  router.add('PATCH', '/api/settings', 'admin', async c => { const b = await c.body(); return c.store.update(s => wf.updateSettings(s, b)); });

  // Samples come from the shared core.js constant, exactly like the Pages demo.
  router.add('POST', '/api/demo/seed', 'member', c => c.store.update(s=>wf.seedDemo(s,DEMO_SAMPLES)));
  router.add('POST', '/api/reset-demo', 'member', c => c.store.update(s => wf.resetDemo(s)));

  router.add('POST', '/api/candidates', 'member', async c => {
    const b = await c.body();
    // Report duplicates the same way /api/capture does, so the UI can tell the
    // user the post was already queued instead of pretending it was added. The
    // flag has to ride along with the candidate or the browser-local transport
    // and the Node route would answer differently for the same input.
    const result = await c.store.update(s => wf.addCandidate(s, b));
    return reply(result.duplicate ? 200 : 201, {...result.candidate, duplicate: result.duplicate});
  });
  router.add('DELETE', '/api/candidates/:id', 'member', c => c.store.update(s => wf.removeCandidate(s, c.params.id)));
  router.add('POST', '/api/candidates/:id/process', 'member', async c => {
    const run = () => processCandidate(c.store, c.params.id);
    return reply(201, await (c.store.trackWork ? c.store.trackWork(run) : run()));
  });

  router.add('PATCH', '/api/drafts/:id', 'member', async c => { const b = await c.body(); return c.store.update(s => wf.editDraft(s, c.params.id, b.text)); });
  for (const action of ['approve', 'reject', 'ready', 'restore', 'posted']) {
    router.add('POST', `/api/drafts/:id/${action}`, 'member', async c => { const b = await c.body(); return c.store.update(s => wf.draftAction(s, c.params.id, action, b)); });
  }
  router.add('POST', '/api/drafts/:id/rewrite', 'member', async c => {
    const rewrite = async () => {
      const id = c.params.id, b = await c.body(), existing = c.store.read(), old = wf.findDraft(existing, id), candidate = wf.findCandidate(existing, old.candidateId);
      if (!['pending', 'scheduled', 'ready'].includes(old.status)) fail('Cannot rewrite this draft.', 409);
      const out = await makeDraft(candidate, existing.settings, b.direction || '', resolveConfig(c.store, null));
      return c.store.update(s => {
        const x = wf.findDraft(s, id); if (x.revision !== old.revision) fail('Draft changed during rewrite. Retry.', 409);
        // Shared with edit: a new text drops the approval, its schedule, and the
        // frozen evidence snapshot. Leaving the snapshot would keep the old approval.
        return wf.rewriteDraft(s, id, out);
      });
    };
    return c.store.trackWork ? c.store.trackWork(rewrite) : rewrite();
  });

  // Source evidence: what supports a draft, verified by whom.
  router.add('POST', '/api/drafts/:id/evidence', 'member', async c => {
    const b = await c.body();
    return reply(201, await c.store.update(s => evidence.addEvidence(s, {...b, draftId: c.params.id, createdBy: c.actor.email})));
  });
  router.add('POST', '/api/evidence/:id/verify', 'member', async c => { const b = await c.body(); return c.store.update(s => evidence.verifyEvidence(s, c.params.id, b.status, {actor: c.actor.email})); });
  router.add('DELETE', '/api/evidence/:id', 'member', c => c.store.update(s => evidence.dropEvidence(s, c.params.id)));

  router.add('POST', '/api/schedules', 'member', async c => { const b = await c.body(); return reply(201, await c.store.update(s => wf.addSchedule(s, b))); });
  router.add('DELETE', '/api/schedules/:id', 'member', c => c.store.update(s => wf.removeSchedule(s, c.params.id)));

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
}
