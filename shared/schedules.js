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

export const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
/** Which days a daily schedule runs: Monday to Friday, or Saturday and Sunday. '' or absent means every day. */
export const DAY_RULES = ['weekdays', 'weekends'];
/** An IANA time zone ("Europe/Paris") this runtime knows, in its canonical spelling, or '' for anything else. */
export function cleanZone(value) {
  if (typeof value !== 'string' || !value || value.length > 64) return '';
  try { return new Intl.DateTimeFormat('en-US', {timeZone: value}).resolvedOptions().timeZone; } catch { return ''; }
}
/** Minutes from midnight of `time` on the clock of `zone`, or null when the zone is unusable. */
function minuteIn(time, zone) {
  if (!zone) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {timeZone: zone, hour: 'numeric', minute: 'numeric', hourCycle: 'h23'}).formatToParts(time);
    const part = type => Number(parts.find(p => p.type === type)?.value);
    const hour = part('hour'), minute = part('minute');
    return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : null;
  } catch { return null; }
}
/** Put a daily or weekly run back on its time of day (`at`, "08:00") on the owner's clock (`zone`). A fixed 24-hour
 * step lands an hour off after a daylight-saving change; this moves it by that difference (at most two hours). With
 * no time or no usable zone the time is kept as it is. */
export function keepWallTime(time, at, zone) {
  const want = /^(\d{2}):(\d{2})$/.exec(cleanAt(at));
  const minute = want ? minuteIn(time, zone) : null;
  if (minute === null) return time;
  let diff = Number(want[1]) * 60 + Number(want[2]) - minute;
  if (diff > 720) diff -= 1440;
  if (diff < -720) diff += 1440;
  return Math.abs(diff) <= 120 ? time + diff * 60000 : time;
}
/** The day of the week (0 = Sunday) of `time` in `zone`, or on this machine's clock when there is no usable zone. */
function weekday(time, zone) {
  if (zone) {
    try { return DAYS.indexOf(new Intl.DateTimeFormat('en-US', {timeZone: zone, weekday: 'long'}).format(time).toLowerCase()); } catch { /* unknown zone */ }
  }
  return new Date(time).getDay();
}
/** Move a planned time forward, one step (`step` ms) at a time, until it falls on a day the rule allows (at most a
 * week). The day is read in `zone`, the owner's time zone the schedule was made in, so a server on another clock
 * keeps the owner's Monday; with none it is this machine's. */
export function skipToDays(time, step, rule, zone = '') {
  if (!DAY_RULES.includes(rule)) return time;
  const allowed = day => (rule === 'weekdays' ? day >= 1 && day <= 5 : day === 0 || day === 6);
  let next = time;
  for (let i = 0; i < 7 && !allowed(weekday(next, zone)); i++) next += step;
  return next;
}
/** A live recurring schedule whose time of day or day rule is read on the owner's clock, saved by an older build with
 * no zone (`tz`). The app sends its zone for these once (`POST /api/tasks/zone`, `fillScheduleZones`). */
export const needsZone = task => task?.kind === 'bot-task' && ['queued', 'paused', 'running'].includes(task.status)
  && task.payload?.kind === 'interval' && !task.payload.tz && Boolean(task.payload.at || task.payload.days);
/** Does any schedule in a snapshot need the owner's zone? */
export const schedulesNeedZone = state => (Array.isArray(state?.tasks) ? state.tasks : []).some(needsZone);
/** "Mon", "monday", "Mondays" as "monday", or '' when it is not a day of the week. */
export function cleanDay(value) {
  const text = String(value ?? '').trim().toLowerCase().replace(/s$/, '');
  return text.length >= 3 ? DAYS.find(day => day.startsWith(text) || text === day) || '' : '';
}

/** The Schedule form's "How often" choices; "week:<day>" is weekly on that day. */
export const SCHEDULE_OFTEN = [['1440', 'Every day'], ['60', 'Every hour'], ['weekdays', 'Every weekday'], ['weekends', 'Every weekend'], ...DAYS.slice(1).concat(DAYS[0]).map(day => [`week:${day}`, `Every ${day[0].toUpperCase()}${day.slice(1)}`]), ['', 'Once']];
/** A "How often" choice as {every, on}. */
export function scheduleChoice(value) {
  const text = String(value ?? '');
  if (DAY_RULES.includes(text)) return {every: 1440, on: '', days: text};
  if (text.startsWith('week:')) return {every: 10080, on: cleanDay(text.slice(5))};
  return {every: Number(text) || undefined, on: ''};
}

/** The next moment the local clock reads `at` (today if still ahead, else tomorrow), or null. With `on`, the next
 * such moment on that day of the week. */
export function nextAtFor(at, now = new Date(), on = '') {
  const clean = cleanAt(at);
  if (!clean) return null;
  const [h, m] = clean.split(':').map(Number);
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
  const day = DAYS.indexOf(cleanDay(on));
  if (day >= 0) {
    next.setDate(next.getDate() + ((day - next.getDay() + 7) % 7));
    if (next.getTime() <= now.getTime() + 30000) next.setDate(next.getDate() + 7);
    return next;
  }
  if (next.getTime() <= now.getTime() + 30000) next.setDate(next.getDate() + 1);
  return next;
}

