/** View models for the bot profile, the New bot page, Settings, the Company chart
 * and Activity. Pure functions from the stored snapshot: no DOM, no globals, so
 * Node tests import them directly (tests/ui-profile-model.test.js). The markup
 * lives in ui-profile.js and ui-settings.js.
 *
 * A bot's manager is settings.reportsTo (company.js); "manager" is simply a bot
 * with reports, so any bot can become one by receiving a report. */
import {companyBots, primaryOf, managerOf, reportsOf, teamOf} from './company.js?v=5451813041';
import {firstUnusedTint} from './bot-create.js?v=5451813041';
import {TINT_COUNT, dayLabel} from './ui-kit.js?v=5451813041';
import {jobOf} from './ui-company.js?v=5451813041';
import {ACTIVITY_CHIPS} from './activity-log.js?v=5451813041';
import {grantRows} from './ui-asks.js?v=5451813041';
import {cleanEffort, effortLabel, EFFORT_LEVELS} from './ai-presets.js?v=5451813041';
import {scheduleRows} from './schedules.js?v=5451813041';

/** What a bot made without a job holds until the owner's first chat message
 * replaces it (the profile, the list and the chat all treat it as "no job yet"). */
export const NO_JOB = 'Waiting for its job from the owner.';
export const MAX_NAME = 40;
export const MAX_JOB = 3000;
const DEFAULT_SHAPE = 'rounded';

export const hasJob = bot => { const text = String(bot?.instructions ?? '').trim(); return Boolean(text) && text !== NO_JOB; };
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const botOf = (state, id) => companyBots(state).find(b => b.id === id) || null;

/** The manager shown for a bot: null when it is Solo or reports to the primary. */
function bossOf(state, botId) {
  const boss = managerOf(state, botId), primary = primaryOf(state);
  return boss && boss.id !== primary?.id ? boss : null;
}
/** Everyone one step below a bot. The primary's are the managers and the Solo bots. */
export function directReports(state, botId) {
  const primary = primaryOf(state);
  if (primary?.id !== botId) return reportsOf(state, botId);
  return companyBots(state).filter(b => b.id !== botId && !bossOf(state, b.id));
}

export function roleOf(state, botId) {
  if (primaryOf(state)?.id === botId) return 'Primary';
  return reportsOf(state, botId).length ? 'Manager' : 'Bot';
}
export function teamLine(state, botId) {
  const role = roleOf(state, botId);
  if (role === 'Primary') return role;
  const boss = bossOf(state, botId);
  return `${role} · ${boss ? `${boss.name}'s team` : `reports to ${primaryOf(state)?.name || 'Atlas'}`}`;
}

/* ---------- who a bot may report to ---------- */

const kindOf = (state, bot) => (reportsOf(state, bot.id).length ? 'manager' : 'bot');
/** Every bot that may become `botId`'s manager: not itself, not anyone below it (that
 * would close a loop), not the primary (Solo is that). Managers first. */
export function managerOptions(state, botId = null) {
  const primary = primaryOf(state), below = new Set(botId ? teamOf(state, botId).map(b => b.id) : []);
  return companyBots(state)
    .filter(b => b.id !== botId && b.id !== primary?.id && !below.has(b.id))
    .map((b, i) => ({id: b.id, label: b.name, kind: kindOf(state, b), i}))
    .sort((a, b) => (a.kind === b.kind ? a.i - b.i : a.kind === 'manager' ? -1 : 1))
    .map(({id, label, kind}) => ({id, label, kind}));
}
/** The Move to… choices: the manager options without the current one, then Solo
 * when the bot has a manager other than the primary. Nothing for the primary. */
export function moveTargets(state, botId) {
  if (primaryOf(state)?.id === botId) return [];
  const boss = bossOf(state, botId);
  const list = managerOptions(state, botId).filter(t => t.id !== boss?.id);
  return boss ? [...list, {id: null, label: `Solo (reports to ${primaryOf(state)?.name || 'Atlas'})`, kind: 'solo'}] : list;
}

