/** Pure workflow transitions over the persisted state object.
 *
 * Every function here is deterministic and side-effect free apart from mutating
 * the `state` it is given (a clone owned by the caller's store transaction).
 * They throw errors carrying an HTTP `status` so the same rules apply to the
 * Node HTTP routes and to any browser-local transport.
 *
 * Keeping transitions here is the single source of truth for the draft
 * lifecycle: candidate -> draft -> approved/scheduled -> ready -> posted.
 */
import {activity,candidateInput,cleanText,scheduleApproval} from './core.js?v=bf9b5298d4';
import {enqueueTask,cancelTask,migrateSchedules} from './tasks.js?v=bf9b5298d4';
import {evidenceSummary,evidenceForDraft,seedCandidateEvidence} from './evidence.js?v=bf9b5298d4';

export const SCHEMA_VERSION = 3;

export function fail(message, status = 400) {
  throw Object.assign(new Error(message), {status});
}

/** Add required coordination fields to legacy states. Idempotent. */
export function migrate(state) {
  if (!state || typeof state !== 'object') fail('Invalid stored state.', 500);
  state.settings ??= {};
  // A legacy `settings` can be an empty object or predate a field. Every UI
  // surface reads these (the Settings form calls `topics.join`, approvals read
  // the delay window), so they must be backfilled here rather than guarded in
  // each caller.
  if (!Array.isArray(state.settings.topics)) state.settings.topics = [];
  if (typeof state.settings.style !== 'string') state.settings.style = '';
  if (typeof state.settings.opinions !== 'string') state.settings.opinions = '';
  for (const key of ['minDelay', 'maxDelay']) {
    if (!Number.isInteger(state.settings[key])) state.settings[key] = key === 'minDelay' ? 2 : 10;
  }
  state.candidates ??= [];
  state.drafts ??= [];
  state.runs ??= [];
  state.tasks ??= [];
  state.evidence ??= [];
  state.events ??= [];
  state.groups ??= [];
  state.groupMessages ??= {};
  state.groupRuns ??= [];
  if (!Number.isInteger(state.version)) state.version = 1;
  // Passive reminder schedules become structured runnable tasks. Idempotent:
  // after this runs, `schedules` is always an empty array and never returns.
  state.schedules ??= [];
  migrateSchedules(state);
  state.version = Math.max(state.version, SCHEMA_VERSION);
  return state;
}

export function findDraft(state, id) {
  const draft = state.drafts.find(x => x.id === id);
  if (!draft) fail('Draft not found.', 404);
  return draft;
}
export function findCandidate(state, id) {
  const item = state.candidates.find(x => x.id === id);
  if (!item) fail('Candidate not found.', 404);
  return item;
}

export function updateSettings(state, body) {
  if (body.style !== undefined) state.settings.style = cleanText(body.style, 1000);
  if (body.opinions !== undefined) state.settings.opinions = cleanText(body.opinions, 1000);
  if (body.topics !== undefined) {
    if (!Array.isArray(body.topics)) fail('Topics must be an array.');
    state.settings.topics = body.topics.slice(0, 30).map(v => cleanText(v, 60)).filter(Boolean);
  }
  if (body.minDelay !== undefined || body.maxDelay !== undefined) {
    const a = body.minDelay ?? state.settings.minDelay;
    const c = body.maxDelay ?? state.settings.maxDelay;
    if (!Number.isInteger(a) || !Number.isInteger(c) || a < 0 || c > 1440 || a > c) fail('Invalid delay window.');
    state.settings.minDelay = a;
    state.settings.maxDelay = c;
  }
  activity(state, 'settings', 'Updated user preferences.');
  return state.settings;
}

export function addCandidate(state, body) {
  const input = candidateInput(body);
  const existing = state.candidates.find(c => c.url === input.url && c.text === input.text);
  if (existing) return {candidate: existing, duplicate: true};
  const candidate = {...input, id: crypto.randomUUID(), status: 'new', createdAt: new Date().toISOString()};
  state.candidates.unshift(candidate);
  seedCandidateEvidence(state, candidate);
  activity(state, 'capture', `Added a candidate from ${input.author}.`, {candidateId: candidate.id});
  return {candidate, duplicate: false};
}

