/** Apply a bot's ```create-bot block to the workspace.
 *
 * The new bot is a normal roster record: a person can edit it, switch it off or
 * remove it like any other. It starts with no permissions, a custom type and
 * the job the creator wrote. Nothing here can grant it a capability.
 */
import {randomUUID} from 'node:crypto';
import {activity} from '../shared/core.js';
import {canBot} from '../shared/contracts.js';
import {
  BOT_CREATE_PERMISSION, MAX_BOTS_PER_GROUP,
  parseCreateBotRequests, stripCreateBotBlocks, buildCreatedBot,
  botCreatedText, botCreateRefusedText,
} from '../shared/bot-create.js';

const stamp = () => new Date().toISOString();

/** Read one reply for a new-bot block and, when permitted, add the bot.
 * Returns the reply without the block, the created records, and chat lines. */
export async function createBotsFromReply(store, {bot, groupId, output, runId = null, makeId = randomUUID, now = stamp}) {
  const found = parseCreateBotRequests(output);
  const text = stripCreateBotBlocks(output);
  const created = [], lines = [];
  if (!found.length) return {text: String(output ?? ''), created, lines};
  const say = value => lines.push({id: makeId(), role: 'system', kind: 'bot-created', text: value, at: now()});
  if (!canBot(bot, BOT_CREATE_PERMISSION)) {
    say(botCreateRefusedText(bot, `it does not hold the ${BOT_CREATE_PERMISSION} permission. Grant it in the bot profile to allow this.`));
    return {text: text || `${bot.name} tried to create a bot.`, created, lines};
  }
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
    // Checked again here, against the record as it is now: a person may have
    // revoked the permission or switched the bot off while the reply was being
    // written, and a reply is not an authority of its own.
    const actor = (group.bots || []).find(other => other.id === bot.id) || bot;
    if (!canBot(actor, BOT_CREATE_PERMISSION)) return {refused: `it does not hold the ${BOT_CREATE_PERMISSION} permission. Grant it in the bot profile to allow this.`};
    if ((group.bots || []).length >= MAX_BOTS_PER_GROUP) return {refused: `the group already has ${MAX_BOTS_PER_GROUP} bots. Remove one first.`};
    if ((group.bots || []).some(other => other.name.trim().toLowerCase() === item.request.name.toLowerCase())) {
      return {refused: `a bot named ${item.request.name} is already in this group.`};
    }
    const record = buildCreatedBot(item.request, {bot, runId, now: now(), makeId});
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
