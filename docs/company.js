/** The company: every bot, its manager, and the primary bot at the top.
 *
 * A bot's manager is `settings.reportsTo` (a bot id, or null for Solo). A
 * manager is an ordinary bot that has reports. The primary is the lead of the
 * `home` group; it has no manager and cannot be deleted. The chart must stay a
 * tree: one manager per bot, no cycles.
 *
 * Bots still live inside group records. Every bot of every group that is not a
 * thread is a company bot, so a workspace from before the company model keeps
 * its bots; they start Solo and are moved like any other bot.
 *
 * Pure and browser-safe: the server and the Pages engine share these rules.
 */
import {fail} from './errors.js?v=f3b2fa003c';

export const PRIMARY_GROUP = 'home';
export const SHAPES = ['rounded', 'circle', 'hexagon', 'pebble', 'drop', 'shield', 'arch', 'egg', 'blob', 'bean'];

const isThreadGroup = g => g?.settings?.kind === 'thread';
const managerId = bot => (typeof bot?.settings?.reportsTo === 'string' && bot.settings.reportsTo) || null;

/** Every bot in the company, primary first. */
export function companyBots(state) {
  const groups = (state?.groups || []).filter(g => !isThreadGroup(g));
  const home = groups.find(g => g.id === PRIMARY_GROUP);
  const ordered = home ? [home, ...groups.filter(g => g !== home)] : groups;
  return ordered.flatMap(g => g.bots || []);
}

const findBot = (state, id) => companyBots(state).find(b => b.id === id) || null;

export function primaryOf(state) {
  const home = (state?.groups || []).find(g => g.id === PRIMARY_GROUP);
  return (home?.bots || []).find(b => b.settings?.lead) || null;
}

export const isPrimary = (state, botId) => primaryOf(state)?.id === botId;

/** The bot's manager, or null when it is Solo or its manager is gone. */
export function managerOf(state, botId) {
  const id = managerId(findBot(state, botId));
  return id && id !== botId ? findBot(state, id) : null;
}

export function reportsOf(state, botId) {
  return companyBots(state).filter(b => b.id !== botId && managerId(b) === botId);
}

/** Everyone below `botId` in the chart. The primary's team is every other bot. */
export function teamOf(state, botId) {
  if (isPrimary(state, botId)) return companyBots(state).filter(b => b.id !== botId);
  const out = [], seen = new Set([botId]);
  const walk = id => { for (const b of reportsOf(state, id)) if (!seen.has(b.id)) { seen.add(b.id); out.push(b); walk(b.id); } };
  walk(botId);
  return out;
}

export const isLead = (state, botId) => isPrimary(state, botId) || reportsOf(state, botId).length > 0;

/** Whether making `managerId` the manager of `botId` would close a loop. */
function wouldCycle(state, botId, next) {
  const seen = new Set([botId]);
  for (let id = next; id; id = managerId(findBot(state, id))) {
    if (seen.has(id)) return true;
    seen.add(id);
  }
  return false;
}

/** Check a manager change without storing it. */
export function assertManager(state, botId, next) {
  if (next === null || next === undefined || next === '') return null;
  if (typeof next !== 'string') fail('A manager must be a bot id, or empty for Solo.');
  if (isPrimary(state, botId)) fail('The primary bot reports to no one.');
  if (next === botId) fail('A bot cannot report to itself.');
  if (!findBot(state, next)) fail('That manager is not a bot in this workspace.');
  if (wouldCycle(state, botId, next)) fail('That would make a reporting cycle: a bot would end up reporting to itself.');
  return next;
}

export function setManager(state, botId, next) {
  const bot = findBot(state, botId) || fail('Bot not found.', 404);
  const id = assertManager(state, botId, next);
  bot.settings = {...(bot.settings || {}), reportsTo: id};
  return bot;
}

/** Called when a bot leaves: its reports become Solo. Refuses the primary. */
export function releaseReports(state, botId) {
  if (isPrimary(state, botId)) fail(`${primaryOf(state).name} is the primary bot and cannot be deleted.`, 409);
  for (const b of reportsOf(state, botId)) b.settings = {...b.settings, reportsTo: null};
}
