/** The runaway guard.
 *
 * Bots may create bots and ask bots without a grant, so a model stuck in a loop
 * could spend without end. This is the one general limiter: more than about 50
 * creations or 300 bot-initiated runs (hand-offs, ask rounds, scheduled bot
 * tasks) in five minutes pauses everything bots start. Owner-initiated chats
 * keep working. The owner can also pause and resume all bots by hand; that is
 * the same flag, so Pause all and the guard cannot disagree.
 *
 * The state is `state.guard = {since, runs, creations, paused, pausedAt}`. The
 * window is a fixed five minutes from `since`; a quiet window starts the count
 * over. Pure and browser-safe: the server and the Pages demo share it.
 */
import {activity} from './core.js?v=697db3ab25';
import {logActivity} from './activity-log.js?v=697db3ab25';
import {addChatMessages} from './chats.js?v=697db3ab25';
import {primaryOf} from './company.js?v=697db3ab25';

export const GUARD = {windowMs: 300000, creations: 50, runs: 300};

export const freshGuard = () => ({since: null, runs: 0, creations: 0, paused: false, pausedAt: null});

const guardOf = state => {
  const g = state.guard;
  if (!g || typeof g !== 'object') return (state.guard = freshGuard());
  return g;
};

export const paused = state => Boolean(state?.guard?.paused);

const say = (state, g, text) => {
  const primary = primaryOf(state);
  if (!primary) return;
  try { addChatMessages(state, primary.id, [{id: `guard-${g.pausedAt}`.slice(0, 64), role: 'system', kind: 'guard', text}], {trusted: true}); }
  catch { /* The primary's chat is gone; the flag still holds. */ }
};

/** Count one piece of bot-initiated work and say whether bots are now paused.
 * Work refused while paused is not counted. The count that crosses a limit
 * pauses, and that work is refused too. */
export function noteBotWork(state, kind, now = new Date().toISOString()) {
  const g = guardOf(state);
  if (g.paused) return {paused: true};
  if (!g.since || Date.parse(now) - Date.parse(g.since) > GUARD.windowMs) Object.assign(g, {since: now, runs: 0, creations: 0});
  if (kind === 'creation') g.creations++; else g.runs++;
  if (g.creations > GUARD.creations || g.runs > GUARD.runs) {
    Object.assign(g, {paused: true, pausedAt: now});
    say(state, g, `Bots were very busy: ${g.runs} runs and ${g.creations} new bots in 5 minutes. Everything bots started is paused.`);
    activity(state, 'bot', 'Bots were paused: they were very busy.', {runs: g.runs, creations: g.creations});
    logActivity(state, {kind: 'bots', text: 'Bots were paused: they were very busy.', now});
    return {paused: true};
  }
  return {paused: false};
}

/** Pause all bots by hand (the owner's Pause all). */
export function pauseAll(state, now = new Date().toISOString()) {
  const g = guardOf(state);
  if (g.paused) return g;
  Object.assign(g, {paused: true, pausedAt: now});
  activity(state, 'bot', 'Paused all bots.');
  logActivity(state, {kind: 'bots', text: 'All bots were paused.', now});
  return g;
}

/** Keep going: clear the pause and start a new window. */
export function resumeGuard(state, now = new Date().toISOString()) {
  const g = guardOf(state);
  const was = g.paused;
  Object.assign(g, {...freshGuard(), since: now});
  if (was) { activity(state, 'bot', 'Resumed all bots.'); logActivity(state, {kind: 'bots', text: 'All bots were resumed.', now}); }
  return g;
}
