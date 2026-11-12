/** View models for the company UI: the bot list, the thread list, the live
 * progress pill, the handoff card, a bot chat's status line and the new hash
 * routes. Pure functions from the stored snapshot, with no DOM and no globals,
 * so Node tests import them directly (tests/ui-company.test.js).
 *
 * Shapes this reads (see docs/superpowers/plans/2026-11-11-phase-2-...):
 * the company is the group with id 'home' and holds every bot; a thread is a
 * group whose settings.kind is 'thread'; chat history is state.chats[key]
 * (key = bot id, or `team-<groupId>` for a thread); runs are state.groupRuns.
 * A run's trace holds one entry per step: {botId, output}. A bot-to-bot ask is
 * two entries, {botId: asker, kind: 'ask', to, task} and then
 * {botId: asked, kind: 'peer', to: asker, output}. */
import {face} from './ui-face.js?v=64ac2a0a37';
import {plain} from './ui-kit.js?v=64ac2a0a37';
import {waitingOnYou, totalWaitingOnYou} from './ui-model.js?v=64ac2a0a37';

const teamKey = id => `team-${id}`;
const settingsOf = bot => bot?.settings || {};
const botsOf = state => (state?.groups || []).find(g => g.id === 'home')?.bots || [];
const threadsOf = state => (state?.groups || []).filter(g => g?.settings?.kind === 'thread');
const primaryOf = bots => bots.find(b => settingsOf(b).lead === true);
const managerOf = (bot, bots) => settingsOf(bot).lead !== true && bots.some(b => b !== bot && settingsOf(b).reportsTo === bot.id);
const isAwaiting = status => String(status || '').startsWith('awaiting');
const isActive = status => status === 'queued' || status === 'running';
const oneLine = (text, max) => plain(text).slice(0, max);
const time = value => { const t = Date.parse(value || ''); return Number.isFinite(t) ? t : 0; };
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

/** The bot whose turn it is in a run. An ask in flight is the asked bot's turn.
 * A thread run that has said nothing yet is the primary working out who does what. */
function turn(run, primary) {
  const trace = run.trace || [], last = trace[trace.length - 1];
  if (last?.kind === 'ask') return {botId: last.to, from: last.botId, task: last.task};
  const inThread = !run.chatKey || String(run.chatKey).startsWith('team-');
  if (!trace.length && inThread && primary) return {botId: primary.id, planning: true};
  return {botId: (run.recipients || [])[run.currentStep || 0] ?? last?.botId ?? null};
}

function statusOf(bot, runs, primary) {
  let working = false;
  for (const run of runs) {
    if (!isActive(run.status) && !isAwaiting(run.status)) continue;
    if (turn(run, primary).botId !== bot.id) continue;
    if (isAwaiting(run.status)) return 'waiting';
    working = true;
  }
  return working ? 'working' : bot === primary ? 'awake' : 'asleep';
}

/** One bot's state ('asleep', 'working', 'waiting'; an idle primary is 'awake'),
 * for the faces outside the list: a chat header, a bubble. */
export function botStatus(state, botId) {
  const bots = botsOf(state), bot = bots.find(b => b.id === botId);
  return bot ? statusOf(bot, state?.groupRuns || [], primaryOf(bots)) : 'asleep';
}
/** True for a bot that has reports and is not the primary: it is drawn as a hexagon. */
export const botIsManager = (state, botId) => { const bots = botsOf(state), bot = bots.find(b => b.id === botId); return Boolean(bot) && managerOf(bot, bots); };

// First sentence of a bot's instructions: what the list shows under its name.
export const jobOf = bot => String(bot?.instructions || '').split(/[.:]/)[0].trim() || 'New, no job yet';

// A row previews what was said, not the system lines around it ("Done in 4 steps").
function lastLine(history) {
  // The newest by time, not by position: a run's lines can be stored before the owner's own line lands.
  const newest = list => list.reduce((a, m) => (a && time(a.at) > time(m.at) ? a : m), null);
  const said = (history || []).filter(m => !m.step);
  const last = newest(said.filter(m => m.role !== 'system')) || newest(said);
  if (!last) return {preview: '', at: '', answeredAt: ''};
  const text = oneLine(last.text, 120);
  // Unread: the newest thing said is a bot's, and newer than when the person last opened the chat.
  const answer = newest(said.filter(m => m.role === 'bot'));
  return {preview: last.role === 'user' ? `You: ${text}` : text, at: last.at || '', answeredAt: last.role === 'bot' && answer ? answer.at || '' : ''};
}

