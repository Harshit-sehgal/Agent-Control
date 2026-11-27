/** Search what was said: every bot chat and thread in the workspace snapshot, by the words of a message.
 *
 * The snapshot carries each conversation's stored window whole (`state.chats`, up to MAX_CHAT_MESSAGES per chat
 * in shared/chats.js), so the browser can search all the history there is without a route of its own, on the
 * server build and the Pages demo alike. Every word of the query must appear (in any order); case and accents
 * are ignored. Pure and browser-safe (tests/message-search.test.js). */
import {esc, plain} from './ui-kit.js?v=c985d30feb';
import {isThread} from './threads.js?v=c985d30feb';
import {controlFence} from './reply-blocks.js?v=c985d30feb';

export const MAX_RESULTS = 40;
const BEFORE = 24, WIDTH = 160;

/** Lower case with accents taken off: "Café" and "cafe" read the same. */
export const fold = text => String(text ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const wordsOf = query => fold(query).split(/\s+/).filter(Boolean);

/** Who a chat key belongs to: a bot's own chat or a thread. Any other key (an old team chat, a removed bot) is not
 * a conversation the app opens, so nothing in it is offered. */
function conversationOf(state, key) {
  const groups = state?.groups || [];
  if (key.startsWith('team-')) {
    const group = groups.find(g => `team-${g.id}` === key);
    return group && isThread(group) ? {kind: 'thread', id: group.id, name: group.name || 'Thread'} : null;
  }
  const bot = groups.flatMap(g => g.bots || []).find(b => b.id === key);
  return bot ? {kind: 'bot', id: bot.id, name: bot.name || 'Bot'} : null;
}

/** Messages whose text holds every word of `query`, newest first, at most `limit`. Working steps are left out: the
 * chat does not show them, so a hit could not be scrolled to. */
export function searchMessages(state, query, {limit = MAX_RESULTS} = {}) {
  const words = wordsOf(query);
  if (!words.length) return [];
  const hits = [];
  for (const [key, list] of Object.entries(state?.chats || {})) {
    const conv = conversationOf(state, key);
    if (!conv || !Array.isArray(list)) continue;
    for (const m of list) {
      if (!m || m.step || typeof m.text !== 'string') continue;
      const text = fold(m.text);
      if (words.every(w => text.includes(w))) hits.push({...conv, chatKey: key, messageId: m.id, role: m.role, at: m.at || '', text: m.text});
    }
  }
  return hits.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0)).slice(0, Math.max(0, limit));
}

/** A bot's own look at the older lines of the chat it is answering in (`search_chat`, src/bot-turn.js): the lines
 * every word of `query` appears in, newest first, at most `limit`, each as `{id, from, at, text}` with the text cut to
 * 800 characters, the same cut `threadContext` makes. The newest `skipNewest` lines are left out first, counted the way
 * `threadContext` counts what a model was handed (a user or bot line with text, steps included), so a bot is shown
 * only what it was not given. Working steps are then dropped from what remains: the chat does not show them. */
export function searchChat(messages, query, {skipNewest = 0, limit = 8} = {}) {
  const words = wordsOf(query);
  if (!words.length || !Array.isArray(messages)) return [];
  const given = messages.filter(m => m && m.text && ['user', 'bot'].includes(m.role));
  const older = given.slice(0, Math.max(0, given.length - Math.max(0, Number(skipNewest) || 0)));
  const hits = [];
  for (let i = older.length - 1; i >= 0 && hits.length < Math.max(0, limit); i--) {
    const m = older[i], text = String(m.text);
    if (m.step || !words.every(w => fold(text).includes(w))) continue;
    hits.push({id: m.id, from: m.role === 'user' ? 'user' : (m.senderName || m.senderId || 'bot'), at: m.at || '', text: text.slice(0, 800)});
  }
  return hits;
}

/** The query of the first `search_chat` block in a reply, trimmed, or null when there is none, it is not JSON, or its
 * query is missing or empty. */
export function parseSearchChat(output) {
  const match = controlFence('search_chat').exec(String(output ?? ''));
  if (!match) return null;
  try {
    const query = JSON.parse(match[1].trim())?.query;
    return typeof query === 'string' && query.trim() ? query.trim().slice(0, 200) : null;
  } catch { return null; }
}

/** The folded text with, for each of its characters, where it came from in the original. */
function foldedMap(text) {
  let folded = '';
  const from = [];
  for (let i = 0; i < text.length;) {
    const ch = String.fromCodePoint(text.codePointAt(i)), f = fold(ch);
    for (let k = 0; k < f.length; k++) from.push([i, i + ch.length]);
    folded += f;
    i += ch.length;
  }
  return {folded, from};
}

/** Where each query word occurs in `text`, as merged [start, end) ranges of the original. */
function matchRanges(text, words) {
  const {folded, from} = foldedMap(text), ranges = [];
  for (const w of words) {
    for (let at = folded.indexOf(w); at >= 0; at = folded.indexOf(w, at + w.length)) ranges.push([from[at][0], from[at + w.length - 1][1]]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged.at(-1);
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged;
}

/** A result's line: the message as plain words, cut around its first match, escaped, with each matched word in
 * <mark>. Escaping comes first, so the only tags in the result are the marks made here. */
export function snippetHtml(text, query) {
  const flat = plain(text), ranges = matchRanges(flat, wordsOf(query));
  const start = Math.max(0, (ranges[0]?.[0] ?? 0) - BEFORE), end = Math.min(flat.length, start + WIDTH);
  let html = start > 0 ? '…' : '', at = start;
  for (const [a, b] of ranges) {
    if (b <= start || a >= end) continue;
    const s = Math.max(a, start), e = Math.min(b, end);
    html += `${esc(flat.slice(at, s))}<mark>${esc(flat.slice(s, e))}</mark>`;
    at = e;
  }
  return `${html}${esc(flat.slice(at, end))}${end < flat.length ? '…' : ''}`;
}
