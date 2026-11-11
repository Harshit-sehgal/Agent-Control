/** Bots that create other bots.
 *
 * Any bot may add a bot to the company by putting a fenced block in its reply
 * (`bot.create` is part of the basic kit, so it needs no grant). The job is one
 * sentence; the name is optional and comes from the sentence when it is left out:
 *
 *     ```create-bot
 *     {"name": "Source scout", "job": "Find posts that mention the project and list their links."}
 *     ```
 *
 * The new bot is a normal, lasting record: it appears in the roster and the
 * chat list, keeps its own chat, and can be edited or removed by a person. It
 * reports to its creator when the creator leads a team, else to the creator's
 * manager. The creator cannot grant it a permission, a contract field, a model
 * or a different type. That is what stops a model from minting itself more
 * power; a person still grants any capability in the bot profile. The runaway
 * guard (`shared/runaway.js`) is what bounds how many a model can make.
 *
 * This module is pure. `src/bot-create.js` applies it inside the run.
 */
import {cleanText} from './core.js?v=09349b7571';
import {fail} from './errors.js?v=09349b7571';
import {defaultContract} from './contracts.js?v=09349b7571';
import {controlFence} from './reply-blocks.js?v=09349b7571';

export const BOT_CREATE_PERMISSION = 'bot.create';
export const MAX_NEW_BOTS_PER_REPLY = 1;
/** A hard safety cap on one group's bots, whoever creates them. The company has
 * no working limit of its own: the runaway guard paces what models create. */
export const MAX_BOTS_PER_GROUP = 500;
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

const WORDS = s => String(s ?? '').replace(/[^\p{L}\p{N}'’\s-]/gu, ' ').split(/\s+/).filter(Boolean);
const LEAD_IN = new Set('please can could you i want need would like make create build add hire set up me us a an the my our your new bot helper agent assistant that which who to for someone somebody'.split(' '));
const VERBS = new Set('watch watches find finds read reads write writes track tracks check checks draft drafts plan plans book books monitor monitors summarise summarize summarises summarizes look looks keep keeps help helps handle handles answer answers send sends collect collects review reviews research researches manage manages organise organize organises organizes take takes scan scans triage triages'.split(' '));
const STOP = new Set('and or that which who to for from on in of by with when whenever every each so then at'.split(' '));
const title = word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();

/** A bot's name from the sentence that is its job: the first noun phrase after
 * the opening verb ("Watches my inbox and drafts replies" is "Inbox"), else
 * "Helper N". `taken` is the names already in the company; a name that is taken
 * gets a number. */
export function nameFromSentence(sentence, taken = []) {
  const words = WORDS(sentence);
  const used = new Set(taken.map(n => String(n).trim().toLowerCase()));
  let i = 0;
  const skip = set => { while (i < words.length && set.has(words[i].toLowerCase())) i++; };
  skip(LEAD_IN);
  if (i < words.length && VERBS.has(words[i].toLowerCase())) i++;
  skip(LEAD_IN);
  const picked = [];
  while (i < words.length && picked.length < 2 && !STOP.has(words[i].toLowerCase())) picked.push(words[i++]);
  let name = picked.map(title).join(' ').slice(0, MAX_BOT_NAME);
  if (name.length < 2) {
    let n = 1;
    while (used.has(`helper ${n}`)) n++;
    return `Helper ${n}`;
  }
  const base = name;
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} ${n}`;
  return name;
}

/** The first colour index in `0..count-1` that no bot in `bots` is drawn in. A
 * bot with no colour of its own is drawn by its position. When every colour is
 * taken the new bot's own position picks one. */
export function firstUnusedTint(bots, count) {
  const used = new Set((bots || []).map((b, i) => (Number.isInteger(b?.settings?.tint) ? b.settings.tint : i) % count));
  for (let n = 0; n < count; n++) if (!used.has(n)) return n;
  return (bots || []).length % count;
}

export function validateCreateBotRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('A new-bot request must be an object.');
  const given = cleanText(body.name, MAX_BOT_NAME);
  const job = cleanText(body.job ?? body.instructions ?? body.task, MAX_BOT_JOB);
  if (job.length < MIN_BOT_JOB) fail(`A new bot needs a job of at least ${MIN_BOT_JOB} characters.`);
  // The name is optional: one sentence is enough to make a bot.
  const name = given || nameFromSentence(job);
  if (name.length < 2) fail('A new bot needs a name of at least 2 characters.');
  const replyLength = BOT_REPLY_LENGTHS.includes(body.replyLength) ? body.replyLength : 'medium';
  return {name, job, replyLength, style: cleanText(body.style, 300), ...(given ? {} : {derived: true})};
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
export function buildCreatedBot(request, {bot, runId = null, now = new Date().toISOString(), makeId = () => crypto.randomUUID(), reportsTo = null, tint = null} = {}) {
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
      reportsTo,
      ...(Number.isInteger(tint) ? {tint} : {}),
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

/** What every bot is told about the tool. */
export const BOT_CREATE_TOOL_HINT = 'You can add one new bot to the company when a task needs help that lasts beyond this reply. Put one block in your reply with its job in one sentence (the name is optional), like ```create-bot\n{"name":"Source scout","job":"Find posts that mention the project and list their links."}\n``` — write your own, do not copy this example. It reports to you if you lead a team, else to your manager. The new bot gets no permissions; a person reviews it. One bot per reply.';
