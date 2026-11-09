/** View models for the chat UI. Pure functions from the stored snapshot to what
 * a pane shows: the chat list, a thread's timeline, the "needs you" count and
 * the hash route. No DOM and no globals, so the product rules here are unit
 * tested directly (tests/ui-model.test.js). */
import {fullDate} from './ui-kit.js';
import {botSettings} from './bot-settings.js';

export const ACTIVE_DRAFTS = ['pending', 'scheduled', 'ready'];
const X_GROUP = 'x-engage';
const teamKey = groupId => `team-${groupId}`;
const time = value => { const t = Date.parse(value || ''); return Number.isFinite(t) ? t : 0; };

/** X's standard post limit, in characters. This is a warning, never a rule: a
 * premium account posts far longer, the number is per-account, and the final
 * click is the human's either way. */
export const POST_LIMIT = 280;
/** How long a draft is, counted the way a reader counts it (one emoji is one
 * character, not two halves). A link is not shortened here, so a post with a URL
 * may fit X even when this says it is over. */
export function draftLength(text) {
  const count = [...String(text ?? '')].length;
  return {count, limit: POST_LIMIT, over: count > POST_LIMIT, left: Math.max(0, POST_LIMIT - count)};
}
/** The one line the editor shows beside the text, and the same line a card
 * carries when it is not being edited. */
export function lengthLabel(text) {
  const {count, over} = draftLength(text);
  return over ? `${count} characters · ${count - POST_LIMIT} over X's ${POST_LIMIT}` : `${count} of ${POST_LIMIT} · ${POST_LIMIT - count} left`;
}

/** Where a draft is in the human-approval lifecycle, and the one line that says so. */
export function draftStage(draft) {
  switch (draft.status) {
    case 'pending': return {tone: 'wait', line: 'Waiting on you. Nothing posts by itself.'};
    case 'scheduled': return {tone: 'ok', line: `Approved. Ready ${draft.dueAt ? fullDate(draft.dueAt) : 'soon'}.`};
    case 'ready': return {tone: 'ok', line: 'Ready. Post it on X yourself.'};
    case 'posted': return {tone: 'done', line: 'Posted by you.'};
    case 'rejected': return {tone: 'off', line: 'Skipped.'};
    default: return {tone: 'off', line: String(draft.status || 'Draft')};
  }
}

/** A run with no chatKey is the group chat. Otherwise it is the conversation it started in. */
export function runBelongsToChat(run, chatKey) {
  return run?.chatKey ? run.chatKey === chatKey : chatKey === teamKey(run?.groupId);
}

/** How many things in a group are blocked on the human: drafts to decide,
 * drafts ready to post, and runs paused at a checkpoint. Plans, page
 * requests and 1:1 checkpoints are per chat, so the chat list adds those on
 * the row that holds them. */
export function needsYou(state, group) {
  if (!state || !group) return 0;
  const drafts = group.id === X_GROUP ? (state.drafts || []).filter(d => d.status === 'pending' || d.status === 'ready').length : 0;
  const paused = (state.groupRuns || []).filter(r => r.groupId === group.id && r.status === 'awaiting_checkpoint').length;
  return drafts + paused;
}

/** Pending browser requests in one chat. Dispatched and finished ones are the device's, not the person's. */
export function pendingBrowser(state, chatKey) {
  return (state?.browserRequests || []).filter(r => r.status === 'pending' && r.chatKey === chatKey).length;
}

export const FEED_WAIT = 'Waiting on you to approve a read of your X home feed. Nothing else runs until you do.';
export const FEED_OPEN = 'Opening your X home feed. The other bots start when that page comes back.';

/** Who a Retry should talk to, and which conversation it reports into.
 * A tracked run must name the primary bot again, or the retry becomes the whole pipeline. */
export function retryTarget(group, run) {
  const lead = (group?.bots || []).find(b => botSettings(b).lead);
  const direct = run?.mode === 'tracked' ? (lead?.id || '') : run?.mode === 'direct' ? (run.recipients?.[0] || '') : '';
  return {direct, chat: run?.chatKey || ''};
}

/** What an open tab should do when a run is sitting on a home-feed read.
 * `follow` keeps watching. `wait` stops on the Approve card.
 * `lookAgain` is one more look: Start can return before the read is sent. */
export function feedPauseAction(request, {graceUsed = false} = {}) {
  if (request && request.status !== 'pending') return {action: 'follow', text: request.status === 'dispatched' ? FEED_OPEN : ''};
  if (!graceUsed) return {action: 'lookAgain', text: ''};
  return {action: 'wait', text: FEED_WAIT};
}

