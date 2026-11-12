/** The daily briefing: an ordinary schedule (shared/schedules.js, run by the task queue) on the primary bot,
 * marked `brief: 'daily'`. When it runs, `briefingMessage` puts the facts of the workspace under its instruction:
 * what finished in the last 24 hours, what failed, what waits on the owner and what is coming up. The bot is told
 * to use only those, so it reports real work instead of making some up. Both engines call it at run time
 * (src/coordination.js `runBotTask`, shared/local-api.js), so the facts are the ones of that morning.
 * Pure and browser-safe (tests/briefing.test.js). */
import {primaryOf, PRIMARY_GROUP} from './company.js?v=2c827d8a6b';
import {scheduleRows, scheduleTaskBody, cleanAt} from './schedules.js?v=2c827d8a6b';
import {pendingAsks, askText} from './asks.js?v=2c827d8a6b';

/** One briefing per workspace: the queue keeps a single row under this key. */
export const BRIEFING_KEY = 'daily-briefing';
export const BRIEFING_LABEL = 'Daily briefing';
export const BRIEFING_MESSAGE = 'Daily briefing: write me a short morning briefing in four parts: Done yesterday, Waiting on you, Coming up, Failed. Keep each part to a few lines.';
const DAY = 86400000, PER_LIST = 8, MAX_MESSAGE = 4000;
const PARKED = {
  awaiting_plan: 'a plan waits for your Start', awaiting_checkpoint: 'a step waits for your approval',
  awaiting_limit: 'a task stopped at a limit and waits for you', awaiting_browser: 'a page waits for your Allow',
};

// A fact never carries an @mention on into the run: the briefing is the primary's to write, not a handoff.
const short = (text, max = 120) => { const flat = String(text ?? '').replace(/\s+/g, ' ').replace(/(^|\s)@(?=\S)/g, '$1').trim(); return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat; };
const botsOf = state => (state?.groups || []).flatMap(g => g.bots || []);
const nameOfBot = (state, id) => botsOf(state).find(b => b.id === id)?.name || 'A bot';
/** Where a run happened, as the owner knows it: the bot's chat or the thread's title. */
function placeOf(state, run) {
  const key = String(run.chatKey || '');
  if (key && !key.startsWith('team-')) return nameOfBot(state, key);
  const id = key ? key.slice(5) : run.groupId;
  return (state?.groups || []).find(g => g.id === id)?.name || 'A thread';
}
const within = (iso, now) => { const t = Date.parse(iso); return Number.isFinite(t) && t <= now.getTime() && t > now.getTime() - DAY; };
const briefingIds = state => new Set((state?.tasks || []).filter(t => t?.payload?.brief === 'daily').map(t => t.id));

/** The four lists the briefing reads, each a line per item, newest first. */
export function briefingFacts(state, now = new Date()) {
  const own = briefingIds(state), runs = (state?.groupRuns || []).filter(r => !own.has(r.scheduleId));
  const newest = (a, b) => String(b.completedAt || b.updatedAt || '').localeCompare(String(a.completedAt || a.updatedAt || ''));
  const done = runs.filter(r => r.status === 'completed' && within(r.completedAt, now)).sort(newest)
    .map(r => `${placeOf(state, r)}: ${short(r.input)}`);
  const failedRuns = runs.filter(r => ['failed', 'interrupted'].includes(r.status) && within(r.completedAt || r.updatedAt, now)).sort(newest)
    .map(r => `${placeOf(state, r)}: ${short(r.input)}${r.error ? ` (${short(r.error, 160)})` : ''}`);
  const failedSchedules = (state?.tasks || []).filter(t => t.kind === 'bot-task' && !own.has(t.id) && t.lastError
    && (['queued', 'running'].includes(t.status) || within(t.completedAt || t.updatedAt, now)))
    .map(t => `${nameOfBot(state, t.payload?.botId)}: schedule "${short(t.payload?.label || t.payload?.message, 80)}" ${['queued', 'running'].includes(t.status) ? 'last try failed' : 'stopped'} (${short(t.lastError, 160)})`);
  const waiting = [
    ...pendingAsks(state || {}).map(a => askText(a, nameOfBot(state, a.botId))),
    ...runs.filter(r => PARKED[r.status]).map(r => `${placeOf(state, r)}: ${PARKED[r.status]}${r.input ? ` ("${short(r.input, 80)}")` : ''}`),
  ];
  const upcoming = scheduleRows(state).filter(r => !own.has(r.id))
    .sort((a, b) => String(a.nextAt || '').localeCompare(String(b.nextAt || '')))
    .map(r => `${nameOfBot(state, r.botId)}: ${short(r.what, 100)}, ${r.when}${r.nextAt ? `, next ${r.nextAt}` : ''}`);
  return {done, failed: [...failedRuns, ...failedSchedules], waiting, upcoming};
}

const section = (title, lines) => {
  if (!lines.length) return `${title}: none`;
  const shown = lines.slice(0, PER_LIST).map(line => `- ${line}`);
  if (lines.length > PER_LIST) shown.push(`- and ${lines.length - PER_LIST} more`);
  return `${title} (${lines.length}):\n${shown.join('\n')}`;
};

/** The facts as a block of plain lines, with what to do where a list is empty. */
export function briefingContext(state, now = new Date()) {
  const f = briefingFacts(state, now);
  return [
    `Facts from this workspace at ${now.toISOString()}. Use only these facts: if a part has none, say "Nothing". Do not add tasks, names or numbers that are not here.`,
    section('Done in the last 24 hours', f.done), section('Waiting on the owner', f.waiting),
    section('Coming up', f.upcoming), section('Failed', f.failed),
  ].join('\n\n');
}

/** What a briefing run is given: its instruction, then the facts, inside the length a run message may have. */
export function briefingMessage(message, state, now = new Date()) {
  return `${message}\n\n${briefingContext(state, now)}`.slice(0, MAX_MESSAGE);
}

/** The `POST /api/tasks` body that turns the briefing on: every day at `at` (the owner's clock), on the primary bot. */
export function briefingTaskBody(state, {at = '08:00'} = {}, now = new Date()) {
  const time = cleanAt(at);
  if (!time) throw Object.assign(new Error('Pick a time of day for the briefing, like 08:00.'), {status: 400});
  const primary = primaryOf(state);
  if (!primary) throw Object.assign(new Error('There is no primary bot to send the briefing.'), {status: 400});
  const group = (state.groups || []).find(g => (g.bots || []).some(b => b.id === primary.id));
  const body = scheduleTaskBody({botId: primary.id, groupId: group?.id || PRIMARY_GROUP, message: BRIEFING_MESSAGE, every: 1440, at: time}, now);
  return {...body, idempotencyKey: BRIEFING_KEY, payload: {...body.payload, label: BRIEFING_LABEL, brief: 'daily'}};
}

/** The briefing's live schedule as a schedule row (when, next run), or null while it is off. */
export function briefingSchedule(state) {
  const ids = briefingIds(state);
  return scheduleRows(state).find(r => ids.has(r.id)) || null;
}
