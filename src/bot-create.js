/** Apply a bot's ```create-bot block to the workspace.
 *
 * The new bot is a normal roster record: a person can edit it, switch it off or
 * remove it like any other. It starts with no permissions, a custom type and
 * the job the creator wrote. Nothing here can grant it a capability.
 */
import {randomUUID} from 'node:crypto';
import {addCreatedBot} from '../shared/hire.js';
import {
  parseCreateBotRequests, stripCreateBotBlocks,
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
  const result = await store.update(state => addCreatedBot(state, {bot, groupId, request: item.request, runId, now: now(), makeId}));
  if (!result.record) {
    say(botCreateRefusedText(bot, result.refused || 'the request could not be saved.'));
    return {text: text || `${bot.name} tried to create a bot.`, created, lines};
  }
  created.push(result.record);
  say(botCreatedText(bot, result.record, result.groupName));
  return {text: text || `${bot.name} added ${result.record.name} to the team.`, created, lines};
}
