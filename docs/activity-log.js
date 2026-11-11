/** The activity log: one append-only record of what the owner may need to find later.
 *
 * Three kinds, and nothing else:
 *   outside  something left the app (a page opened, a send, a post)
 *   perm     a permission changed (a grant set, or an Always allow)
 *   bots     a bot was made, moved, paused, resumed or deleted; Pause all and Resume
 *
 * Never written for routing, thinking, bot-to-bot messages or reads inside the
 * app: the thread already tells that story, and the log must stay clean.
 *
 * `state.activity` is a list of `{id, at, botId, kind, text, threadId, undoUntil}`,
 * oldest first (append order is the order of record). `text` is one plain sentence
 * with the bot's name in it; `threadId` is the chat key to open when the entry is
 * tapped (a bot id, or `team-<thread>`); `undoUntil` is the end of an Undo window
 * for a held send. Entries are only ever added: the cap and retention remove old
 * ones, and no route edits one. Pure and browser-safe, like the other shared modules.
 */
import {fail} from './errors.js?v=697f915fc5';
import {cleanText} from './core.js?v=697f915fc5';

export const ACTIVITY_KINDS = ['outside', 'perm', 'bots'];
export const ACTIVITY_FILTERS = [...ACTIVITY_KINDS, 'all'];
/** The four filter chips, default first, in the words the screen shows. */
export const ACTIVITY_CHIPS = [
  {filter: 'outside', label: 'Left the app'},
  {filter: 'perm', label: 'Permissions'},
  {filter: 'bots', label: 'Bots'},
  {filter: 'all', label: 'All'},
];
/** The newest entries kept in a workspace; retention removes older ones by age too. */
export const MAX_ACTIVITY = 5000;
export const DEFAULT_PAGE = 50;
export const MAX_PAGE = 200;

const iso = () => new Date().toISOString();

/** Append one entry. Returns it. A kind that is not one of the three, or no text, is refused. */
export function logActivity(state, {botId = null, kind, text, threadId = null, undoUntil = null, now = iso(), makeId = () => crypto.randomUUID()} = {}) {
  if (!ACTIVITY_KINDS.includes(kind)) fail(`Activity kind must be one of: ${ACTIVITY_KINDS.join(', ')}.`);
  const sentence = cleanText(typeof text === 'string' ? text : '', 400);
  if (!sentence) fail('An activity entry needs text.');
  const entry = {id: makeId(), at: now, botId: botId || null, kind, text: sentence, threadId: threadId || null, undoUntil: undoUntil || null};
  state.activity ??= [];
  state.activity.push(entry);
  if (state.activity.length > MAX_ACTIVITY) state.activity = state.activity.slice(-MAX_ACTIVITY);
  return entry;
}

/** A page of the log, newest first. `filter` is a chip (default: what left the app), `before` is the id of
 * the last entry already shown (the next page is older than it), `botId` limits it to one bot's profile.
 * `next` is the cursor for the page after this one, or null at the end; `total` is how many entries the
 * filter matches, for "Show all N". */
export function activityPage(state, {filter = 'outside', before = null, limit = DEFAULT_PAGE, botId = null} = {}) {
  if (!ACTIVITY_FILTERS.includes(filter)) fail(`Filter must be one of: ${ACTIVITY_FILTERS.join(', ')}.`);
  const wanted = Math.floor(Number(limit));
  const size = Number.isFinite(wanted) ? Math.max(1, Math.min(MAX_PAGE, wanted)) : DEFAULT_PAGE;
  const all = Array.isArray(state.activity) ? state.activity : [];
  let matching = all.filter(a => (filter === 'all' || a.kind === filter) && (!botId || a.botId === botId));
  const total = matching.length;
  matching = matching.slice().reverse();
  if (before) {
    const at = matching.findIndex(a => a.id === before);
    // A cursor that is not an entry (or was pruned) starts nothing rather than restarting at the top.
    matching = at === -1 ? [] : matching.slice(at + 1);
  }
  const items = matching.slice(0, size);
  return {items, next: matching.length > size ? items.at(-1).id : null, total};
}

/** Close an Undo window: the send was undone (or is over). Clears `undoUntil` on that one entry; nothing else about it changes. */
export function closeUndo(state, id) {
  const entry = (state.activity || []).find(a => a.id === id);
  if (entry) entry.undoUntil = null;
  return entry || null;
}
