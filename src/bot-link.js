/** One bot-to-bot ask round for a reply.
 *
 * The bot's first reply is read for an ```ask block. When it holds the
 * permission and still has a round left, the named teammate answers as itself
 * (its own job, model, tone and rulebook), and the bot that asked gets one more
 * turn with the answer in its envelope. The teammate's reply is never parsed
 * for another ask or any tool block, which keeps the exchange one round deep.
 */
import {randomUUID} from 'node:crypto';
import {canBot} from '../shared/contracts.js';
import {botSettings} from '../shared/bot-settings.js';
import {memoryBlock} from '../shared/memory.js';
import {
  BOT_ASK_PERMISSION, MAX_ASK_DEPTH, MAX_PEER_ANSWER,
  parseAskRequests, stripAskBlocks, stripControlBlocks, findPeer,
  peerAskInstructions, peerAskInput, peerAnswerTurn, askStartedText, askResultText, askRefusedText,
} from '../shared/bot-link.js';
import {cleanText} from '../shared/core.js';

const stamp = () => new Date().toISOString();

/** The round, starting from a reply the orchestrator already has. This is
 * what a step uses after the sub-agent round, so the model is not called twice. */
export async function askPeerRound({bot, envelope = {}, first, executor, config, peers = [], configFor = () => null, memoryForPeer = null, handoffAllowed = true, rounds = 0, makeId = randomUUID, now = stamp}) {
  const found = parseAskRequests(first);
  const text = stripAskBlocks(first);
  const lines = [], asks = [];
  if (!found.length) return {output: first, asks, lines};
  const say = value => lines.push({id: makeId(), role: 'system', kind: 'peer', text: value, at: now()});
  // A refused ask must not cost the bot the answer it was writing. When the
  // block was the whole reply there is nothing left to send, so it gets one
  // more turn, told why the ask did not run. Bounded: one extra call per step.
  const finishWithout = async reason => {
    try {
      const retry = String(await executor(bot, JSON.stringify({
        ...envelope,
        restrictions: [...(envelope.restrictions || []), `Your ask was not run: ${reason}`, 'Write your final reply now, in plain text, without any block.'],
      }), config) ?? '');
      return stripControlBlocks(stripAskBlocks(retry));
    } catch {
      return '';
    }
  };
  const refuse = async reason => {
    say(askRefusedText(bot, reason));
    const output = text || await finishWithout(reason);
    return {output: output || `${bot.name} tried to message another bot.`, asks, lines};
  };
  if (!canBot(bot, BOT_ASK_PERMISSION)) return refuse(`it does not hold the ${BOT_ASK_PERMISSION} permission. Grant it in the bot profile to allow this.`);
  if (rounds >= MAX_ASK_DEPTH) return refuse('one bot-to-bot exchange is the limit for this task. It writes the rest itself.');
  if (handoffAllowed === false) return refuse('bot-to-bot messages are switched off for this group. Turn on "Bots may hand off" in the group settings.');
  const item = found[0];
  if (!item.ok) return refuse(`the request was refused: ${item.error}`);
  const request = item.request;
  const peer = findPeer((peers || []).filter(candidate => candidate && candidate.id !== bot.id), request.to);
  if (!peer) return refuse(`there is no teammate named "${cleanText(request.to, 80)}" in reach. Check the name or add that bot to the group.`);
  if (!botSettings(peer).enabled) return refuse(`${peer.name} is switched off. Turn it on in its profile to let it answer.`);
  say(askStartedText(bot, {...request, to: peer.name}));
  const answer = {name: peer.name, task: request.task, output: null, error: null};
  try {
    const peerConfig = configFor(peer.id) || config;
    const peerMemory = memoryForPeer ? memoryForPeer(peer, peerConfig) : null;
    const peerNotes = peerMemory ? memoryBlock(peerMemory) || null : null;
    // The teammate answers as itself, with its own job and tone, but holds no
    // capability: a peer call is an answer, never a second run with tools.
    const asPeer = {...peer, permissions: [], instructions: peerAskInstructions(peer, bot, peerNotes)};
    answer.output = cleanText(stripControlBlocks(String(await executor(asPeer, peerAskInput(bot, request, peerNotes), peerConfig) ?? '')), MAX_PEER_ANSWER);
    if (!answer.output) answer.error = 'it returned nothing';
  } catch (error) {
    answer.error = cleanText(error?.message, 300) || 'the model call failed';
  }
  const turn = peerAnswerTurn(answer);
  let second = text;
  try {
    const reply = String(await executor(bot, JSON.stringify({...envelope, ...turn, restrictions: [...(envelope.restrictions || []), ...turn.restrictions]}), config) ?? '');
    // Only a second ask is removed here. The answer is untrusted, so it cannot
    // carry a control block in (it was stripped when it came back), but this
    // turn is the bot's own reply: a page, helper or new-bot request in it is
    // the bot's to make and the orchestrator reads it downstream.
    second = reply;
    if (parseAskRequests(reply).length) {
      second = stripAskBlocks(reply);
      say(askRefusedText(bot, 'one bot-to-bot exchange per reply is the limit.'));
    }
  } catch (error) {
    // The teammate's answer was already paid for; keep the bot's first reply
    // rather than losing the whole step to a second provider error.
    say(`${bot.name} could not use ${peer.name}'s answer: ${cleanText(error?.message, 300)}`);
  }
  say(askResultText(peer, answer, bot));
  // Recorded either way for the trace; only an answer counts as the round used.
  asks.push(answer);
  return {output: second || text || `${bot.name} asked ${peer.name}.`, asks, lines};
}