/** "every day at 08:00", "every 45 minutes", "once at 17:30". */
export function whenWords({every, at, on, days} = {}) {
  const time = cleanAt(at), when = time ? ` at ${time}` : '', day = cleanDay(on);
  if (!every) return `once${when || ' soon'}`;
  const unit = every === 1440 && DAY_RULES.includes(days) ? `every ${days === 'weekdays' ? 'weekday' : 'weekend'}` : every === 1440 ? 'every day' : every === 60 ? 'every hour' : every === 10080 ? (day ? `every ${day[0].toUpperCase()}${day.slice(1)}` : 'every week') : `every ${every} minutes`;
  return `${unit}${when}`;
}

const live = t => t?.kind === 'bot-task' && ['queued', 'running', 'paused'].includes(t.status);
const timingOf = t => ({every: t.payload?.kind === 'interval' ? Number(t.payload.intervalMinutes) || Number(t.intervalMinutes) : undefined, at: t.payload?.at || '', on: t.payload?.on || '', days: t.payload?.days || ''});

/** A bot's live schedules (or every bot's, with no id), newest first: id, botId, what, when, next run, and why the
 * last try failed (null once one succeeds), so a schedule that keeps failing says so on its card. */
export function scheduleRows(state, botId = null) {
  return (state?.tasks || []).filter(t => live(t) && (!botId || t.payload?.botId === botId))
    .map(t => ({id: t.id, botId: t.payload?.botId || null, what: String(t.payload?.message || ''), when: whenWords(timingOf(t)), nextAt: t.runAt || null, paused: t.status === 'paused', lastError: t.lastError ? String(t.lastError).slice(0, 300) : null}));
}

/** The `POST /api/tasks` body for a schedule card or the Schedule form, with the first run at the next local
 * `at` (the browser's clock, so "08:00" means the owner's 8 in the morning). */
export function scheduleTaskBody({botId, groupId, message, every, at, on, days}, now = new Date()) {
  // A weekly schedule on a named day runs first on that day; the timer then steps a week from the planned time.
  const day = every === 10080 ? cleanDay(on) : '';
  // A weekdays or weekends schedule runs daily, but its first run must also land on an allowed day.
  const rule = every === 1440 && DAY_RULES.includes(days) ? days : '';
  const time = cleanAt(at) || (day ? '09:00' : ''), first0 = time ? nextAtFor(time, now, day) : null;
  const first = first0 && rule ? new Date(skipToDays(first0.getTime(), 86400000, rule)) : first0;
  const timing = every ? {kind: 'interval', intervalMinutes: every} : {kind: 'once'};
  // The server re-arms a recurring schedule each time it runs, so one with a time of day or a day rule carries the zone this
  // browser's clock is in: its 08:00 and its Monday stay the owner's across daylight saving and on a server elsewhere.
  let tz = '';
  if (every && (rule || time)) { try { tz = cleanZone(Intl.DateTimeFormat().resolvedOptions().timeZone); } catch { /* no Intl time zone */ } }
  return {kind: 'bot-task', payload: {groupId, botId, message, ...timing, ...(time ? {at: time} : {}), ...(day ? {on: day} : {}), ...(rule ? {days: rule} : {}), ...(tz ? {tz} : {}), ...(first ? {nextAt: first.toISOString()} : {})}};
}

/** Failures that waiting will not fix: the schedule stops at once instead of spending a run each time. */
const PERMANENT = new Set(['auth', 'model-not-found', 'quota', 'not-signed-in', 'cli-missing']);
/** Failed runs in a row before a schedule stops itself. */
export const MAX_FAILED_RUNS = 3;

/** Record how a scheduled run ended on its task, and stop the schedule when it keeps failing. Returns the line
 * the bot's chat shows (and the owner is notified of), `paused` when the schedule stopped, or null for a
 * success or an unknown task. Mutates `state`. */
export function scheduleRunEnded(state, taskId, {ok, error = null}) {
  const task = (state?.tasks || []).find(t => t.id === taskId && t.kind === 'bot-task');
  if (!task) return null;
  // In the payload: that is the part of a task the store keeps whole.
  task.payload = {...task.payload, failures: ok ? 0 : (Number(task.payload?.failures) || 0) + 1};
  if (ok) return null;
  const failures = task.payload.failures;
  const why = String(error?.message || 'unknown error').replace(/\s+/g, ' ').trim().slice(0, 300);
  const what = `Scheduled task "${String(task.payload?.label || task.payload?.message || '').slice(0, 80)}"`;
  const bot = (state.groups || []).flatMap(g => g.bots || []).find(b => b.id === task.payload?.botId);
  const live = ['queued', 'running'].includes(task.status);
  const stop = live && (PERMANENT.has(error?.code) || failures >= MAX_FAILED_RUNS);
  if (!stop) return {paused: false, text: `${what} failed: ${why}${live ? ' It runs again at its next time.' : ''}`};
  task.status = 'cancelled';
  task.lastError = why;
  const after = PERMANENT.has(error?.code) ? '' : ` after ${failures} failed runs in a row`;
  return {paused: true, text: `${what} stopped${after}: ${why} Fix it, then add it again on ${bot?.name || 'the bot'}'s Schedule page.`};
}