/** The ⋯ menu. Atlas is never hidden, moved or deleted. */
export function menuItems(state, botId, {pinned = false} = {}) {
  const bot = botOf(state, botId);
  if (!bot) return [];
  const items = [{id: 'message', label: `Message ${bot.name}`}, {id: 'pin', label: pinned ? 'Unpin' : 'Pin'}];
  if (primaryOf(state)?.id === botId) return items;
  const targets = moveTargets(state, botId);
  if (targets.length) items.push({id: 'move', label: 'Move to…', targets});
  items.push({id: 'hide', label: 'Hide'}, {id: 'delete', label: 'Delete…', danger: true});
  return items;
}
/** The confirm dialog for deleting a bot: what goes, that it is final, where its reports go. */
export function deleteCopy(state, botId) {
  const bot = botOf(state, botId), reports = reportsOf(state, botId).length;
  const goes = reports ? ` Its ${reports} ${reports === 1 ? 'report moves' : 'reports move'} to Solo.` : '';
  return {title: `Delete ${bot?.name || 'this bot'}?`, detail: `Its job, memory and permissions are deleted. This can't be undone.${goes} Its threads stay.`};
}

/* ---------- the profile ---------- */

const bookOf = (state, botId) => state?.memory?.rulebooks?.[`bot:${botId}`] || null;
/** A bot's own memory notes (rules), from the snapshot. */
export const memoryNotes = (state, botId) => (bookOf(state, botId)?.rules || []).map(r => ({id: r.id, text: r.text, source: r.source || 'user', createdAt: r.createdAt || ''}));

/** One line for the Model row: the bot's own override, else the workspace default. */
export function modelLine(state, botId) {
  const ai = state?.ai || {}, own = ai.bots?.[botId] || {};
  const provider = (ai.providers || []).find(p => p.id === (own.providerId || ai.defaultProviderId));
  const cliDefault = provider?.kind === 'local-cli' ? provider.model || 'default model' : 'auto';
  const model = own.model || (own.providerId && own.providerId !== ai.defaultProviderId ? '' : ai.defaultModel) || (provider ? cliDefault : state?.aiModel || '');
  const level = cleanEffort(own.effort) || cleanEffort(ai.defaultEffort);
  const effort = level ? ` · ${effortLabel(level)}` : '';
  if (provider) return `${provider.label || 'Saved provider'} · ${model}${effort}`;
  return model || 'Built-in demo';
}

/** The chip in a bot chat's header: the model in a word or two (the model id, or the provider when it runs on
 * its default) and the effort when one is set. It opens the bot's Model page. Null with no saved provider. */
export function modelChip(state, botId) {
  const ai = state?.ai || {}, own = ai.bots?.[botId] || {};
  const provider = (ai.providers || []).find(p => p.id === (own.providerId || ai.defaultProviderId));
  if (!provider) return null;
  const line = modelLine(state, botId), parts = line.split(' · ');
  const model = parts[1] && !['default model', 'auto'].includes(parts[1]) ? parts[1] : provider.label || 'Model';
  const level = EFFORT_LEVELS.find(l => l.id === (cleanEffort(own.effort) || cleanEffort(ai.defaultEffort)));
  return {text: level ? `${model} · ${level.label}` : model, title: `Model: ${line}. Change it`};
}

/** `activityCount` is the log's own total for this bot (GET /api/activity), which is not in the snapshot. */
export function profileRows(state, botId, {activityCount = 0, canPickModel = true} = {}) {
  const bot = botOf(state, botId);
  if (!bot) return [];
  const notes = memoryNotes(state, botId).length, acts = Number(activityCount) || 0;
  const rules = grantRows(state, botId).length, team = directReports(state, botId).length, timers = scheduleRows(state, botId);
  const rows = [
    {key: 'memory', label: 'Memory', value: notes ? plural(notes, 'note') : 'Empty'},
    {key: 'activity', label: 'Activity', value: acts ? String(acts) : ''},
    // One schedule reads its when ("every day at 08:00"); more read as a count.
    {key: 'schedule', label: 'Schedule', value: timers.length === 1 ? timers[0].when : timers.length ? plural(timers.length, 'task') : 'None'},
    {key: 'permissions', label: 'Permissions', value: rules ? plural(rules, 'rule') : 'None'},
    // With nothing to pick (the demo has no model) the row is only a value, not a door to an empty page.
    {key: 'model', label: 'Model', value: modelLine(state, botId), ...(canPickModel ? {} : {plain: true})},
  ];
  rows.push({key: 'computer', label: 'Computer', value: 'Idle'});
  if (team) rows.push({key: 'team', label: 'Team', value: plural(team, 'bot')});
  return rows;
}

