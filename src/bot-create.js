/** Apply a bot's ```create-bot block to the workspace.
 *
 * The new bot is a normal roster record: a person can edit it, switch it off or
 * remove it like any other. It starts with no permissions, a custom type and
 * the job the creator wrote. Nothing here can grant it a capability.
 */
import {randomUUID} from 'node:crypto';
import {activity} from '../shared/core.js';
import {isLead, managerOf, companyBots} from '../shared/company.js';
import {noteBotWork} from '../shared/runaway.js';
import {TINT_COUNT} from '../shared/ui-kit.js';
import {
  MAX_BOTS_PER_GROUP,
  parseCreateBotRequests, stripCreateBotBlocks, buildCreatedBot, nameFromSentence, firstUnusedTint,
  botCreatedText, botCreateRefusedText,
} from '../shared/bot-create.js';

const stamp = () => new Date().toISOString();

/** Read one reply for a new-bot block and add the bot. Any bot may; the runaway
 * guard is what paces it. Returns the reply without the block, the created
 * records, and chat lines. */
export async function createBotsFromReply(store, {bot, groupId, output, runId = null, makeId = randomUUID, now = stamp}) {
  const found = parseCreateBotRequests(output);
  const text = stripCreateBotBlocks(output);
  const created = [], lines = [];
  if (!found.length) return {text: String(output ?? ''), created, lines};
  const say = value => lines.push({id: makeId(), role: 'system', kind: 'bot-created', text: value, at: now()});
  const item = found[0];
  // A second block is a refused request, not something to drop in silence.
  for (const extra of found.slice(1)) say(botCreateRefusedText(bot, extra.error || 'the request was refused.'));
  if (!item.ok) {
    say(botCreateRefusedText(bot, `the request was refused: ${item.error}`));
    return {text: text || `${bot.name} tried to create a bot.`, created, lines};
  }
  const result = await store.update(state => {
    const group = (state.groups || []).find(g => g.id === groupId);
    if (!group) return {refused: 'the group no longer exists.'};
    // Counted against the runaway guard in the same write that makes the bot, so
    // the bot that crosses the limit is the one refused.
    if (noteBotWork(state, 'creation', now()).paused) return {refused: 'bots are paused. Resume them to let bots make bots.'};
    if ((group.bots || []).length >= MAX_BOTS_PER_GROUP) return {refused: `the group already has ${MAX_BOTS_PER_GROUP} bots. Remove one first.`};
    // One name in the whole company, so an @mention or an ask never lands on the wrong bot.
    const everyone = companyBots(state);
    const names = everyone.map(other => other.name);
    const request = {...item.request};
    if (request.derived) request.name = nameFromSentence(request.job, names);
    else if (names.some(taken => taken.trim().toLowerCase() === request.name.toLowerCase())) return {refused: `a bot named ${request.name} is already in the company.`};
    // It reports to its creator when the creator leads a team, else to the creator's manager.
    const reportsTo = isLead(state, bot.id) ? bot.id : managerOf(state, bot.id)?.id ?? null;
    const record = buildCreatedBot(request, {bot, runId, now: now(), makeId, reportsTo, tint: firstUnusedTint(everyone, TINT_COUNT)});
    group.bots.push(record);
    // A group with an explicit pipeline keeps it ordered, so the new bot joins
    // the end instead of silently never running on a default message.
    if (Array.isArray(group.settings?.pipeline) && !group.settings.pipeline.includes(record.id)) {
      group.settings.pipeline = [...group.settings.pipeline, record.id].slice(0, MAX_BOTS_PER_GROUP);
    }
    activity(state, 'bot', `${bot.name} created ${record.name}.`, {botId: record.id, runId});
    return {record, groupName: group.name};
  });
  if (!result.record) {
    say(botCreateRefusedText(bot, result.refused || 'the request could not be saved.'));
    return {text: text || `${bot.name} tried to create a bot.`, created, lines};
  }
  created.push(result.record);
  say(botCreatedText(bot, result.record, result.groupName));
  return {text: text || `${bot.name} added ${result.record.name} to the team.`, created, lines};
}
