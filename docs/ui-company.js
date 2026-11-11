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
import {face} from './ui-face.js?v=b4d3410ab6';
import {waitingOnYou, totalWaitingOnYou} from './ui-model.js?v=b4d3410ab6';

const teamKey = id => `team-${id}`;
const settingsOf = bot => bot?.settings || {};
const botsOf = state => (state?.groups || []).find(g => g.id === 'home')?.bots || [];
const threadsOf = state => (state?.groups || []).filter(g => g?.settings?.kind === 'thread');
const primaryOf = bots => bots.find(b => settingsOf(b).lead === true);
const managerOf = (bot, bots) => settingsOf(bot).lead !== true && bots.some(b => b !== bot && settingsOf(b).reportsTo === bot.id);
const isAwaiting = status => String(status || '').startsWith('awaiting');
const isActive = status => status === 'queued' || status === 'running';
const oneLine = (text, max) => String(text ?? '').replace(/\s+/g, ' ').slice(0, max);
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
  const last = newest((history || []).filter(m => m.role !== 'system')) || newest(history || []);
  if (!last) return {preview: '', at: ''};
  const text = oneLine(last.text, 120);
  return {preview: last.role === 'user' ? `You: ${text}` : text, at: last.at || ''};
}

/** The sidebar. Pinned bots first, then the company tree (Atlas, then each
 * manager followed by its reports, Solo bots under Atlas). The order is the
 * saved one, so activity never reorders it. A pinned Atlas is not repeated, so
 * the list then starts with Atlas's reports. Atlas cannot be hidden. `pins`
 * defaults to the bots whose settings.pinned is set. */
export function botRows(state, {query = '', order = [], pins, hidden = []} = {}) {
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
        status, ...lastLine(state?.chats?.[bot.id]),
        needs: totalWaitingOnYou(waitingOnYou(state, bot.id)),
        pinned: pinned.includes(bot.id), isPrimary, isManager, team: isPrimary ? null : parentOf(bot) ?? null,
      };
    })
    .filter(row => !q || `${row.name} ${row.job}`.toLowerCase().includes(q));
}

/** The Threads section: waiting on the person, then today, then earlier, each newest first. */
export function threadRows(state, {now = Date.now()} = {}) {
  const bots = botsOf(state), primary = primaryOf(bots), runs = state?.groupRuns || [];
  const rows = threadsOf(state).map(group => {
    const key = teamKey(group.id), line = lastLine(state?.chats?.[key]);
    const needs = totalWaitingOnYou(waitingOnYou(state, key));
    const waiting = needs > 0 || runs.some(r => r.groupId === group.id && isAwaiting(r.status));
    return {
      id: group.id, chatKey: key, title: group.name, ownerId: group.settings.ownerId || primary?.id || null,
      face: primary ? face(primary, {size: 36, state: waiting ? 'waiting' : 'awake', primary: true}) : '',
      preview: line.preview, at: line.at || group.createdAt || '', needs, waiting,
    };
  }).sort((a, b) => time(b.at) - time(a.at));
  return {
    waiting: rows.filter(r => r.waiting),
    today: rows.filter(r => !r.waiting && r.at && sameDay(r.at, now)),
    earlier: rows.filter(r => !r.waiting && !(r.at && sameDay(r.at, now))),
  };
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
  return out;
}

const list = names => names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/** The one live line a chat keeps updating: who is doing what right now, and
 * once the work ends, who helped. `botId` is whose face the pill shows. */
export function progressPill(run, state) {
  if (!run) return null;
  const bots = botsOf(state), primary = primaryOf(bots);
  const name = id => bots.find(b => b.id === id)?.name || 'A bot';
  if (run.status === 'completed') {
    const helpers = [...new Set((run.trace || []).map(s => s.botId))].filter(id => id && id !== primary?.id);
    if (!helpers.length) return null;
    const n = handoffs(run).length;
    return {done: true, text: `${list(helpers.map(name))} helped · ${n} message${n === 1 ? '' : 's'}`};
  }
  if (!isActive(run.status) && !isAwaiting(run.status)) return null;
  const t = turn(run, primary);
  if (isAwaiting(run.status)) return {botId: t.botId, text: `${name(t.botId)} needs your OK`};
  if (t.from) return {botId: t.from, text: `Asking ${name(t.botId)}: ${oneLine(t.task, 60)}`};
  if (t.planning) return {botId: t.botId, text: `${name(t.botId)} is working out who does what`};
  if (t.botId === primary?.id && run.trace?.length) return {botId: t.botId, text: `${name(t.botId)} is putting it together`};
  return {botId: t.botId, text: `${name(t.botId)} is on it`};
}

/** The line under a bot chat's title. */
export function chatStatus(state, botId) {
  const bots = botsOf(state), bot = bots.find(b => b.id === botId);
  if (bot && settingsOf(bot).lead === true) return 'Hands work to any bot';
  if (bot && managerOf(bot, bots)) return 'Hands work to its team';
  return 'One continuous chat';
}

const SUBS = ['memory', 'activity', 'permissions', 'model', 'computer', 'team', 'edit'];
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
