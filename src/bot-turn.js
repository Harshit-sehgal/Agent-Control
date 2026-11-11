/** One bot turn: the sequence every caller runs to turn a single model reply
 * into the bot's answer.
 *
 * A step is the same work whether the bot was handed a group handoff or a
 * person typed to it in a 1:1 chat: read the reply for a sub-agent block, run
 * the helper if the bot asked for one, then read it for a bot-to-bot ask and
 * let the teammate answer, then read it for a new-bot block. Those three reads
 * are ordered and each one hands the next the text the one before produced.
 *
 * This module owns that order. Before, the group loop and the 1:1 route each
 * wrote it out, and the copies had already drifted. A new capability in the
 * sequence now lands here, once, and both callers get it.
 *
 * What is *not* shared stays with the caller: how the envelope was built, the
 * per-call round budgets (a resumed group step has already spent some), who the
 * bot may ask, and what happens to the output afterwards — the group path runs
 * it through the contract gate and files browser requests; the 1:1 path stores
 * it as a chat run. A caller with no group passes `groupId: null`, and the
 * new-bot block is skipped because there is nowhere to put the bot.
 */
import {randomUUID} from 'node:crypto';
import {replyWithSubagents} from './subagents.js';
import {askPeerRound} from './bot-link.js';
import {createBotsFromReply} from './bot-create.js';

const stamp = () => new Date().toISOString();

/** Run one bot turn and return its output.
 *
 * `executor(bot, input, config)` is the model call the caller was given (the
 * real one, or a test's fake). `peers`, `configFor` and `memoryForPeer` are the
 * roster a bot may ask and how a teammate's own provider and recap are found.
 * `spawnRounds` is how many helper rounds this bot has already spent; it
 * defaults to 0, which is what a fresh attempt has. `groupId` is where a
 * bot-creating reply adds its bot, or `null` to skip that step.
 *
 * `budget` and `onEvent` are the run's ask tally and the way to record each ask
 * as it happens. When a checkpoint stops the asks, the result is
 * `{limit, frames, lines, spawns}` and nothing after the ask round runs; pass
 * `resume: {frames, spawns}` back in to carry on from there.
 */
export async function runBotTurn(store, {
  bot, envelope, executor, config,
  peers = [], configFor = () => null, memoryForPeer = null, handoffAllowed = true,
  spawnRounds = 0, groupId = null, runId = null, budget = null, resume = null, stop = false, onEvent = null,
  makeId = randomUUID, now = stamp,
}) {
  const sub = resume ? {output: null, lines: [], spawns: resume.spawns || []}
    : await replyWithSubagents({bot, envelope, executor, config, rounds: spawnRounds, makeId, now});
  const peer = await askPeerRound({bot, envelope, first: sub.output, executor, config, peers, configFor, memoryForPeer, handoffAllowed, budget, resume, stop, onEvent, makeId, now});
  if (peer.limit) return {limit: peer.limit, frames: peer.frames, lines: [...sub.lines, ...peer.lines], spawns: sub.spawns, asks: peer.asks, created: []};
  const made = groupId
    ? await createBotsFromReply(store, {bot, groupId, output: peer.output, runId, makeId, now})
    : {text: peer.output, created: [], lines: []};
  return {
    output: made.text,
    lines: [...sub.lines, ...peer.lines, ...made.lines],
    spawns: sub.spawns,
    asks: peer.asks,
    created: made.created,
  };
}
