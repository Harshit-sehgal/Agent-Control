/** Conversation history as workflow state.
 *
 * A conversation is keyed the way the UI routes to it: a bot id, or
 * `team-<groupId>` for a group. Both the Node server and the browser-local
 * transport store history through these functions, so a chat reads the same on
 * every device signed in to a workspace instead of living in one browser.
 *
 * Messages are display records only. Nothing here runs a bot or publishes.
 */
import {cleanText} from './core.js';
import {fail} from './errors.js';
import {summonableGuests, BUSY_STATUSES} from './coordination.js';
import {denyBrowserRequest} from './bot-browser.js';

export const MAX_CHAT_MESSAGES = 300;
const MAX_TEXT = 8000;
const ROLES = ['user', 'bot', 'system'];
/** Optional short fields a message may carry; anything else is dropped. */
const LABELS = ['senderId', 'senderName', 'toBotId', 'runId', 'mode', 'kind'];

const chatKeys = state => new Set((state.groups || []).flatMap(g => [`team-${g.id}`, ...(g.bots || []).map(b => b.id)]));
const groupOf = (state, key) => (state.groups || []).find(g => `team-${g.id}` === key || (g.bots || []).some(b => b.id === key));

/** What a browser may claim about a message it writes. It can never mark a
 * message as model output (`mode`), and it can never name a sender the
 * conversation does not have: in a group the sender must be one of the group's
 * bots and takes that bot's real name, and in a bot's own chat the only bot is
 * the chat's own.
 * A browser cannot speak as a bot it cannot name: a `bot` line survives only when
 * its sender resolves to a real bot of the conversation (see `addChatMessages`).
 * A `system` notice is plain text the app writes for itself ("that did not go
 * through"), so it stays allowed — but it carries `origin: 'browser'`, and
 * `ui-views.js` will not paint a run note's buttons or a browser card from one:
 * only a server-written note may carry that authority. Least of all a `mode`, so
 * no browser write can claim a model wrote it.
 * Only the server, writing a run it executed itself, is `trusted`. */
function untrusted(state, key, message) {
  delete message.mode; delete message.senderId; delete message.senderName; delete message.toBotId;
  if (message.role !== 'user') message.origin = 'browser';
  return message;
}
/** A claim only survives when the roster backs it: a bot line keeps `bot` and
 * its real name when the sender is a bot of this group (or a summonable guest).
 * A bot's own chat resolves the *same* roster: `@mention` in a DM reaches the
 * group's bots and its summonable guests (`planHandoffs` builds one reachable
 * list for both), so a guest's paragraph there is legitimate and must keep its
 * real author instead of being re-signed as the DM bot's own words. Anything
 * else is the user writing, so a nameless teammate line cannot reach the thread. */
function claimedSender(state, key, raw, message) {
  if (message.role !== 'bot') return message;
  const group = groupOf(state, key);
  if (!group) return message;
  const roster = [...(group.bots || []), ...summonableGuests(state.groups, group.id, {includeOff: true})];
  const sender = roster.find(b => b.id === raw.senderId), next = roster.find(b => b.id === raw.toBotId);
  if (sender) { message.senderId = sender.id; message.senderName = sender.name; }
  if (sender && next) message.toBotId = next.id;
  return message;
}

function entry(raw, makeId, now) {
  if (!raw || typeof raw !== 'object') fail('A message must be an object.');
  if (!ROLES.includes(raw.role)) fail('A message needs a role of user, bot or system.');
  const text = cleanText(raw.text, MAX_TEXT);
  if (!text) fail('A message needs text.');
  const out = {id: cleanText(raw.id, 64) || makeId(), role: raw.role, text, at: Number.isFinite(Date.parse(raw.at)) ? new Date(raw.at).toISOString() : now};
  for (const key of LABELS) { const value = cleanText(raw[key], 120); if (value) out[key] = value; }
  return out;
}

/** Append messages to a conversation. A message whose id is already stored is
 * skipped, so a client can safely resend after a dropped connection.
 *
 * A trusted write (the server recording a run it executed) *replaces* a stored
 * message with the same id instead of being skipped. Without that, a client
 * could post a message using a run id it was handed before the run finished and
 * silence the bot's real reply. */
export function addChatMessages(state, key, messages, {makeId = () => crypto.randomUUID(), now = new Date().toISOString(), trusted = false} = {}) {
  if (!chatKeys(state).has(key)) fail('Conversation not found.', 404);
  if (!Array.isArray(messages) || !messages.length) fail('Send at least one message.');
  if (messages.length > MAX_CHAT_MESSAGES) fail(`Send at most ${MAX_CHAT_MESSAGES} messages at once.`);
  const clean = messages.map(m => {
    if (trusted) return entry(m, makeId, now);
    const e = claimedSender(state, key, m, untrusted(state, key, entry(m, makeId, now)));
    // Only a resolved bot may speak as a bot: a nameless `bot` line would
    // otherwise plant text that reads as a teammate's, and the reader has no way
    // to tell. Everything a browser sends that claims a bot without naming one
    // lands as the user's own line instead. A `system` notice is allowed through
    // (it is text, escaped, with no authority) because the UI writes its own
    // error and status lines this way.
    if (e.role === 'bot' && !e.senderId) e.role = 'user';
    return e;
  });
  state.chats ??= {};
  const list = state.chats[key] || [], seen = new Map(list.map((m, i) => [m.id, i]));
  const written = new Set();
  for (const m of clean) {
    const at = seen.get(m.id);
    if (at !== undefined) {
      if (trusted) { list[at] = m; written.add(m.id); }
      continue;
    }
    seen.set(m.id, list.length);
    list.push(m);
    written.add(m.id);
  }
  state.chats[key] = list.slice(-MAX_CHAT_MESSAGES);
  // `added` counts the messages a reader can actually see. A batch that pushes
  // an earlier line (a trusted replacement, say) out of the window must not be
  // reported as fully stored, so a caller — or a test — can tell a full write
  // from one the window ate.
  const stored = new Set(state.chats[key].map(m => m.id));
  return {ok: true, added: [...written].filter(id => stored.has(id)).length};
}