/** When the newest run in a chat failed and no bot has spoken since, the row
 * says so with the reason, instead of still showing the person's own last line.
 * A run the person stopped is not flagged: they know. */
const STOPPED = new Set(['failed', 'interrupted']);
const ended = r => time(r.completedAt || r.updatedAt || r.createdAt);
function stoppedLine(runs, mine, line) {
  const last = runs.filter(mine).reduce((a, r) => (a && ended(a) >= ended(r) ? a : r), null);
  if (!last || !STOPPED.has(last.status)) return line;
  if (line.answeredAt && time(line.answeredAt) > ended(last)) return line;
  return {...line, stopped: true, preview: oneLine(last.error || 'This stopped before it finished.', 120)};
}

const unreadOf = (line, seenAt) => Boolean(line.answeredAt) && !(seenAt && time(seenAt) >= time(line.answeredAt));

/** The sidebar. Pinned bots first, then the company tree (Atlas, then each
 * manager followed by its reports, Solo bots under Atlas). The order is the
 * saved one, so activity never reorders it. A pinned Atlas is not repeated, so
 * the list then starts with Atlas's reports. Atlas cannot be hidden. `pins`
 * defaults to the bots whose settings.pinned is set. */
export function botRows(state, {query = '', order = [], pins, hidden = [], seen = {}} = {}) {
  const bots = botsOf(state), primary = primaryOf(bots), ids = new Set(bots.map(b => b.id));
  const pinned = (Array.isArray(pins) ? pins : bots.filter(b => settingsOf(b).pinned).map(b => b.id)).filter(id => ids.has(id));
  const rank = bot => { const i = order.indexOf(bot.id); return i < 0 ? order.length : i; };
  const parentOf = bot => { const p = settingsOf(bot).reportsTo; return ids.has(p) && p !== bot.id ? p : primary?.id; };
  const kids = id => bots.filter(b => b !== primary && parentOf(b) === id).sort((a, b) => rank(a) - rank(b));
  const walked = new Set(), tree = [];
  const walk = bot => { if (walked.has(bot.id)) return; walked.add(bot.id); tree.push(bot); kids(bot.id).forEach(walk); };
  if (primary) walk(primary);
  bots.forEach(walk); // a reportsTo cycle is unreachable from Atlas; list it last rather than lose it
  const sequence = [...pinned.map(id => bots.find(b => b.id === id)), ...tree.filter(b => !pinned.includes(b.id))];
  const runs = state?.groupRuns || [], q = String(query).trim().toLowerCase();
  return sequence
    .filter(bot => bot === primary || !hidden.includes(bot.id))
    .map(bot => {
      const isPrimary = bot === primary, isManager = managerOf(bot, bots), status = statusOf(bot, runs, primary);
      return {
        id: bot.id, name: bot.name, job: jobOf(bot),
        face: face(bot, {size: 40, state: status, primary: isPrimary, manager: isManager, index: bots.indexOf(bot)}),
        status, ...(line => ({...line, unread: unreadOf(line, seen?.[bot.id])}))(stoppedLine(runs, r => r.chatKey === bot.id, {stopped: false, ...lastLine(state?.chats?.[bot.id])})),
        needs: totalWaitingOnYou(waitingOnYou(state, bot.id)),
        pinned: pinned.includes(bot.id), isPrimary, isManager, team: isPrimary ? null : parentOf(bot) ?? null,
      };
    })
    .filter(row => !q || `${row.name} ${row.job}`.toLowerCase().includes(q));
}

