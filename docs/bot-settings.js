/** Bot and group settings: what a user may change about how a bot answers and
 * how a group routes work, with the defaults and limits for each.
 *
 * Pure and browser-safe. The Node server and the browser-local transport both
 * validate through here, so the two cannot accept different settings. Every
 * value is bounded: a setting can make a bot quieter, shorter, or switched
 * off, but never grant an action (that is `contracts.js` permissions) or lift
 * the hard step cap.
 */
import {cleanText} from './core.js?v=c011d81ee9';
import {TINT_COUNT} from './ui-kit.js?v=c011d81ee9';

export const REPLY_LENGTHS = {short: 500, medium: 1500, long: 3000};
export const ROUTING_MODES = ['pipeline', 'mentions', 'everyone'];
/** direct: you @mention or the pipeline runs. tracked: the primary bot plans
 * the bots a request needs and checks the outcome. */
export const COORDINATION_MODES = ['direct', 'tracked'];
/** The hard ceiling on bot steps in one run, whatever a group sets. */
export const MAX_STEPS_LIMIT = 12;
export const MAX_CONTEXT_MESSAGES = 30;
export const X_ENGAGE_PIPELINE = ['scout', 'ranker', 'researcher', 'writer', 'reviewer'];

export const BOT_DEFAULTS = Object.freeze({
  enabled: true,
  /** null leaves the provider's own default; some models refuse the field. */
  temperature: null,
  replyLength: 'medium',
  /** Extra tone guidance appended to the bot's job. */
  style: '',
  /** How many recent messages of the conversation the bot sees. */
  contextMessages: 10,
  /** Keep durable memory for this bot's model: a per-model rulebook and a
   * rolling recap of the conversation, both stored in the workspace. */
  memory: true,
  /** May be @mentioned from a chat outside its own group. */
  summonable: true,
  /** May pass work on by @mentioning another bot in its reply. */
  canHandoff: true,
  /** The one bot you instruct. A plain message to it switches the others on
   * and runs the group. @mentions still pick their own targets. */
  lead: false,
  /** Avatar colour index; null picks one from the bot's position. */
  tint: null,
  /** ask: each browser request waits for a person. auto: it goes to the local
   * agent at once, still inside that device's allowlist and permissions. */
  browserApproval: 'ask',
});
export const BROWSER_APPROVALS = ['ask', 'auto'];

export const GROUP_DEFAULTS = Object.freeze({
  /** pipeline: no mention runs the pipeline. mentions: no mention asks the
   * first pipeline bot only. everyone: no mention asks every enabled bot. */
  routing: 'pipeline',
  /** Ordered bot ids; null means every bot in the group, in roster order. */
  pipeline: null,
  maxSteps: 6,
  checkpoints: false,
  /** Bots in this group may hand off to each other by @mention. */
  botHandoffs: true,
  /** direct: you pick the bots. tracked: the primary bot keeps the task on track. */
  coordination: 'direct',
  /** When tracked, show the plan and wait. Otherwise it starts as you send. */
  confirmPlan: false,
});

function fail(message, status = 400) {
  throw Object.assign(new Error(message), {status});
}
const isObject = v => v && typeof v === 'object' && !Array.isArray(v);
const integer = (value, min, max, label) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) fail(`${label} must be a whole number from ${min} to ${max}.`);
  return n;
};
const flag = (value, label) => {
  if (typeof value !== 'boolean') fail(`${label} must be true or false.`);
  return value;
};

/** The effective settings of a bot: its stored values over the defaults. */
export function botSettings(bot) {
  return {...BOT_DEFAULTS, ...(isObject(bot?.settings) ? bot.settings : {})};
}

/** Validate a partial settings change and merge it over `current`. Only keys
 * present in `body` change, so a form that saves one field drops no other. */
export function validateBotSettings(body, current = {}) {
  if (body === undefined || body === null) return {...BOT_DEFAULTS, ...current};
  if (!isObject(body)) fail('Bot settings must be an object.');
  const next = {...BOT_DEFAULTS, ...(isObject(current) ? current : {})};
  for (const key of Object.keys(body)) if (!Object.hasOwn(BOT_DEFAULTS, key)) fail(`Unknown bot setting "${String(key).slice(0, 40)}".`);
  if (body.enabled !== undefined) next.enabled = flag(body.enabled, 'Enabled');
  if (body.temperature !== undefined) {
    if (body.temperature === null || body.temperature === '') next.temperature = null;
    else {
      const t = Number(body.temperature);
      if (!Number.isFinite(t) || t < 0 || t > 2) fail('Temperature must be between 0 and 2, or empty for the provider default.');
      next.temperature = Math.round(t * 100) / 100;
    }
  }
  if (body.replyLength !== undefined) {
    if (!Object.hasOwn(REPLY_LENGTHS, body.replyLength)) fail(`Reply length must be one of: ${Object.keys(REPLY_LENGTHS).join(', ')}.`);
    next.replyLength = body.replyLength;
  }
  if (body.style !== undefined) {
    if (typeof body.style !== 'string') fail('Style must be text.');
    next.style = cleanText(body.style, 600);
  }
  if (body.contextMessages !== undefined) next.contextMessages = integer(body.contextMessages, 0, MAX_CONTEXT_MESSAGES, 'Context messages');
  if (body.memory !== undefined) next.memory = flag(body.memory, 'Memory');
  if (body.summonable !== undefined) next.summonable = flag(body.summonable, 'Summonable');
  if (body.canHandoff !== undefined) next.canHandoff = flag(body.canHandoff, 'Can hand off');
  if (body.lead !== undefined) next.lead = flag(body.lead, 'Primary bot');
  if (body.browserApproval !== undefined) {
    if (!BROWSER_APPROVALS.includes(body.browserApproval)) fail(`Browser approval must be one of: ${BROWSER_APPROVALS.join(', ')}.`);
    next.browserApproval = body.browserApproval;
  }
  if (body.tint !== undefined) next.tint = body.tint === null ? null : integer(body.tint, 0, TINT_COUNT - 1, 'Colour');
  return next;
}