// System lines with a kind of their own paint a card, not a run note.
const RUN_LESS_KINDS = new Set(['browser', 'subagent', 'peer', 'bot-created']);

/** A system line that may carry Start, Retry or Approve. A browser card or a
 * sub-agent line has its own presentation and returns before those, so it must
 * not count as the note: otherwise the action is computed for a line that never
 * paints it, and the real note loses its button. */
export function isRunNote(message) {
  return Boolean(message && message.role === 'system' && message.runId && !RUN_LESS_KINDS.has(message.kind));
}


/** Buttons one system line may show at once. They stack. A missing feed
 * permission is also a failed run, so Grant must not hide Retry. Plans and
 * checkpoints also show on the static demo; Retry needs the Node build. */
export function threadLineActions({kind, senderId, status, live = false, note = false, latest = false} = {}) {
  const failed = status === 'failed' || status === 'interrupted';
  return {
    grant: Boolean(kind === 'feed-permission' && senderId),
    plan: Boolean(note && status === 'awaiting_plan'),
    checkpoint: Boolean(note && status === 'awaiting_checkpoint'),
    retry: Boolean(live && note && latest && failed),
  };
}

/** Workspace runs first, then any same-id local simulation record only when
 * the workspace has no copy. A stale local "waiting" plan must not outvote
 * the server, and a demo plan that was never stored on the workspace still counts. */
function mergedRuns(state, localRuns) {
  const seen = new Set(), runs = [];
  for (const run of [...(state?.groupRuns || []), ...(localRuns || [])]) {
    if (!run) continue;
    // A run with no id still counts (a checkpoint is one). Only a repeated id
    // is dropped, and the workspace copy is the one that was seen first.
    if (run.id && seen.has(run.id)) continue;
    if (run.id) seen.add(run.id);
    runs.push(run);
  }
  return runs;
}

/** A home-feed read already sent to the device, while its run is still waiting.
 * The person can decline it. Until they do, that group cannot start another run. */
export function stuckFeedReads(state, chatKey) {
  const waiting = new Set((state?.groupRuns || []).filter(r => r.status === 'awaiting_feed' && r.chatKey === chatKey).map(r => r.id));
  if (!waiting.size) return 0;
  return (state?.browserRequests || []).filter(r => r.purpose === 'feed' && r.status === 'dispatched' && r.chatKey === chatKey && waiting.has(r.runId)).length;
}

function preview(history, {isTeam, fallback}) {
  const last = history[history.length - 1];
  if (!last) return {text: fallback, sender: ''};
  const text = String(last.text || '').replace(/\s+/g, ' ').slice(0, 120);
  if (last.role === 'user') return {text, sender: 'You'};
  if (last.role === 'bot' && isTeam) return {text, sender: last.senderName || ''};
  return {text, sender: ''};
}

/** Rows for the chat list: every group conversation and every bot, pinned
 * first, then most recent activity, otherwise in their natural order. */