export function seedDemo(state, sample = []) {
  let count = 0;
  for (const b of sample) {
    if (state.candidates.some(c => c.url === b.url)) continue;
    const candidate = {...b, id: crypto.randomUUID(), status: 'new', createdAt: new Date().toISOString(), demo: true};
    state.candidates.push(candidate);
    seedCandidateEvidence(state, candidate);
    count++;
  }
  activity(state, 'demo', `Loaded ${count} demo candidate(s).`);
  return {added: count};
}

export function beginProcessing(state, id) {
  const c = findCandidate(state, id);
  if (c.status === 'processing') fail('Candidate already processing.', 409);
  c.status = 'processing';
  return {candidate: structuredClone(c), settings: structuredClone(state.settings)};
}

export function finishProcessing(state, id, evaluation, generated) {
  const c = findCandidate(state, id);
  c.status = 'drafted';
  c.score = evaluation;
  // Every draft starts with its captured source recorded as unverified
  // evidence; the evidence model is what makes "check claims before posting"
  // a state transition instead of a warning label.
  seedCandidateEvidence(state, c);
  const draft = {
    id: crypto.randomUUID(), candidateId: id, author: c.author, url: c.url, sourceText: c.text,
    text: generated.text, revision: 1, status: 'pending', score: evaluation.score,
    mode: generated.mode, note: generated.note, createdAt: new Date().toISOString(),
    evidence: evidenceSummary(state.evidence.filter(e => e.candidateId === id)),
  };
  state.drafts.unshift(draft);
  activity(state, 'draft', `Created ${generated.mode} draft for ${c.author}.`, {draftId: draft.id});
  return draft;
}

export function failProcessing(state, id, message) {
  findCandidate(state, id).status = 'error';
  activity(state, 'error', `Draft failed: ${String(message).slice(0, 160)}`);
}

export function editDraft(state, id, text) {
  const body = cleanText(text, 3000);
  if (!body) fail('Draft cannot be empty.');
  const d = findDraft(state, id);
  if (!['pending', 'scheduled', 'ready'].includes(d.status)) fail('Draft cannot be edited in this state.', 409);
  // Editing always invalidates an earlier approval and its schedule.
  d.text = body;
  d.revision++;
  d.status = 'pending';
  delete d.approvedText; delete d.approvedRevision; delete d.dueAt; delete d.approvedAt;
  delete d.approvedEvidence;
  activity(state, 'edit', `Edited draft. Revision ${d.revision}; previous approval cleared.`, {draftId: d.id});
  return d;
}

export function rewriteDraft(state, id, generated) {
  const x = findDraft(state, id);
  if (!['pending', 'scheduled', 'ready'].includes(x.status)) fail('Cannot rewrite this draft.', 409);
  x.text = generated.text;
  x.revision++;
  x.status = 'pending';
  x.mode = generated.mode;
  x.note = generated.note;
  delete x.approvedText; delete x.approvedRevision; delete x.dueAt; delete x.approvedAt;
  delete x.approvedEvidence;
  activity(state, 'rewrite', `Rewrote draft ${x.id}.`, {draftId: x.id});
  return x;
}

export function draftAction(state, id, action, body = {}) {
  const x = findDraft(state, id);
  if (action === 'approve') {
    // The evidence gate: disputed source material blocks approval, the same
    // way an empty draft does. Confidence values alone never unblock it.
    const summary = evidenceSummary(evidenceForDraft(state, id));
    if (!summary.approved) fail('Resolve disputed evidence before approving this draft.', 409);
    scheduleApproval(x, body.minDelay ?? state.settings.minDelay, body.maxDelay ?? state.settings.maxDelay);
    // Freeze the evidence picture the approval was made against, so a later
    // evidence edit can never retroactively change what was approved.
    x.approvedEvidence = evidenceForDraft(state, id).map(e => structuredClone(e));
    activity(state, 'approve', `Approved exact revision ${x.revision}.`, {draftId: id, dueAt: x.dueAt, evidence: summary.level});
  } else if (action === 'reject') {
    if (!['pending', 'scheduled', 'ready'].includes(x.status)) fail('Cannot reject this draft.', 409);
    x.status = 'rejected';
    activity(state, 'reject', 'Rejected draft.', {draftId: id});
  } else if (action === 'ready') {
    if (x.status !== 'scheduled') fail('Only scheduled drafts can become ready.', 409);
    x.status = 'ready';
    activity(state, 'ready', 'Draft released for manual posting.', {draftId: id});
  } else if (action === 'posted') {
    if (x.status !== 'ready') fail('Only ready drafts may be marked posted.', 409);
    if (x.approvedRevision !== x.revision || x.approvedText !== x.text) fail('Approval no longer matches draft.', 409);
    x.status = 'posted';
    x.postedAt = new Date().toISOString();
    activity(state, 'posted', 'User marked a draft as posted manually.', {draftId: id});
  }
  return x;
}