/** The output budget a bot's reply length allows. */
export const maxTokensFor = bot => REPLY_LENGTHS[botSettings(bot).replyLength] || REPLY_LENGTHS.medium;

/** The effective settings of a group, with the X-engage default pipeline. */
export function groupSettings(group) {
  const stored = isObject(group?.settings) ? group.settings : {};
  const merged = {...GROUP_DEFAULTS, ...stored};
  if (stored.pipeline === undefined && group?.id === 'x-engage') merged.pipeline = [...X_ENGAGE_PIPELINE];
  // X-engage is the group this product is for: one bot keeps it on track
  // until the user switches the setting to direct.
  if (stored.coordination === undefined && group?.id === 'x-engage') merged.coordination = 'tracked';
  return merged;
}

/** Validate a partial group settings change against the group's roster. */
export function validateGroupSettings(group, body, current = {}) {
  if (body === undefined || body === null) return {...GROUP_DEFAULTS, ...current};
  if (!isObject(body)) fail('Group settings must be an object.');
  const next = {...GROUP_DEFAULTS, ...(isObject(current) ? current : {})};
  // X-engage stays tracked until someone chooses otherwise. A partial save
  // must not write the direct default over that implicit choice.
  if (group?.id === 'x-engage' && !(isObject(current) && current.coordination !== undefined) && body.coordination === undefined) next.coordination = 'tracked';
  // Same for the pipeline: GROUP_DEFAULTS.pipeline is null ("every bot").
  // Writing that on a partial save would put Handoff in the X-engage line.
  if (group?.id === 'x-engage' && !(isObject(current) && current.pipeline !== undefined) && body.pipeline === undefined) delete next.pipeline;
  for (const key of Object.keys(body)) if (!Object.hasOwn(GROUP_DEFAULTS, key)) fail(`Unknown group setting "${String(key).slice(0, 40)}".`);
  if (body.routing !== undefined) {
    if (!ROUTING_MODES.includes(body.routing)) fail(`Routing must be one of: ${ROUTING_MODES.join(', ')}.`);
    next.routing = body.routing;
  }
  if (body.pipeline !== undefined) {
    if (body.pipeline === null) next.pipeline = null;
    else {
      if (!Array.isArray(body.pipeline)) fail('Pipeline must be a list of bot ids.');
      const ids = (group?.bots || []).map(b => b.id), order = [];
      for (const id of body.pipeline) {
        if (!ids.includes(id)) fail(`The pipeline names a bot that is not in this group: "${String(id).slice(0, 40)}".`);
        if (!order.includes(id)) order.push(id);
      }
      if (!order.length) fail('A pipeline needs at least one bot. Clear it to use every bot.');
      next.pipeline = order;
    }
  }
  if (body.maxSteps !== undefined) next.maxSteps = integer(body.maxSteps, 1, MAX_STEPS_LIMIT, 'Step limit');
  if (body.checkpoints !== undefined) next.checkpoints = flag(body.checkpoints, 'Approve between steps');
  if (body.botHandoffs !== undefined) next.botHandoffs = flag(body.botHandoffs, 'Bot handoffs');
  if (body.coordination !== undefined) {
    if (!COORDINATION_MODES.includes(body.coordination)) fail(`Coordination must be one of: ${COORDINATION_MODES.join(', ')}.`);
    next.coordination = body.coordination;
  }
  if (body.confirmPlan !== undefined) next.confirmPlan = flag(body.confirmPlan, 'Show the plan first');
  return next;
}

/** The ordered, enabled bot ids a group's pipeline runs, before the step cap. */
export function pipelineOf(group) {
  const settings = groupSettings(group), bots = group?.bots || [];
  const on = id => bots.some(b => b.id === id && botSettings(b).enabled);
  const order = Array.isArray(settings.pipeline) ? settings.pipeline : bots.map(b => b.id);
  return order.filter(on);
}

/** Drop pipeline entries for bots that left the group. Idempotent. */
export function prunePipeline(group) {
  if (!isObject(group?.settings) || !Array.isArray(group.settings.pipeline)) return group;
  const ids = new Set((group.bots || []).map(b => b.id));
  const kept = group.settings.pipeline.filter(id => ids.has(id));
  group.settings.pipeline = kept.length ? kept : null;
  return group;
}

/** Recent conversation lines a bot may read, oldest first, bounded in count
 * and size. Each line is labelled with who said it; the caller marks the whole
 * block as untrusted task data. */
export function threadContext(messages, count, maxChars = 3600) {
  const n = Math.max(0, Math.min(MAX_CONTEXT_MESSAGES, Number(count) || 0));
  if (!n || !Array.isArray(messages)) return [];
  const lines = messages.filter(m => m && m.text && ['user', 'bot'].includes(m.role)).slice(-n)
    .map(m => ({from: m.role === 'user' ? 'user' : (m.senderName || m.senderId || 'bot'), text: String(m.text).slice(0, 800)}));
  let total = 0;
  const kept = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    total += lines[i].text.length;
    if (total > maxChars) break;
    kept.unshift(lines[i]);
  }
  return kept;
}
