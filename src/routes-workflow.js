/** The X-engage workflow over HTTP: the state snapshot, settings, posts,
 * drafts and their evidence, reminders, the task queue and retention. The rules
 * live in `shared/`; a route only reads the request and applies one transition. */
import {activity, DEMO_SAMPLES} from '../shared/core.js';
import * as wf from '../shared/workflow.js';
import * as tasks from '../shared/tasks.js';
import * as evidence from '../shared/evidence.js';
import {pruneState, RETENTION_DEFAULTS} from '../shared/retention.js';
import * as notifications from './notifications.js';
import {aiEnabled, aiModel, makeDraft} from './ai.js';
import {fail} from './http.js';
import {reply, allows} from './router.js';

const retentionSettings = s => ({...RETENTION_DEFAULTS, ...(s.settings?.retention || {})});

export function workflowRoutes(router, {store, processCandidate}) {
  router.add('GET', '/api/state', 'viewer', c => {
    const s = store.read(), me = c.actor, live = aiEnabled();
    // The capture token lets its holder add posts, which a viewer may not do.
    if (!allows(me.role, 'member')) delete s.captureToken;
    return {...s, aiEnabled: live, aiModel: live ? aiModel() : null, me: {email: me.email, role: me.role}, retention: retentionSettings(s),
      notifications: notifications.listNotifications(store, me.userId, 50), unread: notifications.unreadCount(store, me.userId), serverTime: new Date().toISOString()};
  });
  router.add('PATCH', '/api/settings', 'admin', async c => { const b = await c.body(); return store.update(s => wf.updateSettings(s, b)); });

  // Samples come from the shared core.js constant, exactly like the Pages demo.
  router.add('POST', '/api/demo/seed', 'member', () => store.update(s=>wf.seedDemo(s,DEMO_SAMPLES)));
  router.add('POST', '/api/reset-demo', 'member', () => store.update(s => wf.resetDemo(s)));

  router.add('POST', '/api/candidates', 'member', async c => {
    const b = await c.body();
    // Report duplicates the same way /api/capture does, so the UI can tell the
    // user the post was already queued instead of pretending it was added. The
    // flag has to ride along with the candidate or the browser-local transport
    // and the Node route would answer differently for the same input.
    const result = await store.update(s => wf.addCandidate(s, b));
    return reply(result.duplicate ? 200 : 201, {...result.candidate, duplicate: result.duplicate});
  });
  router.add('POST', '/api/candidates/:id/process', 'member', async c => reply(201, await processCandidate(c.params.id)));

  router.add('PATCH', '/api/drafts/:id', 'member', async c => { const b = await c.body(); return store.update(s => wf.editDraft(s, c.params.id, b.text)); });
  for (const action of ['approve', 'reject', 'ready', 'posted']) {
    router.add('POST', `/api/drafts/:id/${action}`, 'member', async c => { const b = await c.body(); return store.update(s => wf.draftAction(s, c.params.id, action, b)); });
  }
  router.add('POST', '/api/drafts/:id/rewrite', 'member', async c => {
    const id = c.params.id, b = await c.body(), existing = store.read(), old = wf.findDraft(existing, id), candidate = wf.findCandidate(existing, old.candidateId);
    if (!['pending', 'scheduled', 'ready'].includes(old.status)) fail('Cannot rewrite this draft.', 409);
    const out = await makeDraft(candidate, existing.settings, b.direction || '');
    return store.update(s => {
      const x = wf.findDraft(s, id); if (x.revision !== old.revision) fail('Draft changed during rewrite. Retry.', 409);
      x.text = out.text; x.revision++; x.status = 'pending'; x.mode = out.mode; x.note = out.note;
      delete x.approvedText; delete x.approvedRevision; delete x.dueAt; delete x.approvedAt;
      activity(s, 'rewrite', `Rewrote draft ${x.id}.`, {draftId: x.id}); return x;
    });
  });

  // Source evidence: what supports a draft, verified by whom.
  router.add('POST', '/api/drafts/:id/evidence', 'member', async c => {
    const b = await c.body();
    return reply(201, await store.update(s => evidence.addEvidence(s, {...b, draftId: c.params.id, createdBy: c.actor.email})));
  });
  router.add('POST', '/api/evidence/:id/verify', 'member', async c => { const b = await c.body(); return store.update(s => evidence.verifyEvidence(s, c.params.id, b.status, {actor: c.actor.email})); });
  router.add('DELETE', '/api/evidence/:id', 'member', c => store.update(s => evidence.dropEvidence(s, c.params.id)));

  router.add('POST', '/api/schedules', 'member', async c => { const b = await c.body(); return reply(201, await store.update(s => wf.addSchedule(s, b))); });
  router.add('DELETE', '/api/schedules/:id', 'member', c => store.update(s => wf.removeSchedule(s, c.params.id)));

  // Structured task queue: the same records the internal worker executes.
  router.add('POST', '/api/tasks', 'member', async c => {
    const b = await c.body();
    // Delivery tasks are created by the server from a user's own preferences.
    // Taken from a request, one would send to any stored webhook.
    if (b.kind === 'notification') fail('Notification deliveries are queued by the server, not by request.', 403);
    const result = await store.update(s => tasks.enqueueTask(s, b));
    return reply(result.duplicate ? 200 : 201, result.task);
  });
  router.add('POST', '/api/tasks/:id/retry', 'member', c => store.update(s => tasks.retryTask(s, c.params.id)));
  router.add('DELETE', '/api/tasks/:id', 'member', c => store.update(s => tasks.cancelTask(s, c.params.id)));

  // Retention: preview, then apply the workspace policy.
  router.add('GET', '/api/retention/preview', 'viewer', () => { const state = store.read(); return {policy: retentionSettings(state), preview: pruneState(state, {dryRun: true})}; });
  router.add('POST', '/api/retention/prune', 'admin', () => store.update(s => pruneState(s)));
}
