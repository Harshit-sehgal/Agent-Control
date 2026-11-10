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
import {activity,candidateInput,cleanText,scheduleApproval,scheduleApprovalAt,scoreCandidate,validHttpUrl} from './core.js?v=b874c836b3';
import {fail} from './errors.js?v=b874c836b3';

// How far ahead an approval may be pinned. A year-long pin is not a schedule a
// person can still be sure of, and a draft nobody looks at again is worse than
// one that goes out on the delay window.
const APPROVAL_HORIZON_MS = 7*24*60*60*1000;
const APPROVAL_LEAD_MS = 60*1000;
import {enqueueTask,cancelTask,migrateSchedules} from './tasks.js?v=b874c836b3';
import {evidenceSummary,evidenceForDraft,seedCandidateEvidence} from './evidence.js?v=b874c836b3';
import {normalizeRetention} from './retention.js?v=b874c836b3';
import * as contracts from './contracts.js?v=b874c836b3';
import {pruneChats, releaseChatWork} from './chats.js?v=b874c836b3';
import {denyBrowserRequest} from './bot-browser.js?v=b874c836b3';
import {BUSY_STATUSES} from './coordination.js?v=b874c836b3';
import {validateBotSettings, validateGroupSettings, prunePipeline} from './bot-settings.js?v=b874c836b3';
import {memoryState} from './memory.js?v=b874c836b3';
import {MAX_BOTS_PER_GROUP} from './bot-create.js?v=b874c836b3';

export const SCHEMA_VERSION = 3;
/** Posts are never pruned by age, so their number is bounded here. */
export const MAX_CANDIDATES = 2000;

export {fail};

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
  if (!Array.isArray(state.browserRequests)) state.browserRequests = [];
  // Bring-your-own-key AI providers and the workspace/bot model choices.
  state.ai ??= {};
  state.ai.providers ??= [];
  state.ai.bots ??= {};
  if (state.ai.defaultProviderId === undefined) state.ai.defaultProviderId = null;
  if (state.ai.defaultModel === undefined) state.ai.defaultModel = null;
  // Durable per-chat recaps and per-model rulebooks (see shared/memory.js).
  memoryState(state);
  pruneChats(state);
  // Backfill bot contracts and permissions. An older stored bot gains the
  // defaults for its type; explicitly configured values are left alone.
  for (const g of state.groups) {
    for (const b of g.bots || []) contracts.normalizeBot(b);
    prunePipeline(g);
  }
  // X-engage has one bot you talk to. Older workspaces gain it on Handoff
  // unless someone has already picked a primary.
  const x = state.groups.find(g => g.id === 'x-engage');
  if (x && !(x.bots || []).some(b => b.settings?.lead)) {
    const hand = (x.bots || []).find(b => b.id === 'handoff');
    if (hand) hand.settings = {...(hand.settings || {}), lead: true};
  }
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
  if (body.retention !== undefined) state.settings.retention = normalizeRetention(body.retention);
  activity(state, 'settings', 'Updated user preferences.');
  return state.settings;
}