/** The Threads section: waiting on the person, then today, then earlier, each newest first. */
export function threadRows(state, {now = Date.now(), seen = {}} = {}) {
  const bots = botsOf(state), primary = primaryOf(bots), runs = state?.groupRuns || [];
  const rows = threadsOf(state).map(group => {
    const key = teamKey(group.id), line = stoppedLine(runs, r => r.groupId === group.id, {stopped: false, ...lastLine(state?.chats?.[key])});
    const needs = totalWaitingOnYou(waitingOnYou(state, key));
    const waiting = needs > 0 || runs.some(r => r.groupId === group.id && isAwaiting(r.status));
    // A thread at work says what it is doing, under the face of the bot doing it (Atlas, or the bot it asked).
    const live = !waiting && runs.find(r => r.groupId === group.id && isActive(r.status));
    const pill = live ? progressPill(live, state, {now}) : null;
    const who = (pill && bots.find(b => b.id === pill.botId)) || primary;
    return {
      id: group.id, chatKey: key, title: group.name, ownerId: group.settings.ownerId || primary?.id || null,
      faceBot: who?.id || null,
      face: who ? face(who, {size: 36, state: waiting ? 'waiting' : pill ? 'working' : 'awake', primary: who === primary, index: bots.indexOf(who)}) : '',
      preview: line.preview, at: line.at || group.createdAt || '', needs, waiting,
      working: Boolean(pill), activity: pill?.text || '', unread: !pill && unreadOf(line, seen?.[key]), stopped: !pill && !waiting && line.stopped,
    };
  }).sort((a, b) => time(b.at) - time(a.at));
  return {
    waiting: rows.filter(r => r.waiting),
    today: rows.filter(r => !r.waiting && r.at && sameDay(r.at, now)),
    earlier: rows.filter(r => !r.waiting && !(r.at && sameDay(r.at, now))),
  };
}

/** Who has worked in a thread, for its header: Atlas first, then each bot in the
 * order it first spoke there ("Atlas, Planner and Mailroom"). */
export function threadCrew(state, groupId) {
  const bots = botsOf(state), primary = primaryOf(bots);
  const ids = [primary?.id, ...(state?.chats?.[teamKey(groupId)] || []).filter(m => m.role === 'bot').map(m => m.senderId)];
  const names = [...new Set(ids.filter(Boolean))].map(id => bots.find(b => b.id === id)?.name).filter(Boolean);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] || 'Atlas';
}

/** The tap-open card: each message passed between bots, in order. A change of
 * bot between two steps hands over the earlier bot's words. */
export function handoffs(run) {
  const out = [];
  let prev = null;
  for (const step of run?.trace || []) {
    if (step.kind === 'ask') out.push({from: step.botId, to: step.to, text: step.task || ''});
    else if (step.kind === 'peer') out.push({from: step.botId, to: step.to, text: step.output || ''});
    else {
      if (prev && prev.botId !== step.botId) out.push({from: prev.botId, to: step.botId, text: prev.output || ''});
      prev = step;
    }
  }
  // A last step addressed to a bot that has not answered yet is a message on its way.
  const to = prev?.toBotId;
  if (to && to !== 'None' && to !== prev.botId && trace(run).at(-1) === prev) out.push({from: prev.botId, to, text: prev.output || ''});
  return out;
}
const trace = run => run?.trace || [];

const nameIn = bots => id => bots.find(b => b.id === id)?.name || 'A bot';

/** The quiet line a run's bot-to-bot traffic folds into once it stops: its latest hop,
 * "Scout messaged Ranker". Null when no bot passed anything to another. */
export function hopLine(run, state) {
  const last = handoffs(run).at(-1);
  if (!last) return null;
  const name = nameIn(botsOf(state));
  return {done: true, text: `${name(last.from)} messaged ${name(last.to)}`};
}

/** The one live line a chat keeps updating: the working bot's face and a plain phrase for what it is doing, never
 * the mechanics. Reading a page, clicking through one, checking with a teammate, needing you; otherwise a calm phrase
 * that moves on every ~12 seconds. Once the work ends, the latest hop. `botId` is whose face the pill shows. */
