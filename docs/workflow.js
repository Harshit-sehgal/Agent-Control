/** Pure workflow transitions over the persisted state object.
 *
 * Every function here is deterministic and side-effect free apart from mutating
 * the `state` it is given (a clone owned by the caller's store transaction).
 * They throw errors carrying an HTTP `status` so the same rules apply to the
 * Node HTTP routes and to any browser-local transport.
 */
import {activity,cleanText,initialState} from './core.js?v=4c9d292766';
import {fail} from './errors.js?v=4c9d292766';
import {cancelTask} from './tasks.js?v=4c9d292766';
import {normalizeRetention} from './retention.js?v=4c9d292766';
import * as contracts from './contracts.js?v=4c9d292766';
import {pruneChats, releaseChatWork} from './chats.js?v=4c9d292766';
import {denyBrowserRequest} from './bot-browser.js?v=4c9d292766';
import {BUSY_STATUSES} from './coordination.js?v=4c9d292766';
import {validateBotSettings, validateGroupSettings, prunePipeline} from './bot-settings.js?v=4c9d292766';
import {memoryState} from './memory.js?v=4c9d292766';
import {MAX_BOTS_PER_GROUP} from './bot-create.js?v=4c9d292766';
import {freshGuard} from './runaway.js?v=4c9d292766';
import {sweepGrants, forgetBotAsks, lapseOrphans} from './asks.js?v=4c9d292766';
import {assertManager, releaseReports, companyBots, PRIMARY_GROUP, primaryOf, isPrimary} from './company.js?v=4c9d292766';
import {logActivity} from './activity-log.js?v=4c9d292766';

export const SCHEMA_VERSION = 3;

export {fail};

/** Add required coordination fields to legacy states. Idempotent. */
export function migrate(state) {
  if (!state || typeof state !== 'object') fail('Invalid stored state.', 500);
  state.settings ??= {};
  state.runs ??= [];
  state.tasks ??= [];
  state.events ??= [];
  state.groups ??= [];
  seedPrimary(state);
  state.groupMessages ??= {};
  state.groupRuns ??= [];
  // The runaway guard's window and pause flag (shared/runaway.js).
  if (!state.guard || typeof state.guard !== 'object') state.guard = freshGuard();
  // Asks waiting on the owner, the grants their answers left, and the activity log
  // (shared/asks.js, shared/activity-log.js). A grant for a bot that is gone is dropped.
  if (!Array.isArray(state.asks)) state.asks = [];
  if (!Array.isArray(state.activity)) state.activity = [];
  sweepGrants(state);
  lapseOrphans(state);
  // X home-feed reading is gone. A run parked on it can never resume, and it
  // would hold its group busy, so it loads as cancelled.
  for (const run of [...state.runs, ...state.groupRuns]) {
    if (run?.status !== 'awaiting_feed') continue;
    run.status = 'cancelled';
    run.error = 'X feed reading was removed';
  }
  // X-engage's records and settings are gone. A workspace saved before it was
  // removed still carries them; they are dropped rather than kept forever.
  for (const key of ['candidates', 'drafts', 'evidence', 'schedules', 'captureToken']) delete state[key];
  for (const key of ['topics', 'style', 'opinions', 'minDelay', 'maxDelay']) delete state.settings[key];
  // Reminders and candidate drafting went with X-engage. A queued one has no
  // handler left to run it, so it loads as cancelled instead of failing.
  for (const task of state.tasks) {
    if (!['reminder', 'candidate-draft'].includes(task?.kind) || ['done', 'failed', 'cancelled'].includes(task.status)) continue;
    task.status = 'cancelled';
    task.lastError = 'This task kind was removed with X-engage';
  }
  if (!Array.isArray(state.browserRequests)) state.browserRequests = [];
  // The X feed read went with X-engage. Its page request would otherwise still
  // wait on a person, and approving it would read x.com for a run that is gone.
  for (const request of state.browserRequests) {
    if (request?.purpose !== 'feed' || !['pending', 'dispatched'].includes(request.status)) continue;
    try { denyBrowserRequest(state, request.id); } catch { request.status = 'denied'; }
  }
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
  if (!Number.isInteger(state.version)) state.version = 1;
  state.version = Math.max(state.version, SCHEMA_VERSION);
  return state;
}

