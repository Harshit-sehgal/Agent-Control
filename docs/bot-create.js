/** Bots that create other bots.
 *
 * A bot holding the `bot.create` permission may add one teammate to its own
 * group by putting a fenced block in its reply:
 *
 *     ```create-bot
 *     {"name": "Source scout", "job": "Find posts that mention the project and list their links."}
 *     ```
 *
 * The new bot is a normal, lasting record: it appears in the roster and the
 * chat list, keeps its own chat, and can be edited or removed by a person.
 * The creator cannot grant it a permission, a contract field, a model or a
 * different type. That is what stops a model from minting itself more power;
 * a person still grants any capability in the bot profile.
 *
 * This module is pure. `src/bot-create.js` applies it inside the run.
 */
import {cleanText} from './core.js?v=71dfceda40';
import {fail} from './errors.js?v=71dfceda40';
import {defaultContract} from './contracts.js?v=71dfceda40';
import {controlFence} from './reply-blocks.js?v=71dfceda40';

export const BOT_CREATE_PERMISSION = 'bot.create';
export const MAX_NEW_BOTS_PER_REPLY = 1;
/** A group that reaches this size refuses new bots, created by a person or a model. */
export const MAX_BOTS_PER_GROUP = 40;
export const MAX_BOT_NAME = 60;
export const MAX_BOT_JOB = 3000;
export const MIN_BOT_JOB = 20;
export const BOT_REPLY_LENGTHS = ['short', 'medium', 'long'];
// One fence grammar shared with every other control block (see
// shared/reply-blocks.js): the reply is read and stripped with the same rule as
// the ask, spawn and browser blocks, so an unclosed final fence behaves the same
// for all of them instead of surviving here as visible control text.
const BLOCK = () => controlFence('create-bot');
const MAX_BLOCKS_READ = 5;

export function validateCreateBotRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('A new-bot request must be an object.');
  const name = cleanText(body.name, MAX_BOT_NAME);
  const job = cleanText(body.job ?? body.instructions ?? body.task, MAX_BOT_JOB);
  if (name.length < 2) fail('A new bot needs a name of at least 2 characters.');
  if (job.length < MIN_BOT_JOB) fail(`A new bot needs a job of at least ${MIN_BOT_JOB} characters.`);
  const replyLength = BOT_REPLY_LENGTHS.includes(body.replyLength) ? body.replyLength : 'medium';
  return {name, job, replyLength, style: cleanText(body.style, 300)};
}

export function parseCreateBotRequests(output) {
  const found = [];
  for (const match of String(output ?? '').matchAll(BLOCK())) {
    if (found.length >= MAX_BLOCKS_READ) break;
    // Past the first block the reply is over its limit. Reported, not dropped:
    // a silent second request looks like the bot simply ignored the ask.
    if (found.length >= MAX_NEW_BOTS_PER_REPLY) {
      found.push({ok: false, error: `only ${MAX_NEW_BOTS_PER_REPLY} new bot per reply is allowed.`});
      continue;
    }
    try {
      let body;
      try { body = JSON.parse(match[1].trim()); } catch { fail('The new-bot block is not valid JSON.'); }
      found.push({ok: true, request: validateCreateBotRequest(body)});
    } catch (error) { found.push({ok: false, error: error.message}); }
  }
  return found;
}

export const stripCreateBotBlocks = output => String(output ?? '').replace(BLOCK(), '').replace(/\n{3,}/g, '\n\n').trim();

/** The lasting bot record the block becomes. No permissions, always custom:
 * the model cannot widen what the new bot may do. */
export function buildCreatedBot(request, {bot, runId = null, now = new Date().toISOString(), makeId = () => crypto.randomUUID()} = {}) {
  if (!request || !request.name || !request.job) fail('A new bot needs a name and a job.');
  return {
    id: cleanText(makeId(), 64),
    name: request.name,
    instructions: request.job,
    type: 'custom',
    contract: defaultContract(),
    permissions: [],
    settings: {
      enabled: true,
      replyLength: BOT_REPLY_LENGTHS.includes(request.replyLength) ? request.replyLength : 'medium',
      ...(request.style ? {style: cleanText(request.style, 300)} : {}),
    },
    origin: 'bot',
    createdBy: {
      botId: bot?.id || null,
      botName: bot?.name || null,
      runId: runId || null,
      at: now,
    },
    createdAt: now,
  };
}

export const botCreatedText = (creator, created, groupName) => `${creator?.name || 'A bot'} created a new bot for this work: ${created.name} in ${groupName || 'this group'}. It has no permissions; review its job in its profile and grant anything it needs.`;
export const botCreateRefusedText = (bot, reason) => `${bot?.name || 'The bot'} tried to create a new bot, but ${reason}`;

/** What a bot is told about the tool when it holds the permission. */
export const BOT_CREATE_TOOL_HINT = 'You can add one new bot to your own group when a task needs help that lasts beyond this reply. Put one block in your reply with the name and the job filled in, like ```create-bot\n{"name":"Source scout","job":"Find posts that mention the project and list their links."}\n``` — write your own name and job, do not copy this example. The new bot gets no permissions; a person reviews it. One bot per reply.';