const CALM = ['Working on it', 'Making progress', 'Putting it together', 'Chipping away'];
export function progressPill(run, state, {now = Date.now()} = {}) {
  if (!run) return null;
  const bots = botsOf(state), primary = primaryOf(bots), name = nameIn(bots);
  if (run.status === 'completed') return hopLine(run, state);
  if (!isActive(run.status) && !isAwaiting(run.status)) return null;
  const t = turn(run, primary), prev = (run.trace || []).filter(s => s.kind !== 'ask').at(-1)?.botId;
  if (run.status === 'awaiting_browser') {
    const open = (state?.browserRequests || []).filter(r => r.runId === run.id && ['pending', 'dispatched'].includes(r.status));
    return {botId: t.botId, text: open.some(r => r.steps?.length) ? 'Clicking through pages' : 'Doing some reading'};
  }
  if (isAwaiting(run.status)) return {botId: t.botId, text: 'Needs your input'};
  if (t.from || (prev && t.botId && prev !== t.botId)) return {botId: t.botId, text: `Checking with ${name(t.botId)}`};
  if (t.planning) return {botId: t.botId, text: 'Thinking it through'};
  const since = Date.parse(run.startedAt || run.createdAt || '');
  const step = Number.isFinite(since) ? Math.max(0, Math.floor((now - since) / 12000)) : 0;
  return {botId: t.botId, text: CALM[step % CALM.length]};
}

/** The line under a bot chat's title. */
export function chatStatus(state, botId) {
  const bots = botsOf(state), bot = bots.find(b => b.id === botId);
  if (bot && settingsOf(bot).lead === true) return 'Hands work to any bot';
  if (bot && managerOf(bot, bots)) return 'Hands work to its team';
  return 'One continuous chat';
}

const SUBS = ['memory', 'activity', 'schedule', 'permissions', 'model', 'computer', 'team', 'edit'];
const OLD_INFO = {edit: 'edit', memory: 'memory', tasks: 'activity'};
const OLD_PAGES = ['ai', 'team', 'agents', 'data', 'notifications', 'workspaces', 'about'];
const decode = part => { try { return decodeURIComponent(part); } catch { return part; } };

/** Hash to route. Unknown targets fall back to home, and the pre-company hashes
 * (#chat/<id>, #chat/<id>/info/<tab>, #group/<id>, #you/<page>) land on the
 * nearest new route: a team chat of a thread is that thread, any other team
 * chat is Atlas's chat, a bot's info is its profile, a page is a Settings section. */
export function companyRoute(hash, state) {
  const home = {home: true};
  const [head, a, b, c] = String(hash || '').replace(/^#/, '').split('/').map(decode);
  const bots = botsOf(state), threads = threadsOf(state);
  const isBot = id => bots.some(x => x.id === id), isThread = id => threads.some(g => g.id === id);
  const primary = primaryOf(bots);
  const teamChat = key => {
    const id = String(key).slice(5);
    if (isThread(id)) return {thread: id};
    return primary && (state?.groups || []).some(g => g.id === id) ? {bot: primary.id} : home;
  };
  switch (head) {
    case 'bot': return isBot(a) ? {bot: a} : home;
    case 'thread': return isThread(a) ? {thread: a} : home;
    case 'profile': return isBot(a) ? {profile: a, ...(SUBS.includes(b) ? {sub: b} : {})} : home;
    case 'settings': case 'you': return {settings: a || ''};
    case 'new-bot': return {newBot: true, ...(a ? {job: a} : {})};
    case 'new-thread': return {newThread: true};
    case 'company': return {company: true};
    case 'activity': return {activity: true};
    case 'group': return teamChat(teamKey(a));
    case 'chat':
      if (!a) return home;
      if (a.startsWith('team-')) return teamChat(a);
      if (!isBot(a)) return home;
      return b === 'info' ? {profile: a, ...(OLD_INFO[c] ? {sub: OLD_INFO[c]} : {})} : {bot: a};
    default: return OLD_PAGES.includes(head) ? {settings: head} : home;
  }
}

export function companyHash(route) {
  const e = encodeURIComponent;
  if (route?.bot) return `bot/${e(route.bot)}`;
  if (route?.thread) return `thread/${e(route.thread)}`;
  if (route?.profile) return `profile/${e(route.profile)}${route.sub ? `/${e(route.sub)}` : ''}`;
  if (typeof route?.settings === 'string') return route.settings ? `settings/${e(route.settings)}` : 'settings';
  if (route?.newBot) return route.job ? `new-bot/${e(route.job)}` : 'new-bot';
  if (route?.newThread) return 'new-thread';
  if (route?.company) return 'company';
  if (route?.activity) return 'activity';
  return 'chats';
}
