/** Work on a timer, in words: how often (`everyMinutes`), the next local time of day (`nextAtFor`), the
 * sentence a card, the brief and the profile all say (`whenWords`), and a bot's queued schedules
 * (`scheduleRows`). Pure, browser-safe and Node-tested (tests/schedules.test.js). The timer itself is a
 * `bot-task` in the task queue (shared/tasks.js), run by src/coordination.js `runBotTask`. */

/** The fewest minutes between runs a bot may propose: each run spends a model call. */
export const MIN_EVERY = 5;
export const MAX_EVERY = 10080;
const WORDS = [
  [/^(every\s+)?(day|daily|morning|evening|night|afternoon)s?$/, 1440],
  [/^(every\s+)?(hour|hourly)$/, 60],
  [/^(every\s+)?(week|weekly)$/, 10080],
];

/** Minutes between runs, from a number or plain words ("day", "every morning", "hourly", "week").
 * @returns {number|null|undefined} the minutes, null when refused, undefined when nothing was given. */
export function everyMinutes(value) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  const text = String(value).trim().toLowerCase();
  const n = /^\d+$/.test(text) ? Number(text) : WORDS.find(([re]) => re.test(text))?.[1];
  return Number.isInteger(n) && n >= MIN_EVERY && n <= MAX_EVERY ? n : null;
}

/** "8:00" or "08:00" as HH:MM, or '' when it is not a time of day. */
export function cleanAt(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return '';
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

/** The next moment the local clock reads `at` (today if still ahead, else tomorrow), or null. */
export function nextAtFor(at, now = new Date()) {
  const clean = cleanAt(at);
  if (!clean) return null;
  const [h, m] = clean.split(':').map(Number);
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
  if (next.getTime() <= now.getTime() + 30000) next.setDate(next.getDate() + 1);
  return next;
}

/** "every day at 08:00", "every 45 minutes", "once at 17:30". */
export function whenWords({every, at} = {}) {
  const time = cleanAt(at), when = time ? ` at ${time}` : '';
  if (!every) return `once${when || ' soon'}`;
  const unit = every === 1440 ? 'every day' : every === 60 ? 'every hour' : every === 10080 ? 'every week' : `every ${every} minutes`;
  return `${unit}${when}`;
}

const live = t => t?.kind === 'bot-task' && ['queued', 'running'].includes(t.status);
const timingOf = t => ({every: t.payload?.kind === 'interval' ? Number(t.payload.intervalMinutes) || Number(t.intervalMinutes) : undefined, at: t.payload?.at || ''});

/** A bot's live schedules (or every bot's, with no id), newest first: id, botId, what, when, next run. */
export function scheduleRows(state, botId = null) {
  return (state?.tasks || []).filter(t => live(t) && (!botId || t.payload?.botId === botId))
    .map(t => ({id: t.id, botId: t.payload?.botId || null, what: String(t.payload?.message || ''), when: whenWords(timingOf(t)), nextAt: t.runAt || null}));
}

/** The `POST /api/tasks` body for a schedule card or the Schedule form, with the first run at the next local
 * `at` (the browser's clock, so "08:00" means the owner's 8 in the morning). */
export function scheduleTaskBody({botId, groupId, message, every, at}, now = new Date()) {
  const time = cleanAt(at), first = time ? nextAtFor(time, now) : null;
  const timing = every ? {kind: 'interval', intervalMinutes: every} : {kind: 'once'};
  return {kind: 'bot-task', payload: {groupId, botId, message, ...timing, ...(time ? {at: time} : {}), ...(first ? {nextAt: first.toISOString()} : {})}};
}
