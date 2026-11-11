/** Adding a bot a model asked for, on one set of rules.
 *
 * The served loop (`src/bot-create.js`) and the Pages demo (`shared/group-simulator.js`)
 * both turn a parsed ```create-bot request into a company bot here, so a bot
 * made offline is the same bot the server would make: counted against the
 * runaway guard, named once across the company, reporting to its creator (a
 * lead) or the creator's manager, in the first colour nobody uses, holding no
 * permission. It changes `state` in place, so the caller wraps it in its own
 * write (a store update, or the demo's state object).
 */
import {activity} from './core.js?v=588d41953d';
import {logActivity} from './activity-log.js?v=588d41953d';
import {isLead, managerOf, companyBots} from './company.js?v=588d41953d';
import {noteBotWork} from './runaway.js?v=588d41953d';
import {TINT_COUNT} from './ui-kit.js?v=588d41953d';
import {MAX_BOTS_PER_GROUP, buildCreatedBot, nameFromSentence, firstUnusedTint} from './bot-create.js?v=588d41953d';

/** `{record, groupName}` for the bot that was added, or `{refused}` with the
 * reason, in words that follow "tried to create a new bot, but". */
export function addCreatedBot(state, {bot, groupId, request, runId = null, now = new Date().toISOString(), makeId = () => crypto.randomUUID()}) {
  const group = (state.groups || []).find(g => g.id === groupId);
  if (!group) return {refused: 'the group no longer exists.'};
  // Counted in the same write that makes the bot, so the one that crosses the limit is refused.
  if (noteBotWork(state, 'creation', now).paused) return {refused: 'bots are paused. Resume them to let bots make bots.'};
  if ((group.bots || []).length >= MAX_BOTS_PER_GROUP) return {refused: `the group already has ${MAX_BOTS_PER_GROUP} bots. Remove one first.`};
  // One name in the whole company, so an @mention or an ask never lands on the wrong bot.
  const everyone = companyBots(state);
  const names = everyone.map(other => other.name);
  const wanted = {...request};
  if (wanted.derived) wanted.name = nameFromSentence(wanted.job, names);
  else if (names.some(taken => taken.trim().toLowerCase() === wanted.name.toLowerCase())) return {refused: `a bot named ${wanted.name} is already in the company.`};
  // It reports to its creator when the creator leads a team, else to the creator's manager.
  const reportsTo = isLead(state, bot.id) ? bot.id : managerOf(state, bot.id)?.id ?? null;
  const record = buildCreatedBot(wanted, {bot, runId, now, makeId, reportsTo, tint: firstUnusedTint(everyone, TINT_COUNT)});
  group.bots.push(record);
  // A group with an explicit pipeline keeps it ordered, so the new bot joins
  // the end instead of silently never running on a default message.
  if (Array.isArray(group.settings?.pipeline) && !group.settings.pipeline.includes(record.id)) {
    group.settings.pipeline = [...group.settings.pipeline, record.id].slice(0, MAX_BOTS_PER_GROUP);
  }
  activity(state, 'bot', `${bot.name} created ${record.name}.`, {botId: record.id, runId});
  logActivity(state, {botId: record.id, kind: 'bots', text: `${bot.name} created ${record.name}.`, now});
  return {record, groupName: group.name};
}
