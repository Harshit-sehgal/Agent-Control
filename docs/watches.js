/** Watch and tell: a page a bot checks on a timer, compared by code, never by the model.
 *
 * The owner hears once when the page changes (lines that were not there before), or, with `words`, when those words
 * appear; nothing while it stays the same. Clocks, dates and "3 min ago" are not changes (`pageLines`). Three failed
 * checks in a row are one notice and the next good check says so; a permission that stops it is said at once.
 *
 * A watch belongs to a bot and opens its page as that bot (its per-site rules decide), under its own key
 * `watch:<id>`, never the bot's chat: a watched page neither taints that chat (`outsideRead`) nor reaches a model turn.
 * The chat line it leaves names the site, never the page's words. `state.watches` lives in kv `watches`.
 * Pure and browser-safe. Design: docs/superpowers/specs/2026-11-25-watch-and-tell-design.md. */
import {cleanText, validHttpUrl} from './core.js?v=4307004d1d';
import {fail} from './errors.js?v=4307004d1d';
import {siteOf} from './limits.js?v=4307004d1d';

export const WATCH_EVERY = [
  {id: 'hour', label: 'Every hour', ms: 3600000},
  {id: '6h', label: 'Every 6 hours', ms: 6 * 3600000},
  {id: 'day', label: 'Every day', ms: 86400000},
];
export const MAX_WATCHES = 20;
export const FAILS_TO_TELL = 3;
const MAX_LINES = 400, LINE_CHARS = 200, MAX_WORDS = 100;

const findBot = (state, id) => (state.groups || []).flatMap(g => g.bots || []).find(b => b.id === id) || null;
const everyOf = id => WATCH_EVERY.find(e => e.id === id) || null;
const watchOf = (state, id) => (state.watches || []).find(w => w.id === id) || null;
const squash = text => String(text ?? '').replace(/\s+/g, ' ').trim();

/** A new watch. The first check takes the baseline and says nothing (unless its words are already there). */
export function addWatch(state, {botId, url, every = 'day', words = ''} = {}, {now = new Date().toISOString(), makeId = () => crypto.randomUUID()} = {}) {
  const bot = findBot(state, botId);
  if (!bot) fail('Which bot should watch this page?');
  const address = validHttpUrl(cleanText(url, 2000));
  if (!address) fail('Use a public web address that starts with http:// or https://.');
  if (!everyOf(every)) fail(`How often: ${WATCH_EVERY.map(e => e.label.toLowerCase()).join(', ')}.`);
  const wanted = squash(words).slice(0, MAX_WORDS);
  state.watches ??= [];
  if (state.watches.some(w => w.url === address && (w.words || '') === wanted)) fail(`${siteOf(address) || 'That page'} is already watched${wanted ? ' for those words' : ''}.`, 409);
  if (state.watches.length >= MAX_WATCHES) fail(`At most ${MAX_WATCHES} pages can be watched. Remove one first.`, 409);
  const watch = {id: makeId(), botId: bot.id, url: address, every, words: wanted, on: true, createdAt: now, nextAt: now,
    lastCheckedAt: null, lastChangedAt: null, lines: null, wordsSeen: false, fails: 0, problem: '', told: false, requestId: null};
  state.watches.push(watch);
  return watch;
}

/** Switch a watch off or on. Back on, it checks soon. */
export function setWatchOn(state, id, on, {now = new Date().toISOString()} = {}) {
  const watch = watchOf(state, id);
  if (!watch) fail('Watch not found.', 404);
  watch.on = on === true;
  if (watch.on) watch.nextAt = now;
  return watch;
}

export function removeWatch(state, id) {
  const before = (state.watches || []).length;
  state.watches = (state.watches || []).filter(w => w.id !== id);
  if (state.watches.length === before) fail('Watch not found.', 404);
}

/** Watches to check now: on, past their time, not waiting on a check already, and not while the kill switch holds
 * every schedule. */
export function dueWatches(state, now = Date.now()) {
  if (state.schedulesPaused === true) return [];
  return (state.watches || []).filter(w => w.on && !w.requestId && Date.parse(w.nextAt) <= now);
}

// What changes on every load: a clock, a date, "3 min ago", "just now". Numbers otherwise (a price, a count) stay.
const NOISE = [
  /\b\d{4}-\d{2}-\d{2}(?:[t ][\d:.]+z?)?\b/gi,
  /\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b/g,
  /\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?\b/gi,
  /\b\d+\s*(?:s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?)\s+ago\b/gi,
  /\b(?:just now|moments? ago|yesterday|today)\b/gi,
];

/** A page's lines as {text, key}: `key` is the line with what changes on every load taken out, so two loads of an
 * unchanged page have the same keys. At most 400 lines of 200 characters. Pure. */