export function chatRows({state, messages = {}, profiles = {}, typing = new Set(), filter = 'all', query = '', localRuns = []}) {
  const rows = [];
  const groupRuns = mergedRuns(state, localRuns);
  const view = {...(state || {}), groupRuns};
  for (const group of state?.groups || []) {
    const tint = bot => tintOf(bot, group.bots.indexOf(bot), profiles);
    const members = group.bots.map(bot => ({name: bot.name, tint: tint(bot)}));
    const teamId = teamKey(group.id), teamHistory = messages[teamId] || [], pages = pendingBrowser(view, teamId), feeds = stuckFeedReads(view, teamId);
    const plans = groupRuns.filter(r => r.status === 'awaiting_plan' && runBelongsToChat(r, teamId)).length;
    const pauses = groupRuns.filter(r => r.status === 'awaiting_checkpoint' && runBelongsToChat(r, teamId)).length;
    const drafts = group.id === X_GROUP ? (view.drafts || []).filter(d => d.status === 'pending' || d.status === 'ready').length : 0;
    const needs = drafts + pauses + pages + feeds + plans;
    rows.push({
      id: teamId, isTeam: true, name: group.name, members, needs, pinned: false, typing: typing.has(teamId),
      at: teamHistory[teamHistory.length - 1]?.at || '',
      ...(pages ? {text: pages === 1 ? 'Wants to open a page' : `${pages} pages waiting on you`, sender: ''} : feeds ? {text: 'A feed read is still open', sender: ''} : preview(teamHistory, {isTeam: true, fallback: needs ? `${needs} waiting on you` : (group.description || 'Message the whole team')})),
    });
    for (const bot of group.bots) {
      const history = messages[bot.id] || [], botPages = pendingBrowser(view, bot.id), botFeeds = stuckFeedReads(view, bot.id);
      const plans = groupRuns.filter(r => r.status === 'awaiting_plan' && runBelongsToChat(r, bot.id)).length;
      const pauses = groupRuns.filter(r => r.status === 'awaiting_checkpoint' && runBelongsToChat(r, bot.id)).length;
      rows.push({
        id: bot.id, isTeam: false, name: bot.name, tint: tint(bot), needs: botPages + botFeeds + plans + pauses, groupName: group.name,
        pinned: Boolean(profiles[bot.id]?.pinned), typing: typing.has(bot.id),
        at: history[history.length - 1]?.at || '',
        ...(botPages ? {text: botPages === 1 ? 'Wants to open a page' : `${botPages} pages waiting on you`, sender: ''} : botFeeds ? {text: 'A feed read is still open', sender: ''} : preview(history, {isTeam: false, fallback: bot.instructions || 'Say what you need'})),
      });
    }
  }
  const q = String(query).trim().toLowerCase();
  const kept = rows.filter(r => {
    if (filter === 'needs' && !r.needs) return false;
    if (filter === 'groups' && !r.isTeam) return false;
    if (filter === 'bots' && r.isTeam) return false;
    return !q || `${r.name} ${r.text} ${r.groupName || ''}`.toLowerCase().includes(q);
  });
  return kept.map((row, order) => ({row, order}))
    .sort((a, b) => Number(b.row.pinned) - Number(a.row.pinned) || time(b.row.at) - time(a.row.at) || a.order - b.order)
    .map(x => x.row);
}

const MAX_POSTS = 20;
/** A thread is the saved messages plus, in the X group, the posts and drafts
 * themselves as messages, so a decision is answered where it was asked. */
export function timeline({conv, state, messages = {}}) {
  const items = (messages[conv.id] || []).map(message => ({kind: 'message', at: message.at, message}));
  if (conv.isTeam && conv.group.id === X_GROUP) {
    const drafts = state?.drafts || [];
    for (const draft of drafts) items.push({kind: 'draft', at: draft.createdAt, draft});
    const posts = [...(state?.candidates || [])].sort((a, b) => time(b.createdAt) - time(a.createdAt)).slice(0, MAX_POSTS);
    for (const post of posts) items.push({kind: 'post', at: post.createdAt, post, drafted: drafts.some(d => d.candidateId === post.id)});
  }
  const rank = {post: 0, draft: 1, message: 2};
  const sorted = items.map((item, order) => ({item, order}))
    .sort((a, b) => time(a.item.at) - time(b.item.at) || rank[a.item.kind] - rank[b.item.kind] || a.order - b.order)
    .map(x => x.item);
  const out = [];
  let day = null, lastSender = null;
  for (const item of sorted) {
    const d = new Date(time(item.at)).toDateString();
    if (d !== day) { day = d; lastSender = null; out.push({kind: 'day', at: item.at}); }
    const sender = item.kind === 'message' ? `${item.message.role}:${item.message.senderId || item.message.senderName || ''}` : item.kind;
    out.push({...item, lead: sender !== lastSender});
    lastSender = item.kind === 'message' ? sender : null;
  }
  return out;
}

/** A bot's avatar colour: the synced setting, then this browser's pick, then
 * its position in the group. */
export function tintOf(bot, index = 0, profiles = {}) {
  const synced = bot?.settings?.tint;
  if (Number.isInteger(synced)) return synced;
  return profiles[bot?.id]?.avatarIndex ?? Math.max(0, index);
}

/** Names to offer while the last word being typed starts with '@'. `roster`
 * is [{id, name}]; a team chat also offers @everyone. */
export function mentionSuggestions(roster, text, {team = false, limit = 6} = {}) {
  const word = /(?:^|\s)@([^\s@]*)$/.exec(String(text ?? ''));
  if (!word) return [];
  const q = word[1].toLowerCase(), seen = new Set(), out = [];
  const pool = [...(team ? [{id: 'everyone', name: 'everyone'}] : []), ...(roster || [])];
  for (const bot of pool) {
    const name = String(bot?.name || '').trim(), key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    if (!key.startsWith(q) && !String(bot.id || '').toLowerCase().startsWith(q)) continue;
    seen.add(key); out.push({id: bot.id, name});
    if (out.length >= limit) break;
  }
  return out;
}
/** Replace the '@word' being typed at the end of `text` with the full name. */
export const completeMention = (text, name) => String(text ?? '').replace(/@[^\s@]*$/, `@${name} `);

