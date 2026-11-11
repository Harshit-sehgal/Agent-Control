/** Bot and group settings: what a user may change about how a bot answers and
 * how a group routes work, with the defaults and limits for each.
 *
 * Pure and browser-safe. The Node server and the browser-local transport both
 * validate through here, so the two cannot accept different settings. Every
 * value is bounded: a setting can make a bot quieter, shorter, or switched
 * off, but never grant an action (that is `contracts.js` permissions) or lift
 * the hard step cap.
 */
import {cleanText} from './core.js?v=d3782feff1';
import {fail} from './errors.js?v=d3782feff1';
import {BACKSTOP} from './limits.js?v=d3782feff1';
import {TINT_COUNT} from './ui-kit.js?v=d3782feff1';
import {SHAPES} from './company.js?v=d3782feff1';

export const REPLY_LENGTHS = {short: 500, medium: 1500, long: 3000};
export const ROUTING_MODES = ['pipeline', 'mentions', 'everyone'];
/** direct: you @mention or the pipeline runs. tracked: the primary bot plans
 * the bots a request needs and checks the outcome. */
export const COORDINATION_MODES = ['direct', 'tracked'];
/** The hard ceiling on bot steps in one run, whatever a group sets: the backstop (shared/limits.js). A team, or the
 * owner's workspace limit in Settings → Limits, may set fewer; by default nothing does. */
export const MAX_STEPS_LIMIT = BACKSTOP.steps;
/** The most recent lines a bot may read, before the character budget cuts further.
 * Context is automatic: there is no per-bot setting for it. */
export const MAX_CONTEXT_MESSAGES = 30;
/** Settings that used to exist. A stored value is ignored on read and dropped on
 * the next save, and sending one is not an error, so an older client still works. */
const LEGACY_SETTINGS = ['contextMessages'];

export const BOT_DEFAULTS = Object.freeze({
  enabled: true,
  /** null leaves the provider's own default; some models refuse the field. */
  temperature: null,
  replyLength: 'medium',
  /** Extra tone guidance appended to the bot's job. */
  style: '',
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
  /** The manager's bot id, or null for Solo. The chart rules are in company.js. */
  reportsTo: null,
  /** One of company.js SHAPES, or null for the role default. */
  shape: null,
  /** Pinned to the top of the chat list, and its place in the saved order. */
  pinned: false,
  order: null,
});
export const BROWSER_APPROVALS = ['ask', 'auto'];

export const GROUP_DEFAULTS = Object.freeze({
  /** pipeline: no mention runs the pipeline. mentions: no mention asks the
   * first pipeline bot only. everyone: no mention asks every enabled bot. */
  routing: 'pipeline',
  /** Ordered bot ids; null means every bot in the group, in roster order. */
  pipeline: null,
  /** No limit of its own: the backstop. */
  maxSteps: BACKSTOP.steps,
  checkpoints: false,
  /** Bots in this group may hand off to each other by @mention. */
  botHandoffs: true,
  /** direct: you pick the bots. tracked: the primary bot keeps the task on track. */
  coordination: 'direct',
  /** When tracked, show the plan and wait. Otherwise it starts as you send. */
  confirmPlan: false,
});

const isObject = v => v && typeof v === 'object' && !Array.isArray(v);
const integer = (value, min, max, label) => {
  // `Number(true)` is 1 and `Number([3])` is 3, so a JSON body could smuggle a
  // boolean or an array through a settings field that means a count.
  const n = typeof value === 'boolean' || value === null || Array.isArray(value) ? NaN : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) fail(`${label} must be a whole number from ${min} to ${max}.`);
  return n;
};
const flag = (value, label) => {
  if (typeof value !== 'boolean') fail(`${label} must be true or false.`);
  return value;
};

/** The effective settings of a bot: its stored values over the defaults. */
export function botSettings(bot) {
  const settings = {...BOT_DEFAULTS, ...(isObject(bot?.settings) ? bot.settings : {})};
  for (const key of LEGACY_SETTINGS) delete settings[key];
  return settings;
}

/** Validate a partial settings change and merge it over `current`. Only keys
 * present in `body` change, so a form that saves one field drops no other. */
