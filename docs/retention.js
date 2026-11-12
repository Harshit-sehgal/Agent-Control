/** Retention policy.
 *
 * The workflow document only grows: events, runs and finished tasks. These are
 * pure prune rules over the state object so the Node server and the
 * browser-local demo can apply them identically, plus a workspace-level policy
 * in settings. Nothing here deletes groups, bots, chats or memory: those are
 * the user's working material, not exhaust. (Notifications are not part of the
 * workflow document — they are bounded by the in-app feed cap in
 * src/notifications.js — so there is no retention knob for them here.)
 */
import {activity} from './core.js?v=80f77f5682';
import {BUSY_STATUSES} from './coordination.js?v=80f77f5682';

export const RETENTION_DEFAULTS = {events: 90, doneTasks: 30, runs: 30};

export function normalizeRetention(input = {}) {
  // `PATCH /api/settings {retention: null}` reached `Number(body[key])` on a
  // null and threw a TypeError with no status: a 500 that still stored the null,
  // after which every preview and prune from then on threw the same way.
  const body = input && typeof input === 'object' ? input : {};
  const out = {...RETENTION_DEFAULTS};
  for (const key of Object.keys(RETENTION_DEFAULTS)) {
    const value = Number(body[key]);
    // 0 disables pruning for that collection; anything above 5 years is a typo.
    if (body[key] !== undefined && body[key] !== null && body[key] !== '') {
      if (!Number.isFinite(value) || value < 0 || value > 1825) throw Object.assign(new Error(`Retention for ${key} must be 0–1825 days.`), {status: 400});
      out[key] = Math.floor(value);
    }
  }
  return out;
}

const cutoff = (days, now) => (days > 0 ? new Date(now - days * 86400000).toISOString() : null);

/** A record that never said when it happened is not old: the old parse fed the
 * number `now` into Date.parse, which is NaN, and every untimestamped record was
 * pruned as if it were ancient. */
const happenedAt = (record, keys, now) => {
  for (const key of keys) if (record[key]) return Date.parse(record[key]);
  return now;
};

/** Prune the workflow document. `dryRun` reports what would go without
 * touching the state, so the settings UI can preview a policy. */
export function pruneState(state, {now = Date.now(), dryRun = false, policy} = {}) {
  const settings = policy || normalizeRetention(state.settings?.retention);
  const report = {events: 0, doneTasks: 0, runs: 0, dryRun};
  const eventCutoff = cutoff(settings.events, now);
  const taskCutoff = cutoff(settings.doneTasks, now);
  const runCutoff = cutoff(settings.runs, now);
  if (eventCutoff) {
    const keep = state.events.filter(e => happenedAt(e, ['at', 'createdAt'], now) >= Date.parse(eventCutoff));
    report.events = state.events.length - keep.length;
    if (!dryRun) state.events = keep;
  }
  // The activity log is pruned with events: same window, counted with them.
  if (eventCutoff && Array.isArray(state.activity)) {
    const keep = state.activity.filter(a => happenedAt(a, ['at'], now) >= Date.parse(eventCutoff));
    report.events += state.activity.length - keep.length;
    if (!dryRun) state.activity = keep;
  }
  if (taskCutoff) {
    const keep = state.tasks.filter(t => !(['done', 'failed', 'cancelled'].includes(t.status) && happenedAt(t, ['completedAt', 'updatedAt'], now) < Date.parse(taskCutoff)));
    report.doneTasks = state.tasks.length - keep.length;
    if (!dryRun) state.tasks = keep;
  }
  if (runCutoff) {
    const keep = state.runs.filter(r => happenedAt(r, ['at'], now) >= Date.parse(runCutoff));
    report.runs = state.runs.length - keep.length;
    if (!dryRun) state.runs = keep;
    // Group runs are run records too, and they were never pruned at all, so the
    // transaction log grew with every message. A run that is still open is the
    // one a restart, a feed or a human approval resumes: only a settled one is
    // exhaust. They are counted in `runs` because that is the policy that owns
    // them and the preview the settings page shows.
    if (Array.isArray(state.groupRuns)) {
      const settled = Date.parse(runCutoff);
      const kept = state.groupRuns.filter(g => BUSY_STATUSES.includes(g.status) || happenedAt(g, ['completedAt', 'updatedAt', 'createdAt'], now) >= settled);
      report.runs += state.groupRuns.length - kept.length;
      if (!dryRun) state.groupRuns = kept;
    }
  }
  if (!dryRun && report.events + report.doneTasks + report.runs > 0) {
    activity(state, 'retention', `Pruned ${report.events} event(s), ${report.doneTasks} task record(s), ${report.runs} run record(s).`);
  }
  return report;
}
