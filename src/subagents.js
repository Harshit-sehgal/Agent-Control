/** One sub-agent round for a bot reply.
 *
 * The bot's first reply is read for a ```spawn block. When it holds the
 * permission and still has a round left, the helper task runs as its own model
 * call, and the bot that asked gets one more turn with the answer in its
 * envelope. Its second reply is the real answer, so the orchestrator sees
 * exactly one output per bot step. A helper's own reply is never parsed for a
 * block, which is what keeps the tree one level deep.
 */
import {randomUUID} from 'node:crypto';
import {cleanText} from '../shared/core.js';
import {canBot} from '../shared/contracts.js';
import {parseSpawnRequests,stripSpawnBlocks,subagentBot,subagentPrompt,subagentTurn,spawnStartedText,spawnResultText,spawnRefusedText,SUBAGENT_PERMISSION,MAX_SUBAGENT_DEPTH,MAX_SUBAGENT_RESULT} from '../shared/subagents.js';

const stamp = () => new Date().toISOString();

/** Run one bot step, with at most one sub-agent round.
 * `envelope` is the plain object the bot is given (stringified here), `rounds`
 * is how many spawn rounds this bot already used in the run, and `executor` is
 * the model call the orchestrator was given. Returns the final text, the
 * helpers that ran, and the chat lines describing them. */
export async function replyWithSubagents({bot, envelope = {}, executor, config, rounds = 0, makeId = randomUUID, now = stamp}) {
  const first = String(await executor(bot, JSON.stringify(envelope), config) ?? '');
  const found = parseSpawnRequests(first);
  const text = stripSpawnBlocks(first);
  const lines = [], spawns = [];
  if (!found.length) return {output: first, spawns, lines};
  const say = value => lines.push({id: makeId(), role: 'system', kind: 'subagent', text: value, at: now()});
  // A refused request is reported in the chat, never silently dropped.
  const refuse = reason => { say(spawnRefusedText(bot, reason)); return {output: text || `${bot.name} asked for a sub-agent.`, spawns, lines}; };
  if (!canBot(bot, SUBAGENT_PERMISSION)) return refuse(`it does not hold the ${SUBAGENT_PERMISSION} permission. Grant it in the bot profile to allow this.`);
  if (rounds >= MAX_SUBAGENT_DEPTH) return refuse('one sub-agent round is the limit for this task. It does the rest itself.');
  const item = found[0];
  if (!item.ok) return refuse(`the request was refused: ${item.error}`);
  const request = item.request;
  say(spawnStartedText(bot, request));
  const spawn = {name: request.name, task: request.task, output: null, error: null};
  try {
    spawn.output = cleanText(String(await executor(subagentBot(bot, request), subagentPrompt(bot, request), config) ?? ''), MAX_SUBAGENT_RESULT);
    if (!spawn.output) spawn.error = 'it returned nothing';
  } catch (error) { spawn.error = cleanText(error?.message, 300) || 'the model call failed'; }
  // The bot finishes either way: a failed helper must not lose the answer.
  const turn = subagentTurn(spawn);
  let second = String(await executor(bot, JSON.stringify({...envelope, ...turn, restrictions: [...(envelope.restrictions || []), ...turn.restrictions]}), config) ?? '');
  if (parseSpawnRequests(second).length) {
    second = stripSpawnBlocks(second);
    say(spawnRefusedText(bot, 'one sub-agent per reply is the limit.'));
  }
  say(spawnResultText(bot, spawn));
  spawns.push(spawn);
  return {output: second || text || `${bot.name} finished with a sub-agent.`, spawns, lines};
}