export function pageLines(text) {
  const out = [];
  for (const raw of String(text ?? '').split('\n')) {
    const line = squash(raw).slice(0, LINE_CHARS);
    if (!line) continue;
    const key = NOISE.reduce((s, re) => s.replace(re, '#'), line.toLowerCase());
    out.push({text: line, key});
    if (out.length >= MAX_LINES) break;
  }
  return out;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Record one check's outcome on a watch and say what the owner should hear: `{notice, line}`, each null when there
 * is nothing to say. `notice` is for the phone ({title, body}); `line` is for the bot's chat and never carries the
 * page's words. `blocked`: the bot may not open the page without asking, which will not fix itself. */
export function recordCheck(state, id, {ok, text = '', error = '', blocked = false} = {}, {now = new Date().toISOString()} = {}) {
  const watch = watchOf(state, id);
  if (!watch) return {notice: null, line: null};
  const bot = findBot(state, watch.botId), name = bot?.name || 'A bot', site = siteOf(watch.url) || watch.url;
  watch.requestId = null;
  watch.lastCheckedAt = now;
  watch.nextAt = new Date(Date.parse(now) + (everyOf(watch.every)?.ms || 86400000)).toISOString();
  if (!ok) {
    watch.fails = (watch.fails || 0) + 1;
    watch.problem = cleanText(error, 300) || 'The page could not be read.';
    if (watch.told || (!blocked && watch.fails < FAILS_TO_TELL)) return {notice: null, line: null};
    watch.told = true;
    const body = `${name} could not read ${watch.url}${blocked ? '' : ` ${plural(watch.fails, 'time')} in a row`}: ${watch.problem}`;
    return {notice: {title: `${name} cannot check ${site}`, body}, line: `${name} cannot check ${site} for you: ${watch.problem}`};
  }
  const recovered = watch.told;
  watch.fails = 0; watch.problem = ''; watch.told = false;
  const lines = pageLines(text);
  const before = watch.lines;
  watch.lines = lines.map(l => l.key);
  let notice = null;
  if (watch.words) {
    const present = squash(text).toLowerCase().includes(watch.words.toLowerCase());
    const appeared = present && !watch.wordsSeen;
    watch.wordsSeen = present;
    if (appeared) {
      watch.lastChangedAt = now;
      const where = lines.find(l => l.text.toLowerCase().includes(watch.words.toLowerCase()))?.text || '';
      notice = {title: `"${watch.words}" is on ${site}`, body: `${name} found it on ${watch.url}${where ? `: ${where}` : '.'}`};
    }
  } else if (before) {
    const seen = new Set(before);
    const added = lines.filter(l => !seen.has(l.key));
    if (added.length) {
      watch.lastChangedAt = now;
      const shown = added.slice(0, 3).map(l => l.text).join(' / ');
      notice = {title: `${site} changed`, body: `${name} is watching ${watch.url}. New: ${shown}${added.length > 3 ? ` (and ${added.length - 3} more lines)` : ''}`};
    }
  }
  if (notice) return {notice, line: watch.words ? `"${watch.words}" is now on ${site}: ${watch.url}` : `${site} changed since the last check: ${watch.url}`};
  if (recovered) return {notice: {title: `${name} is checking ${site} again`, body: `${watch.url} could be read again.`}, line: null};
  return {notice: null, line: null};
}

/** The page request one check sends: a plain read, as the watch's bot, under the watch's own key. */
export function watchRequest(state, watch, {now = new Date().toISOString(), makeId = () => crypto.randomUUID()} = {}) {
  const bot = findBot(state, watch.botId);
  const group = (state.groups || []).find(g => (g.bots || []).some(b => b.id === watch.botId));
  return {id: makeId(), botId: watch.botId, botName: bot?.name || 'A bot', groupId: group?.id || 'home', chatKey: `watch:${watch.id}`, watchId: watch.id,
    kind: 'browser.capture', url: watch.url, steps: [], ...(watch.words ? {find: watch.words} : {}), approved: [], depth: 0,
    status: 'pending', agentTaskIds: [], result: null, error: null, createdAt: now, updatedAt: now};
}

/** A watch from a backup (untrusted): its settings checked with the rules `addWatch` uses, and what it last saw
 * dropped, so the first check after a restore is a new baseline. Null for an entry that is not one. */
export function sanitizeWatch(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(raw.id) ? raw.id : null;
  const botId = typeof raw.botId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(raw.botId) ? raw.botId : null;
  const url = validHttpUrl(cleanText(raw.url, 2000));
  if (!id || !botId || !url || !everyOf(raw.every)) return null;
  const at = typeof raw.createdAt === 'string' && Number.isFinite(Date.parse(raw.createdAt)) ? raw.createdAt : new Date().toISOString();
  return {id, botId, url, every: raw.every, words: squash(raw.words).slice(0, MAX_WORDS), on: raw.on !== false, createdAt: at, nextAt: at,
    lastCheckedAt: null, lastChangedAt: null, lines: null, wordsSeen: false, fails: 0, problem: '', told: false, requestId: null};
}

/** A watch as the UI shows it: without the stored page keys. */
export const publicWatch = w => {
  const {lines, ...rest} = w;
  return {...rest, everyLabel: everyOf(w.every)?.label || w.every, site: siteOf(w.url)};
};
