/** Retention policy.
 *
 * The workflow document only grows: events, runs, finished tasks, sent
 * notifications. These are pure prune rules over the state object so the Node
 * server and the browser-local demo can apply them identically, plus a
 * workspace-level policy in settings. Nothing here deletes drafts, candidates
 * or evidence: those are the user's working material, not exhaust.
 */
import {activity} from './core.js?v=b58f2a921d';

export const RETENTION_DEFAULTS = {events: 90, doneTasks: 30, sentNotifications: 30, runs: 30};

export function normalizeRetention(body = {}) {
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

/** Prune the workflow document. `dryRun` reports what would go without
 * touching the state, so the settings UI can preview a policy. */
export function pruneState(state, {now = Date.now(), dryRun = false, policy} = {}) {
  const settings = policy || normalizeRetention(state.settings?.retention);
  const report = {events: 0, doneTasks: 0, runs: 0, dryRun};
  const eventCutoff = cutoff(settings.events, now);
  const taskCutoff = cutoff(settings.doneTasks, now);
  const runCutoff = cutoff(settings.runs, now);
  if (eventCutoff) {
    const keep = state.events.filter(e => Date.parse(e.at || e.createdAt || now) >= Date.parse(eventCutoff));
    report.events = state.events.length - keep.length;
    if (!dryRun) state.events = keep;
  }
  if (taskCutoff) {
    const keep = state.tasks.filter(t => !(['done', 'failed', 'cancelled'].includes(t.status) && Date.parse(t.completedAt || t.updatedAt || now) < Date.parse(taskCutoff)));
    report.doneTasks = state.tasks.length - keep.length;
    if (!dryRun) state.tasks = keep;
  }
  if (runCutoff) {
    const keep = state.runs.filter(r => Date.parse(r.at || now) >= Date.parse(runCutoff));
    report.runs = state.runs.length - keep.length;
    if (!dryRun) state.runs = keep;
  }
  if (!dryRun && report.events + report.doneTasks + report.runs > 0) {
    activity(state, 'retention', `Pruned ${report.events} event(s), ${report.doneTasks} task record(s), ${report.runs} run record(s).`);
  }
  return report;
}