export function validateBotSettings(body, current = {}) {
  if (body === undefined || body === null) return {...BOT_DEFAULTS, ...current};
  if (!isObject(body)) fail('Bot settings must be an object.');
  const next = {...BOT_DEFAULTS, ...(isObject(current) ? current : {})};
  for (const key of Object.keys(body)) if (!Object.hasOwn(BOT_DEFAULTS, key) && !LEGACY_SETTINGS.includes(key)) fail(`Unknown bot setting "${String(key).slice(0, 40)}".`);
  for (const key of LEGACY_SETTINGS) delete next[key];
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
  if (body.memory !== undefined) next.memory = flag(body.memory, 'Memory');
  if (body.summonable !== undefined) next.summonable = flag(body.summonable, 'Summonable');
  if (body.canHandoff !== undefined) next.canHandoff = flag(body.canHandoff, 'Can hand off');
  if (body.lead !== undefined) next.lead = flag(body.lead, 'Primary bot');
  if (body.browserApproval !== undefined) {
    if (!BROWSER_APPROVALS.includes(body.browserApproval)) fail(`Browser approval must be one of: ${BROWSER_APPROVALS.join(', ')}.`);
    next.browserApproval = body.browserApproval;
  }
  if (body.reportsTo !== undefined) {
    if (body.reportsTo !== null && body.reportsTo !== '' && typeof body.reportsTo !== 'string') fail('A manager must be a bot id, or empty for Solo.');
    next.reportsTo = body.reportsTo ? cleanText(body.reportsTo, 80) : null;
  }
  if (body.shape !== undefined) {
    if (body.shape !== null && !SHAPES.includes(body.shape)) fail(`Shape must be one of: ${SHAPES.join(', ')}.`);
    next.shape = body.shape;
  }
  if (body.pinned !== undefined) next.pinned = flag(body.pinned, 'Pinned');
  if (body.order !== undefined) next.order = body.order === null ? null : integer(body.order, 0, 100000, 'Order');
  if (body.tint !== undefined) next.tint = body.tint === null ? null : integer(body.tint, 0, TINT_COUNT - 1, 'Colour');
  return next;
}

/** The output budget a bot's reply length allows. */
export const maxTokensFor = bot => REPLY_LENGTHS[botSettings(bot).replyLength] || REPLY_LENGTHS.medium;

/** The effective settings of a group: its stored values over the defaults. */
export function groupSettings(group) {
  const stored = isObject(group?.settings) ? group.settings : {};
  return {...GROUP_DEFAULTS, ...stored};
}

/** Validate a partial group settings change against the group's roster. */
export function validateGroupSettings(group, body, current = {}) {
  if (body === undefined || body === null) return {...GROUP_DEFAULTS, ...current};
  if (!isObject(body)) fail('Group settings must be an object.');
  const next = {...GROUP_DEFAULTS, ...(isObject(current) ? current : {})};
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

/** Drop pipeline entries for bots that left the group. Idempotent, and the
 * repair path only: it runs on a stored state that is already inconsistent, so
 * it cannot refuse anything. An empty pipeline reads as "every bot", which is
 * why `removeBot` refuses to strip a pipeline's last bot in the first place and
 * a person has to clear the pipeline to choose "every bot" deliberately. */
export function prunePipeline(group) {
  if (!isObject(group?.settings) || !Array.isArray(group.settings.pipeline)) return group;
  const ids = new Set((group.bots || []).map(b => b.id));
  const kept = group.settings.pipeline.filter(id => ids.has(id));
  group.settings.pipeline = kept.length ? kept : null;
  return group;
}

/** Recent conversation lines a bot may read, oldest first, with no setting to
 * tune: the newest that fit in `maxChars`. What was cut is the stored recap of the
 * conversation, which rides in the bot's memory block. Each line is labelled with
 * who said it; the caller marks the whole block as untrusted task data. */
export function threadContext(messages, maxChars = 3600) {
  if (!Array.isArray(messages)) return [];
  const lines = messages.filter(m => m && m.text && ['user', 'bot'].includes(m.role)).slice(-MAX_CONTEXT_MESSAGES)
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
