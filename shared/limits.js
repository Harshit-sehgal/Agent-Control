/** How far bots go on one message: pages per reply, browsing and connector rounds, team steps, and whether
 * bot-to-bot messages pause at checkpoints.
 *
 * By default none of these is set. A setting the owner leaves empty means "no limit": only BACKSTOP applies, a
 * safety ceiling far above what normal work needs, so a model stuck in a loop cannot run forever. What actually
 * stops a stuck run is FAIL_STREAK: that many rounds in a row where nothing new came back (every page failed, or
 * the bot only asked for pages it already had) stops the run and tells the owner.
 *
 * `state.limits = {pages, rounds, steps, askCheckpoints}`. Pure and browser-safe.
 */
import {fail} from './errors.js';
import {logActivity} from './activity-log.js';

export const BACKSTOP = {pages: 8, rounds: 25, steps: 30};
export const FAIL_STREAK = 3;
const FIELDS = ['pages', 'rounds', 'steps'];

const number = (value, max) => (Number.isInteger(value) && value >= 1 && value <= max ? value : null);

/** What the owner set; null is no limit. */
export function limitsOf(state) {
  const l = state?.limits && typeof state.limits === 'object' ? state.limits : {};
  return {pages: number(l.pages, Infinity), rounds: number(l.rounds, Infinity), steps: number(l.steps, Infinity), askCheckpoints: l.askCheckpoints === true};
}
const cap = key => state => Math.min(limitsOf(state)[key] ?? BACKSTOP[key], BACKSTOP[key]);
/** Pages (and connector calls) one reply may ask for. */
export const pagesCap = cap('pages');
/** Rounds of pages (and of connector calls) in a row on one message. */
export const roundsCap = cap('rounds');
/** Bot turns one message may take across a team. */
export const stepsCap = cap('steps');

export const limitWords = value => (value == null ? 'No limit' : String(value));

/** Change some limits: a number from 1 to the backstop, or null for no limit; askCheckpoints true or false. */
export function setLimits(state, body = {}) {
  if (!body || typeof body !== 'object') fail('Send the limits to change.');
  const unknown = Object.keys(body).filter(k => ![...FIELDS, 'askCheckpoints'].includes(k));
  if (unknown.length) fail(`There is no limit called "${String(unknown[0]).slice(0, 40)}".`);
  const next = {...limitsOf(state)};
  for (const key of FIELDS) {
    if (!(key in body)) continue;
    if (body[key] === null) { next[key] = null; continue; }
    if (!number(body[key], BACKSTOP[key])) fail(`Choose a whole number from 1 to ${BACKSTOP[key]}, or no limit.`);
    next[key] = body[key];
  }
  if ('askCheckpoints' in body) {
    if (typeof body.askCheckpoints !== 'boolean') fail('Say true or false.');
    next.askCheckpoints = body.askCheckpoints;
  }
  state.limits = next;
  const words = [`pages per reply ${limitWords(next.pages)}`, `rounds ${limitWords(next.rounds)}`, `team steps ${limitWords(next.steps)}`, `checkpoints ${next.askCheckpoints ? 'on' : 'off'}`];
  logActivity(state, {kind: 'perm', text: `Bot limits changed: ${words.join(', ')}.`});
  return next;
}
