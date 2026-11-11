/** Bot-to-bot asks for a reply.
 *
 * The bot's reply is read for an ```ask block. Any bot may ask any bot: the
 * asked bot answers as itself (its own job, model, tone and rulebook), may ask
 * a bot of its own, and the bot that asked gets another turn with the answer in
 * its envelope. That repeats until a reply holds no ask.
 *
 * The conversation is a stack of frames, one per bot waiting on an answer, so a
 * checkpoint can stop it anywhere and a later call can pick it up from the
 * stored frames (`resume`). Every ask is counted against the run's budget
 * (`shared/ask-limits.js`); when a limit is reached the call returns `limit`
 * and the frames instead of an output. The asked bot's reply is never parsed
 * for tools other than another ask, and nothing it writes reaches its own chat.
 */
import {randomUUID} from 'node:crypto';
import {botSettings} from '../shared/bot-settings.js';
import {memoryBlock} from '../shared/memory.js';
import {
  MAX_PEER_ANSWER,
  parseAskRequests, stripAskBlocks, stripControlBlocks, findPeer,
  peerAskInstructions, peerAskEnvelope, peerAnswerTurn, companyList, askStartedText, askResultText, askRefusedText,
} from '../shared/bot-link.js';
import {tallyAsk, recordAnswer} from '../shared/ask-limits.js';
import {cleanText} from '../shared/core.js';

const stamp = () => new Date().toISOString();

/** The round, starting from a reply the orchestrator already has. This is
 * what a step uses after the sub-agent round, so the model is not called twice.
 *
 * `budget` is the run's ask tally (`{asks, limitBase, unlimitedAsks}`, mutated
 * here); with one, a reached limit comes back as `{limit, frames}` for the
 * caller to pause on, and without one it is refused like any other ask.
 * `onEvent({type:'ask'|'answer', ...})` lets the caller record each message as
 * it happens. `stop` with `resume` ends it: the asking bot reports what it has. */
