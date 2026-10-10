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
import {activity,candidateInput,cleanText,scheduleApproval} from './core.js?v=57fe428a9e';

export const SCHEMA_VERSION = 2;

export function fail(message, status = 400) {
  throw Object.assign(new Error(message), {status});
}

/** Add required coordination fields to legacy states. Idempotent. */
export function migrate(state) {
  if (!state || typeof state !== 'object') fail('Invalid stored state.', 500);
  state.settings ??= {};
  state.candidates ??= [];
  state.drafts ??= [];
  state.runs ??= [];
  state.schedules ??= [];
  state.events ??= [];
  state.groups ??= [];
  state.groupMessages ??= {};
  state.groupRuns ??= [];
  if (!Number.isInteger(state.version)) state.version = 1;
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
  activity(state, 'capture', `Added a candidate from ${input.author}.`, {candidateId: candidate.id});
  return {candidate, duplicate: false};
}

export function seedDemo(state, sample = []) {
  let count = 0;
  for (const b of sample) {
    if (state.candidates.some(c => c.url === b.url)) continue;
    state.candidates.push({...b, id: crypto.randomUUID(), status: 'new', createdAt: new Date().toISOString(), demo: true});
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
  const draft = {
    id: crypto.randomUUID(), candidateId: id, author: c.author, url: c.url, sourceText: c.text,
    text: generated.text, revision: 1, status: 'pending', score: evaluation.score,
    mode: generated.mode, note: generated.note, createdAt: new Date().toISOString(),
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
  activity(state, 'rewrite', `Rewrote draft ${x.id}.`, {draftId: x.id});
  return x;
}

export function draftAction(state, id, action, body = {}) {
  const x = findDraft(state, id);
  if (action === 'approve') {
    scheduleApproval(x, body.minDelay ?? state.settings.minDelay, body.maxDelay ?? state.settings.maxDelay);
    activity(state, 'approve', `Approved exact revision ${x.revision}.`, {draftId: id, dueAt: x.dueAt});
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

export function addSchedule(state, body) {
  const label = cleanText(body.label, 200);
  const kind = body.kind;
  if (!label || !['once', 'interval'].includes(kind)) fail('Label and valid schedule kind required.');
  let nextAt, intervalMinutes = null;
  if (kind === 'once') {
    const when = Date.parse(body.nextAt);
    if (!Number.isFinite(when) || when < Date.now() + 1000 || when > Date.now() + 365 * 86400000) fail('Choose a future date within one year.');
    nextAt = new Date(when).toISOString();
  } else {
    intervalMinutes = Number(body.intervalMinutes);
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 10080) fail('Interval must be 1–10080 minutes.');
    nextAt = new Date(Date.now() + intervalMinutes * 60000).toISOString();
  }
  const item = {id: crypto.randomUUID(), label, kind, nextAt, intervalMinutes, enabled: true};
  state.schedules.unshift(item);
  activity(state, 'schedule', `Added reminder: ${label}`);
  return item;
}

export function removeSchedule(state, id) {
  const i = state.schedules.findIndex(x => x.id === id);
  if (i < 0) fail('Schedule not found.', 404);
  const item = state.schedules.splice(i, 1)[0];
  activity(state, 'schedule', `Removed reminder: ${item.label}`);
  return {ok: true};
}

export function resetDemo(state) {
  state.candidates = state.candidates.filter(x => !x.demo);
  state.drafts = state.drafts.filter(x => state.candidates.some(c => c.id === x.candidateId));
  activity(state, 'demo', 'Removed demo candidates and drafts.');
  return {ok: true};
}