/** Scheduled bot prompts for one chat: the group chat (botId null) or a bot. */
export function chatTasks(tasks, groupId, botId = null) {
  return (tasks || []).filter(t => t?.kind === 'bot-task' && t.status !== 'cancelled'
    && t.payload?.groupId === groupId && (t.payload?.botId ?? null) === (botId ?? null));
}

/** The pipeline editor's rows: the saved order first, then bots left out. */
export function pipelineRows(group, pipeline = null) {
  const bots = group?.bots || [], ids = bots.map(b => b.id);
  const order = Array.isArray(pipeline) ? pipeline.filter(id => ids.includes(id)) : ids;
  return [...order, ...ids.filter(id => !order.includes(id))].map(id => ({id, included: order.includes(id)}));
}
/** Move row `index` one place up (-1) or down (+1); out of range is a no-op. */
export function moveRow(rows, index, delta) {
  const next = [...rows], to = index + delta;
  if (index < 0 || index >= next.length || to < 0 || to >= next.length) return next;
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}
/** What to save: the included ids in order, or null when that is simply every
 * bot in roster order (so bots added later join the pipeline too). */
export function pipelineValue(rows, group) {
  const ids = (group?.bots || []).map(b => b.id), picked = rows.filter(r => r.included).map(r => r.id);
  return picked.length === ids.length && picked.every((id, i) => id === ids[i]) ? null : picked;
}

const GROUP_SECTIONS = ['home', 'drafts', 'posts', 'reminders', 'runs', 'voice', 'group-settings', 'tasks'];
const BOT_SECTIONS = ['home', 'edit', 'tasks'];
const LEGACY_TABS = {overview: 'home', discovery: 'posts', approvals: 'drafts', schedules: 'reminders', activity: 'runs', settings: 'voice'};
const PAGES = ['you', 'about', 'notifications', 'workspaces', 'ai', 'team', 'agents', 'data'];
const SERVER_PAGES = ['notifications', 'workspaces'];
const ADMIN_PAGES = ['ai', 'team', 'agents', 'data'];

/** Hash → route. Unknown or forbidden targets fall back to the chat list, and
 * the pre-chat routes (#inbox, #group/<id>/<tab>) keep working as redirects. */
export function parseRoute(hash, state, {server = false, admin = false, write = true} = {}) {
  const none = {chat: null, page: null, info: null};
  const parts = String(hash || '').replace(/^#/, '').split('/').map(p => { try { return decodeURIComponent(p); } catch { return p; } });
  const groups = state?.groups || [];
  const chatExists = id => groups.some(g => teamKey(g.id) === id || g.bots.some(b => b.id === id));
  const section = (id, name) => (id.startsWith('team-') ? GROUP_SECTIONS : BOT_SECTIONS).includes(name) ? name : 'home';
  const [head, a, b, c] = parts;
  if (head === 'chat' && a && chatExists(a)) {
    let info = b === 'info' ? section(a, c || 'home') : null;
    if (info === 'edit' && !write) info = 'home';
    return {...none, chat: a, info};
  }
  // Legacy #group/<id>/<tab> redirects only apply to the X-engage workspace:
  // its tab names map to its info sections. Any other group falls back to its
  // own home, so its panel never shows the X group's drafts or posts.
  if (head === 'group' && groups.some(g => g.id === a)) return {...none, chat: teamKey(a), info: (a === X_GROUP && Object.hasOwn(LEGACY_TABS, b)) ? LEGACY_TABS[b] : 'home'};
  if (head === 'inbox' && chatExists(teamKey(X_GROUP))) return {...none, chat: teamKey(X_GROUP), info: 'drafts'};
  const page = head === 'you' ? (a || 'you') : head;
  if (PAGES.includes(page)) {
    if (ADMIN_PAGES.includes(page) && !admin) return none;
    if (SERVER_PAGES.includes(page) && !server) return none;
    return {...none, page};
  }
  return none;
}
export function routeHash(route) {
  if (route.page) return route.page === 'you' ? 'you' : `you/${route.page}`;
  if (!route.chat) return 'chats';
  const base = `chat/${encodeURIComponent(route.chat)}`;
  return route.info ? `${base}/info${route.info === 'home' ? '' : `/${route.info}`}` : base;
}