export async function askPeerRound({bot, envelope = {}, first, executor, config, peers = [], configFor = () => null, memoryForPeer = null, handoffAllowed = true, budget = null, resume = null, stop = false, onEvent = null, makeId = randomUUID, now = stamp}) {
  const lines = [], asks = [];
  const roster = (peers || []).filter(Boolean);
  const tally = budget || {};
  const botOf = id => (id === bot.id ? bot : roster.find(p => p.id === id));
  const say = value => lines.push({id: makeId(), role: 'system', kind: 'peer', text: value, at: now()});
  const frames = resume ? resume.frames.map(f => ({...f, answers: [...(f.answers || [])]}))
    : [{botId: bot.id, envelope, reply: String(first ?? ''), answers: []}];
  if (!resume && !parseAskRequests(first).length) return {output: first, asks, lines};
  let lastPeer = null;

  /** One model call for a frame: the first turn's envelope plus whatever it was
   * answered so far. A peer runs as itself with no capability: an answer, never
   * a second run with tools. */
  const call = async (frame, extra = []) => {
    const me = botOf(frame.botId);
    const turn = frame.answers.length ? peerAnswerTurn(frame.answers.at(-1), frame.answers.slice(0, -1)) : null;
    const restrictions = [...(frame.envelope.restrictions || []), ...(turn?.restrictions || []), ...extra];
    const env = {...frame.envelope, ...(turn || {}), ...(restrictions.length ? {restrictions} : {})};
    const asPeer = frame.peer ? {...me, permissions: [], instructions: frame.instructions} : me;
    return String(await executor(asPeer, JSON.stringify(env), frame.peer ? (configFor(me.id) || config) : config) ?? '');
  };

  // Stop: the bot that asked reports what it has, with no further ask.
  if (stop && resume) {
    const root = frames[0];
    let report = '';
    try { report = stripAskBlocks(await call(root, ['Stop here and report what you have.', 'Do not ask another bot.'])); } catch { /* Fall back to what it had written. */ }
    return {output: report.trim() || stripAskBlocks(root.reply).trim() || `${bot.name} stopped asking other bots.`, asks, lines};
  }

  while (true) {
    const top = frames.at(-1), me = botOf(top.botId);
    if (!me) throw new Error('Bot or group was removed during execution.');
    const found = parseAskRequests(top.reply);
    let peer = null, request = null, reason = null;
    if (found.length) {
      const item = found[0];
      if (handoffAllowed === false) reason = 'bot-to-bot messages are switched off for this group. Turn on "Bots may hand off" in the group settings.';
      else if (!item.ok) reason = `the request was refused: ${item.error}`;
      else {
        request = item.request;
        const named = findPeer(roster.filter(p => p.id !== me.id), request.to);
        if (!named) reason = `there is no bot named "${cleanText(request.to, 80)}" in the company. Check the name.`;
        else if (frames.some(f => f.botId === named.id)) reason = `${named.name} is already waiting on this answer, so it cannot be asked now.`;
        else if (!botSettings(named).enabled) reason = `${named.name} is switched off. Turn it on in its profile to let it answer.`;
        else {
          const verdict = tallyAsk(tally, {from: me.id, to: named.id, task: request.task, depth: frames.length + 1});
          if (verdict.ok) peer = named;
          else if (budget) return {output: null, limit: {kind: verdict.limit}, frames, lines, asks};
          else reason = 'the limit on bot-to-bot messages for this task is reached.';
        }
      }
    }
    if (peer) {
      lastPeer = peer;
      say(askStartedText(me, {...request, to: peer.name}));
      await onEvent?.({type: 'ask', from: me.id, to: peer.id, task: request.task, budget: tally});
      const frame = {botId: peer.id, peer: true, askerId: me.id, task: request.task, reply: '', answers: []};
      try {
        const peerConfig = configFor(peer.id) || config;
        const peerMemory = memoryForPeer ? memoryForPeer(peer, peerConfig) : null;
        const notes = peerMemory ? memoryBlock(peerMemory) || null : null;
        frame.instructions = peerAskInstructions(peer, me, notes);
        frame.envelope = peerAskEnvelope(me, request, notes, handoffAllowed === false ? [] : companyList(roster, peer.id));
        frames.push(frame);
        frame.reply = await call(frame);
      } catch (error) {
        if (!frames.includes(frame)) frames.push(frame);
        frame.error = cleanText(error?.message, 300) || 'the model call failed';
      }
      continue;
    }

    // `top` has no ask left to run: it is finished, or its ask was refused.
    let text = found.length ? stripAskBlocks(top.reply) : top.reply;
    if (found.length) {
      say(askRefusedText(me, reason));
      // A refused ask must not cost the bot the answer it was writing. When the
      // block was the whole reply it gets one more turn, told why. Bounded.
      if (!text.trim() && !top.error) {
        try { text = stripControlBlocks(stripAskBlocks(await call(top, [`Your ask was not run: ${reason}`, 'Write your final reply now, in plain text, without any block.']))); } catch { text = ''; }
      }
    }
    if (frames.length === 1) return {output: text || (lastPeer && asks.length ? `${bot.name} asked ${lastPeer.name}.` : `${bot.name} tried to message another bot.`), asks, lines};

    frames.pop();
    const parent = frames.at(-1), parentBot = botOf(parent.botId);
    const output = cleanText(stripControlBlocks(text), MAX_PEER_ANSWER);
    const answer = {name: me.name, task: top.task, output: output || null, error: top.error || (output ? null : 'it returned nothing'), botId: parent.botId, peerId: me.id};
    recordAnswer(tally, {from: parent.botId, to: me.id, task: top.task}, answer.output);
    await onEvent?.({type: 'answer', from: me.id, to: parent.botId, output: answer.output, error: answer.error, budget: tally});
    asks.push(answer);
    say(askResultText(me, answer, parentBot));
    parent.answers.push(answer);
    try { parent.reply = await call(parent); }
    catch (error) {
      // The answer was already paid for; keep what the bot had written rather
      // than losing the whole step to a second provider error.
      say(`${parentBot.name} could not use ${me.name}'s answer: ${cleanText(error?.message, 300)}`);
      parent.reply = stripAskBlocks(parent.reply);
    }
  }
}