export function addCandidate(state, body) {
  if ((state.candidates || []).length >= MAX_CANDIDATES) fail(`This workspace already holds ${MAX_CANDIDATES} posts. Remove some before adding more.`, 409);
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
  // Processing a post that already has a draft waiting on a person is the same
  // work twice: `finishProcessing` unshifts, so the queue showed two identical
  // drafts for one post and approving either left the other behind.
  if ((state.drafts || []).some(d => d.candidateId === id && d.status === 'pending')) fail('That post already has a draft waiting on you.', 409);
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

const DRAFT_REFUSAL = /cannot draft|no post|nothing to draft|no draft/i;
/** A shorter captured URL must not match a longer one that merely starts with it. */
function citesUrl(hay, url) {
  let from = 0;
  while (from <= hay.length) {
    const at = hay.indexOf(url, from);
    if (at < 0) return false;
    const next = hay[at + url.length];
    if (next === undefined || /[\s)\].,;!?'"<>]/.test(next)) return true;
    from = at + url.length;
  }
  return false;
}

/** A writing step that holds `draft.create` becomes a pending draft when the
 * run names a captured post that does not already have one. The bot's own
 * text is the draft. No second model call. */
export function attachRunDraft(state, {bot, output, sources = '', runId = null} = {}) {
  const permissions = Array.isArray(bot?.permissions) ? bot.permissions : contracts.defaultPermissions(bot?.type);
  if (!permissions.includes('draft.create')) return null;
  const text = cleanText(output, 1700);
  if (text.length < 40 || DRAFT_REFUSAL.test(text)) return null;
  const hay = String(sources);
  const candidate = (state.candidates || [])
    .filter(c => c?.url && citesUrl(hay, c.url) && c.status !== 'processing' && !(state.drafts || []).some(d => d.candidateId === c.id))
    .sort((a, b) => b.url.length - a.url.length)[0];
  if (!candidate) return null;
  const draft = finishProcessing(state, candidate.id, scoreCandidate(candidate, state.settings?.topics || []), {
    text, mode: 'ai', note: 'Drafted in the group run. Read it before you approve.',
  });
  if (runId) draft.runId = runId;
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
    if (summary.disputed > 0) fail('Resolve disputed evidence before approving this draft.', 409);
    // Material marked "do not reuse" cannot be published, whatever anyone thinks
    // of it, so it blocks the same way a dispute does — with its own reason.
    if (summary.reuseBlocked > 0) fail(`${summary.reuseBlocked} piece${summary.reuseBlocked === 1 ? '' : 's'} of this draft's evidence is marked "do not reuse". Remove it or change the reuse policy before approving.`, 409);
    if (body.dueAt) {
      // A time a person picked replaces the delay window, and is checked here
      // rather than in the browser: the same rule has to hold for the extension
      // and for anything else that posts to this route.
      const at = new Date(body.dueAt).getTime();
      if (!Number.isFinite(at)) fail('That time cannot be read.');
      if (at < Date.now()+APPROVAL_LEAD_MS) fail('Pick a time at least a minute from now.');
      if (at > Date.now()+APPROVAL_HORIZON_MS) fail('Pick a time within the next 7 days.');
      scheduleApprovalAt(x, at);
    } else {
      scheduleApproval(x, body.minDelay ?? state.settings.minDelay, body.maxDelay ?? state.settings.maxDelay);
    }
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
  } else if (action === 'restore') {
    // Skipping is one click and confirmed, but a confirmed accident is still an
    // accident: the captured post and its evidence are untouched, so the draft can
    // come back to the queue instead of being written again from scratch.
    if (x.status !== 'rejected') fail('Only a skipped draft can be restored.', 409);
    x.status = 'pending';
    delete x.postedAt; delete x.postedUrl;
    activity(state, 'restore', 'Restored a skipped draft to the queue.', {draftId: id});
  } else if (action === 'posted') {
    if (x.status !== 'ready') fail('Only ready drafts may be marked posted.', 409);
    if (x.approvedRevision !== x.revision || x.approvedText !== x.text) fail('Approval no longer matches draft.', 409);
    // The link is optional, but a link that is not one is not recorded: the panel
    // renders it as an anchor, and an unusable href is a dead button.
    const posted = cleanText(body.url, 500);
    if (posted && !validHttpUrl(posted)) fail('That post link is not a web address.');
    x.status = 'posted';
    x.postedAt = new Date().toISOString();
    if (posted) x.postedUrl = posted;
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
  // The same limit a model-created bot meets. A person can raise it by removing
  // a bot; nothing may grow a group past it, and two bots cannot share a name.
  if ((g.bots || []).length >= MAX_BOTS_PER_GROUP) fail(`This group already has ${MAX_BOTS_PER_GROUP} bots. Remove one first.`, 409);
  if (g.bots.some(bot => bot.name.trim().toLowerCase() === name.toLowerCase())) fail(`A bot named ${name} is already in this group.`, 409);
  const bot = contracts.normalizeBot({
    id: crypto.randomUUID(), name, instructions, type: 'custom',
    contract: contracts.validateContract(body.contract),
    permissions: contracts.validatePermissions(body.permissions),
  });
  if (body.settings !== undefined) bot.settings = validateBotSettings(body.settings);
  g.bots.push(bot);
  if (bot.settings?.lead) for (const other of g.bots) if (other !== bot && other.settings?.lead) other.settings = {...other.settings, lead: false};
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
  // Every field only changes when explicitly provided, so a form that saves
  // just one field cannot silently drop a permission or a setting.
  const name = body.name === undefined ? bot.name : cleanText(body.name, 80);
  const instructions = body.instructions === undefined ? bot.instructions : cleanText(body.instructions, 3000);
  if (!name || !instructions) fail('Bot name and instructions required.');
  // One name per group, the same rule addBot and a model-created bot meet. A
  // rename is how a duplicate used to slip in, and findPeer/mentionedBots
  // resolve a name to whichever bot is first in the roster, so a handoff would
  // land on the wrong teammate.
  if (g.bots.some(other => other !== bot && other.name.trim().toLowerCase() === name.toLowerCase())) fail(`A bot named ${name} is already in this group.`, 409);
  const settings = body.settings === undefined ? undefined : validateBotSettings(body.settings, bot.settings);
  if (body.contract !== undefined) bot.contract = contracts.validateContract(body.contract);
  if (body.permissions !== undefined) bot.permissions = contracts.validatePermissions(body.permissions);
  bot.name = name;
  bot.instructions = instructions;
  if (settings) bot.settings = settings;
  if (bot.settings?.lead) for (const other of g.bots) if (other !== bot && other.settings?.lead) other.settings = {...other.settings, lead: false};
  activity(state, 'bot', `Updated bot ${name}.`);
  return bot;
}

const findGroup = (state, groupId) => state.groups.find(x => x.id === groupId) || fail('Group not found.', 404);
/** Scheduled bot tasks that would otherwise fire at a bot or group that is gone. */
function cancelBotTasks(state, match) {
  for (const t of state.tasks || []) {
    // `running` as well as `queued`: an in-flight interval would otherwise
    // complete and re-arm after the bot or group is already gone.
    if (t.kind !== 'bot-task' || !['queued', 'running'].includes(t.status) || !match(t.payload || {})) continue;
    t.status = 'cancelled';
    t.updatedAt = new Date().toISOString();
  }
}
function forgetBot(state, botId) {
  if (state.ai?.bots) delete state.ai.bots[botId];
  if (state.chats) delete state.chats[botId];
  releaseChatWork(state, botId);
  const now = new Date().toISOString();
  for (const request of state.browserRequests || []) {
    if (request.botId !== botId || !['pending', 'dispatched'].includes(request.status)) continue;
    try { denyBrowserRequest(state, request.id); }
    catch { request.status = 'denied'; request.updatedAt = now; }
  }
  for (const run of state.groupRuns || []) {
    if (!BUSY_STATUSES.includes(run.status)) continue;
    const waiting = ['awaiting_feed', 'awaiting_browser'].includes(run.status)
      && (state.browserRequests || []).some(r => r.runId === run.id && r.botId === botId && r.status === 'denied');
    const referencesBot = (run.recipients || []).includes(botId) || (run.guestIds || []).includes(botId)
      || (run.trace || []).some(step => step.botId === botId || step.toBotId === botId);
    if (run.chatKey !== botId && !waiting && !referencesBot) continue;
    run.status = 'cancelled';
    run.error = 'Bot removed.';
    run.updatedAt = now;
  }
}

export function updateGroup(state, groupId, body = {}) {
  const g = findGroup(state, groupId);
  const name = body.name === undefined ? g.name : cleanText(body.name, 80);
  if (!name) fail('Group name required.');
  if (typeof body.description === 'string' && body.description.trim().length > 300) fail('Description must be 300 characters or fewer.');
  const settings = body.settings === undefined ? undefined : validateGroupSettings(g, body.settings, g.settings);
  g.name = name;
  if (body.description !== undefined) g.description = cleanText(body.description, 300);
  if (settings) g.settings = settings;
  activity(state, 'group', `Updated group ${name}.`);
  return g;
}

export function removeBot(state, groupId, botId) {
  const g = findGroup(state, groupId);
  const bot = g.bots.find(x => x.id === botId);
  if (!bot) fail('Bot not found.', 404);
  // A pipeline is an explicit choice of which bots run, and `null` means "every
  // bot". Removing its last bot would therefore switch the group to bots the
  // person never picked once prunePipeline clears the emptied list, so the
  // choice has to be changed first. Entries already pointing at a bot that left
  // are ignored: they are not a choice the group can still honour.
  const pipeline = Array.isArray(g.settings?.pipeline) ? g.settings.pipeline.filter(id => g.bots.some(b => b.id === id)) : [];
  if (pipeline.includes(botId) && pipeline.every(id => id === botId)) {
    fail(`${bot.name} is the only bot in this group's pipeline. Add another bot to the pipeline, or clear it, before removing ${bot.name}.`, 409);
  }
  g.bots = g.bots.filter(x => x.id !== botId);
  prunePipeline(g);
  forgetBot(state, botId);
  cancelBotTasks(state, p => p.botId === botId);
  activity(state, 'bot', `Removed bot ${bot.name}.`);
  return {ok: true};
}

export function removeGroup(state, groupId) {
  const g = findGroup(state, groupId);
  if (g.id === 'x-engage') fail('The X-engage group cannot be deleted.', 409);
  state.groups = state.groups.filter(x => x.id !== groupId);
  for (const b of g.bots) forgetBot(state, b.id);
  if (state.chats) delete state.chats[`team-${groupId}`];
  if (state.groupMessages) delete state.groupMessages[groupId];
  releaseChatWork(state, `team-${groupId}`);
  const now = new Date().toISOString();
  for (const run of state.groupRuns || []) {
    if (run.groupId !== groupId || !BUSY_STATUSES.includes(run.status)) continue;
    run.status = 'cancelled';
    run.error = 'Group removed.';
    run.updatedAt = now;
  }
  cancelBotTasks(state, p => p.groupId === groupId);
  activity(state, 'group', `Removed group ${g.name}.`);
  return {ok: true};
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
  // "Every 60 minutes" begins with a window, not with a run. Firing the moment the
  // reminder is saved reads as a duplicate and spends a paid group run nobody
  // asked for yet; the migration path already gives a legacy interval its next
  // fire instead of starting it at `now`.
  if (task.payload?.kind === 'interval' && !body.nextAt) {
    task.runAt = new Date(Date.parse(task.createdAt) + task.intervalMinutes * 60000).toISOString();
  }
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

/** Replace the capture token.
 *
 * The token is a long-lived secret: any browser holding it can capture into this
 * workspace. Until this existed the only way to retire a leaked one was to wipe
 * the workspace, so a laptop sold, a token pasted into the wrong extension, or a
 * shared bookmark cost the whole document. Captures look the token up against
 * the workspace's current value, so the old one stops working the moment this
 * lands, and the extension needs the new one pasted in.
 */
export function rotateCaptureToken(state) {
  state.captureToken = crypto.randomUUID().replaceAll('-', '');
  activity(state, 'settings', 'Replaced the capture token.');
  return {captureToken: state.captureToken};
}

/** Remove a captured post and the work nobody committed to.
 *
 * Drafts that are still `pending` or were `rejected` are work in progress, so
 * they go with the capture that produced them, and so does their source
 * evidence. A `scheduled`, `ready` or `posted` draft is a commitment a person
 * made - approved, queued for a window, or already out - and deleting the
 * capture under it would withdraw that approval without asking. Those refuse and
 * name what has to go first. */
export function removeCandidate(state, id) {
  const candidate = findCandidate(state, id);
  const drafts = state.drafts.filter(d => d.candidateId === id);
  const committed = drafts.find(d => ['scheduled', 'ready', 'posted'].includes(d.status));
  if (committed) fail(`This post has a ${committed.status} draft, and removing it would withdraw an approval nobody withdrew. Remove the draft first.`, 409);
  const draftIds = new Set(drafts.map(d => d.id));
  state.drafts = state.drafts.filter(d => !draftIds.has(d.id));
  state.candidates = state.candidates.filter(c => c.id !== id);
  state.evidence = (state.evidence || []).filter(e => e.candidateId !== id && !draftIds.has(e.draftId));
  activity(state, 'capture', `Removed a captured post from ${candidate.author || 'X'}.`, {candidateId: id});
  return {ok: true};
}

export function resetDemo(state) {
  state.candidates = state.candidates.filter(x => !x.demo);
  state.drafts = state.drafts.filter(x => state.candidates.some(c => c.id === x.candidateId));
  // Evidence belongs to a candidate, so a reset that keeps candidates must drop
  // the rows whose candidate is gone, or every seed/reset cycle leaves orphans.
  state.evidence = (state.evidence || []).filter(e => state.candidates.some(c => c.id === e.candidateId));
  activity(state, 'demo', 'Removed demo candidates and drafts.');
  return {ok: true};
}