export function addGroup(state, body) {
  const name = cleanText(body.name, 80);
  if (!name) fail('Group name required.');
  const g = {id: crypto.randomUUID(), name, description: cleanText(body.description, 300), bots: []};
  state.groups.push(g);
  activity(state, 'group', `Created group ${name}.`);
  return g;
}

export function addBot(state, groupId, body) {
  const name = cleanText(body.name, 80);
  const instructions = cleanText(body.instructions, 3000);
  if (!name || !instructions) fail('Bot name and instructions required.');
  const g = state.groups.find(x => x.id === groupId);
  if (!g) fail('Group not found.', 404);
  const bot = {id: crypto.randomUUID(), name, instructions, type: 'custom'};
  g.bots.push(bot);
  activity(state, 'bot', `Created bot ${name}.`);
  return bot;
}

/** Persist a lasting bot profile edit. The group record is the single source of
 * truth, so name/instructions are never mirrored into browser-local UI state. */
export function updateBot(state, groupId, botId, body) {
  const g = state.groups.find(x => x.id === groupId);
  if (!g) fail('Group not found.', 404);
  const bot = g.bots.find(x => x.id === botId);
  if (!bot) fail('Bot not found.', 404);
  const name = cleanText(body.name, 80);
  const instructions = cleanText(body.instructions, 3000);
  if (!name || !instructions) fail('Bot name and instructions required.');
  bot.name = name;
  bot.instructions = instructions;
  activity(state, 'bot', `Updated bot ${name}.`);
  return bot;
}

/** Release candidates stranded in `processing` by a crash mid-draft.
 * Without this a restart leaves them permanently unprocessable: beginProcessing
 * rejects `processing` forever, so the post can never be drafted again. */
export function recoverInterrupted(state) {
  let recovered = 0;
  for (const c of state.candidates) {
    if (c.status === 'processing') { c.status = 'new'; recovered++; }
  }
  if (recovered) activity(state, 'recovery', `Released ${recovered} candidate(s) interrupted by a restart.`);
  return {recovered};
}


/** Reminder compatibility layer: the UI and both transports still create
 * reminders through these helpers, but the record they write is a structured
 * `reminder`-kind task with retries, leases and status events. */
export function addSchedule(state, body) {
  const task = enqueueTask(state, {kind: 'reminder', payload: {label: body.label, kind: body.kind, intervalMinutes: body.intervalMinutes, nextAt: body.nextAt}}).task;
  return scheduleView(task);
}

export function removeSchedule(state, id) {
  const task = state.tasks.find(t => t.id === id && t.kind === 'reminder');
  if (!task) fail('Schedule not found.', 404);
  cancelTask(state, id);
  return {ok: true};
}

/** Backwards-compatible shape for older UI callers: the live task projected
 * into the fields the schedule list used to show. */
const scheduleView = task => ({
  id: task.id,
  label: task.payload.label,
  kind: task.payload.kind,
  nextAt: task.runAt,
  intervalMinutes: task.intervalMinutes,
  enabled: task.status === 'queued' || task.status === 'running',
});

export function resetDemo(state) {
  state.candidates = state.candidates.filter(x => !x.demo);
  state.drafts = state.drafts.filter(x => state.candidates.some(c => c.id === x.candidateId));
  activity(state, 'demo', 'Removed demo candidates and drafts.');
  return {ok: true};
}