/** The company always has a primary bot: a load that finds none (an older state, or a doctored
 * backup) makes the first home bot the primary, or brings Atlas back to an empty or missing home. */
function seedPrimary(state) {
  if (!Array.isArray(state.groups)) return;
  if (primaryOf(state)) return;
  let home = state.groups.find(g => g?.id === PRIMARY_GROUP);
  if (!home) state.groups.push(home = {id: PRIMARY_GROUP, name: 'Home', description: 'Your bots', bots: []});
  home.bots = Array.isArray(home.bots) ? home.bots : [];
  if (!home.bots.length) {
    const atlas = structuredClone(initialState().groups[0].bots[0]);
    if (companyBots(state).some(b => b.id === atlas.id)) atlas.id = crypto.randomUUID();
    home.bots.push(atlas);
  }
  const first = home.bots[0];
  first.settings = {...(first.settings || {}), lead: true, reportsTo: null};
}

/** A bot that is lead of its group is the only one; in the home group that makes it the primary, which
 * reports to no one. */
function takeLead(g, bot) {
  if (!bot.settings?.lead) return;
  if (g.id === PRIMARY_GROUP) bot.settings = {...bot.settings, reportsTo: null};
  for (const other of g.bots) if (other !== bot && other.settings?.lead) other.settings = {...other.settings, lead: false};
}

/** The only workspace setting left is the retention policy. */
export function updateRetention(state, retention) {
  state.settings.retention = normalizeRetention(retention);
  activity(state, 'settings', 'Updated the retention policy.');
  return state;
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
  if (bot.settings?.reportsTo) assertManager(state, bot.id, bot.settings.reportsTo);
  g.bots.push(bot);
  takeLead(g, bot);
  activity(state, 'bot', `Created bot ${name}.`);
  logActivity(state, {botId: bot.id, kind: 'bots', text: `${name} was created.`});
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
  // The primary stops being primary only when another bot takes the role (a PATCH on that bot); turning
  // it off here would leave the company with none, and then the old primary could be deleted.
  if (settings && !settings.lead && isPrimary(state, bot.id)) fail(`${bot.name} is the primary bot. Make another bot the primary instead.`, 409);
  if (settings && settings.reportsTo !== (bot.settings?.reportsTo ?? null)) assertManager(state, bot.id, settings.reportsTo);
  if (body.contract !== undefined) bot.contract = contracts.validateContract(body.contract);
  if (body.permissions !== undefined) bot.permissions = contracts.validatePermissions(body.permissions);
  const wasOn = bot.settings?.enabled !== false, wasUnder = bot.settings?.reportsTo ?? null;
  bot.name = name;
  bot.instructions = instructions;
  if (settings) bot.settings = settings;
  // Moved, paused and resumed are events the owner may need to find; a rename or an edit is not.
  if (settings && (settings.reportsTo ?? null) !== wasUnder) {
    const boss = settings.reportsTo ? companyBots(state).find(b => b.id === settings.reportsTo)?.name : null;
    logActivity(state, {botId: bot.id, kind: 'bots', text: boss ? `${name} now reports to ${boss}.` : `${name} now works on its own.`});
  }
  if (settings && (settings.enabled !== false) !== wasOn) logActivity(state, {botId: bot.id, kind: 'bots', text: `${name} was ${wasOn ? 'paused' : 'resumed'}.`});
  takeLead(g, bot);
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
  forgetBotAsks(state, botId);
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
    const waiting = run.status === 'awaiting_browser'
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
  releaseReports(state, botId);
  g.bots = g.bots.filter(x => x.id !== botId);
  prunePipeline(g);
  forgetBot(state, botId);
  cancelBotTasks(state, p => p.botId === botId);
  activity(state, 'bot', `Removed bot ${bot.name}.`);
  logActivity(state, {botId: botId, kind: 'bots', text: `${bot.name} was deleted.`});
  return {ok: true};
}

export function removeGroup(state, groupId) {
  const g = findGroup(state, groupId);
  if (g.id === PRIMARY_GROUP) fail('The company holds every bot and cannot be deleted. Delete bots one at a time.', 409);
  for (const b of g.bots) releaseReports(state, b.id);
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
  for (const b of g.bots) logActivity(state, {botId: b.id, kind: 'bots', text: `${b.name} was deleted.`});
  activity(state, 'group', `Removed group ${g.name}.`);
  return {ok: true};
}