/** Back from a profile: the thread it was opened from, else the bot's own chat. */
export const profileBackRoute = (botId, fromThread = null) => (fromThread ? {thread: fromThread} : {bot: botId});

/** Where Esc or a close button leaves a page. Pages opened from Settings or the
 * list pop the history entry that opened them; a profile never goes to the Company
 * page: a sub-page goes to its profile, a profile to its thread or bot chat. */
export function closeTarget(route, fromThread = null) {
  if (route?.profile) return route.sub ? {route: {profile: route.profile}, pop: false} : {route: profileBackRoute(route.profile, fromThread), pop: false};
  return {route: {home: true}, pop: Boolean(route?.newBot || route?.company || route?.activity || typeof route?.settings === 'string')};
}

/** What a bot looks like now: its shape, colour index and manager, with the role
 * and position defaults filled in, for the Edit page's starting values. */
export function lookOf(state, botId) {
  const bots = companyBots(state), bot = botOf(state, botId), s = bot?.settings || {};
  const role = roleOf(state, botId);
  return {
    name: bot?.name || '',
    reportsTo: bossOf(state, botId)?.id || null,
    shape: s.shape || (role === 'Primary' ? 'circle' : role === 'Manager' ? 'hexagon' : DEFAULT_SHAPE),
    tint: Number.isInteger(s.tint) ? s.tint : Math.max(0, bots.indexOf(bot)) % TINT_COUNT,
  };
}

/* ---------- new bot and edit ---------- */

export const newBotDefaults = state => ({tint: firstUnusedTint(companyBots(state), TINT_COUNT), shape: DEFAULT_SHAPE});
export const canCreate = ({name} = {}) => String(name ?? '').trim().length > 0;
/** The POST body. A job is optional (it comes from the first chat message); shape
 * is only stored when it is not the plain default, so the bot keeps its role shape. */
export function newBotPayload({name, job = '', tint = 0, shape = DEFAULT_SHAPE, reportsTo = ''} = {}) {
  const settings = {tint: Number(tint) || 0};
  if (shape && shape !== DEFAULT_SHAPE) settings.shape = shape;
  if (reportsTo) settings.reportsTo = reportsTo;
  return {name: String(name ?? '').trim().slice(0, MAX_NAME), instructions: String(job ?? '').trim().slice(0, MAX_JOB) || NO_JOB, settings};
}
/** The PATCH body for an Edit save, with only what changed (null when nothing did). */
export function editChanges(was, now) {
  const out = {}, settings = {};
  const name = String(now.name ?? '').trim().slice(0, MAX_NAME);
  if (name && name !== was.name) out.name = name;
  const boss = now.reportsTo || null;
  if (boss !== (was.reportsTo || null)) settings.reportsTo = boss;
  if (now.shape && now.shape !== was.shape) settings.shape = now.shape;
  if (Number.isInteger(Number(now.tint)) && now.tint !== '' && Number(now.tint) !== was.tint) settings.tint = Number(now.tint);
  if (Object.keys(settings).length) out.settings = settings;
  return Object.keys(out).length ? out : null;
}

/* ---------- activity ---------- */

