/** Conversation history as workflow state.
 *
 * A conversation is keyed the way the UI routes to it: a bot id, or
 * `team-<groupId>` for a group. Both the Node server and the browser-local
 * transport store history through these functions, so a chat reads the same on
 * every device signed in to a workspace instead of living in one browser.
 *
 * Messages are display records only. Nothing here runs a bot or publishes.
 */
import {cleanText} from './core.js?v=85a553776b';

export const MAX_CHAT_MESSAGES = 300;
const MAX_TEXT = 8000;
const ROLES = ['user', 'bot', 'system'];
/** Optional short fields a message may carry; anything else is dropped. */
const LABELS = ['senderId', 'senderName', 'toBotId', 'runId', 'mode', 'kind'];

function fail(message, status = 400) { throw Object.assign(new Error(message), {status}); }

const chatKeys = state => new Set((state.groups || []).flatMap(g => [`team-${g.id}`, ...(g.bots || []).map(b => b.id)]));

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
 * skipped, so a client can safely resend after a dropped connection. */
export function addChatMessages(state, key, messages, {makeId = () => crypto.randomUUID(), now = new Date().toISOString()} = {}) {
  if (!chatKeys(state).has(key)) fail('Conversation not found.', 404);
  if (!Array.isArray(messages) || !messages.length) fail('Send at least one message.');
  if (messages.length > MAX_CHAT_MESSAGES) fail(`Send at most ${MAX_CHAT_MESSAGES} messages at once.`);
  const clean = messages.map(m => entry(m, makeId, now));
  state.chats ??= {};
  const list = state.chats[key] || [], seen = new Set(list.map(m => m.id));
  let added = 0;
  for (const m of clean) { if (seen.has(m.id)) continue; seen.add(m.id); list.push(m); added++; }
  state.chats[key] = list.slice(-MAX_CHAT_MESSAGES);
  return {ok: true, added};
}

export function clearChat(state, key) {
  const removed = state.chats?.[key]?.length || 0;
  if (state.chats && Object.hasOwn(state.chats, key)) delete state.chats[key];
  return {ok: true, removed};
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
    add(key, message) { const item = {key, message}; unsent.set(message.id, item); queue(item); },
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
