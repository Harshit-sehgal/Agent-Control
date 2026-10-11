/** View models for the chat UI. Pure functions from the stored snapshot to what
 * a pane shows: the chat list, a thread's timeline, the "needs you" count and
 * the hash route. No DOM and no globals, so the product rules here are unit
 * tested directly (tests/ui-model.test.js). */
import {fullDate} from './ui-kit.js?v=aa40e42b9d';

export const ACTIVE_DRAFTS = ['pending', 'scheduled', 'ready'];
const X_GROUP = 'x-engage';
const teamKey = groupId => `team-${groupId}`;
const time = value => { const t = Date.parse(value || ''); return Number.isFinite(t) ? t : 0; };

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

/** How many things in a group are blocked on the human: drafts to decide,
 * drafts ready to post, and runs paused at a checkpoint. */
export function needsYou(state, group) {
  if (!state || !group) return 0;
  const drafts = group.id === X_GROUP ? (state.drafts || []).filter(d => d.status === 'pending' || d.status === 'ready').length : 0;
  const paused = (state.groupRuns || []).filter(r => r.groupId === group.id && r.status === 'awaiting_checkpoint').length;
  return drafts + paused;
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
export function chatRows({state, messages = {}, profiles = {}, typing = new Set(), filter = 'all', query = ''}) {
  const rows = [];
  for (const group of state?.groups || []) {
    const tintOf = bot => profiles[bot.id]?.avatarIndex ?? group.bots.indexOf(bot);
    const members = group.bots.map(bot => ({name: bot.name, tint: tintOf(bot)}));
    const teamId = teamKey(group.id), teamHistory = messages[teamId] || [], needs = needsYou(state, group);
    rows.push({
      id: teamId, isTeam: true, name: group.name, members, needs, pinned: false, typing: typing.has(teamId),
      at: teamHistory[teamHistory.length - 1]?.at || '',
      ...preview(teamHistory, {isTeam: true, fallback: needs ? `${needs} waiting on you` : (group.description || 'Message the whole team')}),
    });
    for (const bot of group.bots) {
      const history = messages[bot.id] || [];
      rows.push({
        id: bot.id, isTeam: false, name: bot.name, tint: tintOf(bot), needs: 0, groupName: group.name,
        pinned: Boolean(profiles[bot.id]?.pinned), typing: typing.has(bot.id),
        at: history[history.length - 1]?.at || '',
        ...preview(history, {isTeam: false, fallback: bot.instructions || 'Say what you need'}),
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

const GROUP_SECTIONS = ['home', 'drafts', 'posts', 'reminders', 'runs', 'voice'];
const BOT_SECTIONS = ['home', 'edit'];
const LEGACY_TABS = {overview: 'home', discovery: 'posts', approvals: 'drafts', schedules: 'reminders', activity: 'runs', settings: 'voice'};
const PAGES = ['you', 'about', 'notifications', 'team', 'agents', 'data'];
const ADMIN_PAGES = ['team', 'agents', 'data'];

/** Hash → route. Unknown or forbidden targets fall back to the chat list, and
 * the pre-chat routes (#inbox, #group/<id>/<tab>) keep working as redirects. */
export function parseRoute(hash, state, {server = false, admin = false} = {}) {
  const none = {chat: null, page: null, info: null};
  const parts = String(hash || '').replace(/^#/, '').split('/').map(p => { try { return decodeURIComponent(p); } catch { return p; } });
  const groups = state?.groups || [];
  const chatExists = id => groups.some(g => teamKey(g.id) === id || g.bots.some(b => b.id === id));
  const section = (id, name) => (id.startsWith('team-') ? GROUP_SECTIONS : BOT_SECTIONS).includes(name) ? name : 'home';
  const [head, a, b, c] = parts;
  if (head === 'chat' && a && chatExists(a)) return {...none, chat: a, info: b === 'info' ? section(a, c || 'home') : null};
  if (head === 'group' && groups.some(g => g.id === a)) return {...none, chat: teamKey(a), info: Object.hasOwn(LEGACY_TABS, b) ? LEGACY_TABS[b] : 'home'};
  if (head === 'inbox' && chatExists(teamKey(X_GROUP))) return {...none, chat: teamKey(X_GROUP), info: 'drafts'};
  const page = head === 'you' ? (a || 'you') : head;
  if (PAGES.includes(page)) {
    if (ADMIN_PAGES.includes(page) && !admin) return none;
    if (page === 'notifications' && !server) return none;
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