/** The four filter chips, default first, as [filter, label] (shared/activity-log.js is the one list). */
export const ACTIVITY_FILTERS = ACTIVITY_CHIPS.map(c => [c.filter, c.label]);
/** The request for a page of the log: a chip, an optional bot (one profile's own section), a page size and the cursor. */
export function activityUrl({filter = 'outside', botId = null, limit = 50, before = null} = {}) {
  const q = [`filter=${encodeURIComponent(filter)}`, `limit=${Math.floor(Number(limit)) || 50}`];
  if (botId) q.push(`bot=${encodeURIComponent(botId)}`);
  if (before) q.push(`before=${encodeURIComponent(before)}`);
  return `/api/activity?${q.join('&')}`;
}
/** Where tapping an entry goes: its thread (the log stores the chat key, a bot id or team-<thread>), else nowhere. */
export function activityTarget(entry) {
  const key = String(entry?.threadId || '');
  if (!key) return null;
  return key.startsWith('team-') ? {thread: key.slice(5)} : {bot: key};
}
/** Entries (newest first) grouped under Today, Yesterday, then dates. */
export function activityDays(rows, now = Date.now()) {
  const days = [];
  for (const row of rows) {
    const label = dayLabel(row.at, new Date(now)), last = days[days.length - 1];
    if (last?.label === label) last.rows.push(row); else days.push({label, rows: [row]});
  }
  return days;
}

/* ---------- the company chart ---------- */

/** Atlas at the top, managers under it, then their teams; Solo bots hang from Atlas.
 * A loop (which the server refuses to store) cannot recurse forever. */
export function companyTree(state) {
  const seen = new Set();
  const node = bot => {
    seen.add(bot.id);
    return {id: bot.id, name: bot.name, role: roleOf(state, bot.id), job: jobOf(bot),
      children: directReports(state, bot.id).filter(b => !seen.has(b.id)).map(node)};
  };
  const primary = primaryOf(state) || companyBots(state)[0];
  return primary ? node(primary) : null;
}

/* ---------- settings ---------- */

const WEEK = 7 * 86400000;
/** Who did the work this week: each bot's turns in the runs of the last seven days.
 * Real counts from the run log, not a share of a subscription limit (that needs a
 * connected subscription). */
export function weekUsage(state, now = Date.now()) {
  const counts = new Map(), names = new Map(companyBots(state).map(b => [b.id, b.name]));
  for (const run of state?.groupRuns || []) {
    if (!(Date.parse(run.createdAt || '') >= now - WEEK)) continue;
    for (const step of run.trace || []) if (step.kind !== 'ask' && names.has(step.botId)) counts.set(step.botId, (counts.get(step.botId) || 0) + 1);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const rows = [...counts].map(([botId, count]) => ({botId, name: names.get(botId), count, pct: Math.round(count / total * 100)})).sort((a, b) => b.count - a.count);
  return {total, rows};
}

const SECTIONS = [['general', 'General'], ['look', 'Appearance'], ['models', 'Models and keys'], ['conn', 'Connectors'], ['perm', 'Permissions'], ['usage', 'Usage']];
/** The six sections, then the pages a live server adds (reached from General):
 * notifications and workspaces for anyone, team, agents and data for an admin, About always. */
export function settingsSections({admin = false, demo = true} = {}) {
  const extra = [];
  if (!demo) extra.push(['notifications', 'Notifications'], ['workspaces', 'Workspaces']);
  if (admin && !demo) extra.push(['team', 'Team and access'], ['agents', 'Local agents'], ['data', 'Data and security']);
  extra.push(['about', 'About this build']);
  return [...SECTIONS.map(([key, label]) => ({key, label})), ...extra.map(([key, label]) => ({key, label, extra: true}))];
}
const ALIASES = {ai: 'models', you: 'general', '': 'general'};
/** A section name may carry one argument after its first slash: `perm/<bot id>` is
 * Permissions for that bot. */
const splitSection = name => { const text = String(name ?? ''), at = text.indexOf('/'); return at < 0 ? [text, ''] : [text.slice(0, at), text.slice(at + 1)]; };
/** The section a route names, or General when it is unknown or not allowed here. */
export function resolveSection(name, sections) {
  const head = splitSection(name)[0], key = ALIASES[head] ?? head;
  return sections.some(s => s.key === key) ? key : 'general';
}
/** The argument after the slash in a section name ('' when there is none). */
export const sectionArg = name => splitSection(name)[1];