/** Clearing the thread also ends work that thread was blocking: waiting
 * browser cards and BUSY runs. Leaving those would 409 every later send
 * with no Approve/Start/Continue left on screen. Clearing a group chat also
 * ends work on bot DMs of that group (a Handoff-DM plan still occupies the
 * team). Clearing a bot's own chat only ends work keyed to that conversation. */
export function groupIdOfChat(state, key) {
  if (typeof key !== 'string') return '';
  if (key.startsWith('team-')) return key.slice(5);
  return groupOf(state, key)?.id || '';
}
export function matchesBusyChat(item, key, groupId) {
  if (item.chatKey === key) return true;
  return typeof key === 'string' && key.startsWith('team-') && Boolean(groupId && item.groupId === groupId);
}

export function releaseChatWork(state, key) {
  const groupId = groupIdOfChat(state, key);
  const ofChat = item => matchesBusyChat(item, key, groupId);
  const now = new Date().toISOString();
  for (const request of state.browserRequests || []) {
    if (!ofChat(request) || !['pending', 'dispatched'].includes(request.status)) continue;
    try { denyBrowserRequest(state, request.id); }
    catch { request.status = 'denied'; request.updatedAt = now; }
  }
  for (const run of state.groupRuns || []) {
    if (!ofChat(run) || !BUSY_STATUSES.includes(run.status)) continue;
    run.status = 'cancelled';
    run.error = 'Chat cleared.';
    run.updatedAt = now;
  }
}

export function clearChat(state, key) {
  const removed = state.chats?.[key]?.length || 0;
  if (state.chats && Object.hasOwn(state.chats, key)) delete state.chats[key];
  // The group run log is a second copy of the same lines. Leaving it would let
  // the next stream paint the old run back into an empty thread.
  const groupId = typeof key === 'string' && key.startsWith('team-') ? key.slice(5) : '';
  let extra = 0;
  if (groupId && state.groupMessages && Object.hasOwn(state.groupMessages, groupId)) {
    extra = state.groupMessages[groupId]?.length || 0;
    delete state.groupMessages[groupId];
  }
  releaseChatWork(state, key);
  return {ok: true, removed: removed + extra};
}

/** Drop history whose bot or group is gone. Idempotent. */
export function pruneChats(state) {
  state.chats ??= {};
  const keys = chatKeys(state);
  for (const key of Object.keys(state.chats)) if (!keys.has(key)) delete state.chats[key];
  return state;
}

/** What a client shows for one conversation: the server's copy in the server's
 * order, then any message it sent that the server has not confirmed yet. */
export function mergeChat(server = [], local = [], pending = new Set()) {
  const known = new Set(server.map(m => m.id));
  return [...server, ...local.filter(m => pending.has(m.id) && !known.has(m.id))];
}

/** Client side of history. A message sent from this tab shows at once and stays
 * in the view until a state snapshot fetched after its send confirms it, so a
 * snapshot that was already on its way cannot make it flicker out. Sends go one
 * at a time, which keeps their order on the server.
 * `post(key, messages)` stores messages and rejects with an error carrying `status`. */
/** Upper bound on unconfirmed sends held in a tab, so a tab that cannot reach
 * the server never grows without limit. */
const MAX_UNSENT = 500;

export function createOutbox(post) {
  const unsent = new Map();
  let fetches = 0, chain = Promise.resolve();
  async function deliver(item) {
    try { await post(item.key, [item.message]); item.confirmedFrom = fetches + 1; }
    catch (error) {
      // 403: this account may not write, so the message stays on this screen
      // only. 400/404: the server will never take it. Anything else: retry.
      if (error?.status === 403) item.localOnly = true;
      else if (error?.status === 400 || error?.status === 404) unsent.delete(item.message.id);
      else item.failed = true;
    }
  }
  const queue = item => { chain = chain.then(() => deliver(item)); };
  return {
    add(key, message) {
      const item = {key, message};
      unsent.set(message.id, item);
      // Bound the local backlog: a long-lived tab that cannot reach the server
      // (offline, or sending that keeps failing) would otherwise accumulate
      // unsent messages without limit. The oldest unconfirmed send goes first.
      if (unsent.size > MAX_UNSENT) unsent.delete(unsent.keys().next().value);
      queue(item);
    },
    /** Resolve once nothing is in flight, retrying sends that failed earlier. */
    async settle() { for (const item of unsent.values()) if (item.failed) { item.failed = false; queue(item); } await chain; },
    /** Number a state fetch as it starts; pass the number to `adopt` with its result. */
    beginFetch() { return ++fetches; },
    adopt(chats, local, fetch) {
      for (const [id, item] of unsent) if (item.confirmedFrom && fetch >= item.confirmedFrom) unsent.delete(id);
      const waiting = [...unsent.values()], next = {};
      for (const key of new Set([...Object.keys(chats), ...waiting.map(item => item.key)])) {
        const merged = mergeChat(chats[key] || [], local[key] || [], new Set(waiting.filter(item => item.key === key).map(item => item.message.id)));
        if (merged.length) next[key] = merged;
      }
      return next;
    },
    forget(key) { for (const [id, item] of unsent) if (item.key === key) unsent.delete(id); },
    get size() { return unsent.size; },
  };
}
