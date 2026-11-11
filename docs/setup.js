/** The bot knows the app and sets it up; the owner only taps.
 *
 * Two halves:
 *
 * - `workspaceBrief(state, {agents, connectors})` is what every bot is told about this workspace:
 *   its models, its bots and which model each uses, whether this computer is connected (browser, claude
 *   and codex sign-in), the connected services, and a few facts about how the app works. So the owner
 *   can ask Atlas "why did that fail?" or "use Haiku for Replier" instead of learning the settings.
 *
 * - The ```setup block. Any bot may put one in its reply to propose a change:
 *
 *       ```setup
 *       {"action": "model", "bot": "Replier", "provider": "My Claude", "model": "haiku"}
 *       ```
 *
 *   `model` (a bot's model, or the default when `bot` is left out), `job` (a bot's job sentence), `rename`,
 *   `settings` (reply length, style, memory, hand-offs, @mentions, on or off, temperature, manager), `team`
 *   (a team's "Approve between steps", step limit and hand-offs between its bots), `rule`
 *   (Always allow / Ask each time / Deny for a bot, an action and a site; a payment is never Always), or
 *   `open` (a Settings page: models, connectors, permissions, agents, usage). The block never changes
 *   anything: it becomes a card in the chat with one button, and the owner's tap calls the same route
 *   the settings page calls, with the owner's own session. A model cannot add a key, type a command,
 *   make itself the primary bot, save a rule without the owner's tap, or reach a route the owner could not.
 *
 * Pure and browser-safe: the server reads replies with it and the UI paints the card from it. */
import {cleanText} from './core.js?v=25bfe97b8d';
import {cleanEffort, CLI_MODELS} from './ai-presets.js?v=25bfe97b8d';
import {everyMinutes, cleanAt, cleanDay, whenWords, scheduleRows, MIN_EVERY, MAX_EVERY} from './schedules.js?v=25bfe97b8d';
import {controlFence} from './reply-blocks.js?v=25bfe97b8d';
import {companyBots, primaryOf} from './company.js?v=25bfe97b8d';
import {GRANT_LABELS, GRANT_CHOICES, ASK_ACTIONS, askText, pendingAsks, scopeOf, grantChoices} from './asks.js?v=25bfe97b8d';
import {botSettings, validateBotSettings, groupSettings, validateGroupSettings, BOT_DEFAULTS, GROUP_DEFAULTS} from './bot-settings.js?v=25bfe97b8d';
import {grantWhat} from './ui-asks.js?v=25bfe97b8d';

export const SETUP_ACTIONS = ['model', 'job', 'rename', 'settings', 'team', 'rule', 'schedule', 'remove', 'open'];
/** The bot settings a bot may propose. Not the primary role, the browser approval mode, or layout (pins, order). */
export const BOT_SETTABLE = ['replyLength', 'style', 'memory', 'canHandoff', 'summonable', 'enabled', 'temperature', 'reportsTo'];
/** The team (group) settings a bot may propose: approve between steps, the step limit, hand-offs between its bots. */
export const TEAM_SETTABLE = ['checkpoints', 'maxSteps', 'botHandoffs'];
const RULE_WORDS = {open: 'browser.use', browse: 'browser.use', browser: 'browser.use', 'browser.use': 'browser.use', web: 'browser.use', send: 'send', email: 'send', post: 'post', delete: 'delete', spend: 'spend', pay: 'spend', payment: 'spend', buy: 'spend'};
const PER_SITE = ['browser.use', 'send', 'post', 'delete'];
/** Settings pages a bot may point to, by the word it uses, and the section key and title the app uses. */
export const SETUP_PAGES = {
  models: ['models', 'Models and keys'], keys: ['models', 'Models and keys'],
  connectors: ['conn', 'Connectors'], gmail: ['conn', 'Connectors'], drive: ['conn', 'Connectors'], google: ['conn', 'Connectors'], mcp: ['conn', 'Connectors'],
  permissions: ['perm', 'Permissions'], agents: ['agents', 'Local agents'], computer: ['agents', 'Local agents'],
  usage: ['usage', 'Usage'], appearance: ['look', 'Appearance'], general: ['general', 'General'],
};
const GOOGLE_PAGES = ['gmail', 'drive', 'google'];
const MIN_JOB = 20, MAX_JOB = 3000, MAX_BLOCKS = 3;

export const SETUP_TOOL_HINT = 'To change a setting for the owner, put one fenced block named setup in your reply, holding JSON. '
  + '{"action":"model","bot":"<bot name, or leave out for everyone\'s default>","provider":"<a model name from workspace.models>","model":"<one of its models, or leave out for its default>","effort":"<low|medium|high|default, optional>"} sets a model and how hard it thinks (effort alone, with no provider, changes only the effort: high for hard or careful work, low for quick replies). '
  + '{"action":"job","bot":"<bot name>","job":"<the new job, one or two sentences>"} rewrites a bot\'s job. '
  + '{"action":"rename","bot":"<bot name>","name":"<new name>"} renames a bot. '
  + '{"action":"settings","bot":"<bot name>","settings":{"replyLength":"short|medium|long","style":"<tone>","memory":true|false,"canHandoff":true|false,"summonable":true|false,"enabled":true|false,"temperature":0-2,"reportsTo":"<manager bot name, or none>"}} changes how a bot works; give only what changes. '
  + '{"action":"team","team":"<team name, or leave out for your own team>","settings":{"checkpoints":true|false,"maxSteps":1-30,"botHandoffs":true|false}} changes how a team runs: checkpoints asks the owner before each step. '
  + '{"action":"rule","bot":"<bot name>","do":"open|send|post|delete|spend","site":"<site, e.g. github.com>","choice":"always|ask|deny"} saves what that bot may do without asking (a payment is never always). '
  + '{"action":"schedule","bot":"<bot name, or me>","do":"<the message that bot gets each time>","every":"day|hour|week|<minutes>","at":"<HH:MM, optional>","on":"<monday..sunday, optional: a weekly schedule on that day>"} puts work on a timer: the bot runs it in its own chat and the owner reads the result there. Give only "at" for a one-off later today or tomorrow. Add "stop":true with a few words of its message in "do" to stop one; workspace.schedules lists them. When the owner asks for something regular (every morning, each Monday), propose a schedule instead of telling them to come back. '
  + '{"action":"remove","bot":"<bot name>"} removes a bot the owner no longer wants, with its chat and schedules (never Atlas). '
  + '{"action":"open","page":"models|connectors|gmail|permissions|agents|usage"} shows the owner a Settings page, for things only they can do, such as pasting a key; "gmail" (or "drive") is a button that starts the Google sign-in itself, so use it whenever the owner wants email or Drive connected. '
  + 'Nothing changes until the owner taps Apply on the card, so say in your reply what you proposed and why. Never ask for a key or password in chat.';

const lower = value => String(value ?? '').trim().toLowerCase();
const ENGINE_WORDS = {claude: 'claude', anthropic: 'claude', chatgpt: 'codex', codex: 'codex', openai: 'codex'};

/** Read every setup block. Each is {ok, request} or {ok: false, error}. */
export function parseSetupRequests(output) {
  const found = [];
  for (const match of String(output ?? '').matchAll(controlFence('setup'))) {
    if (found.length >= MAX_BLOCKS) break;
    let body;
    try { body = JSON.parse(match[1].trim()); } catch { found.push({ok: false, error: 'the setup block was not valid JSON.'}); continue; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) { found.push({ok: false, error: 'the setup block was not an object.'}); continue; }
    const action = lower(body.action);
    if (!SETUP_ACTIONS.includes(action)) { found.push({ok: false, error: `"${cleanText(body.action, 40) || 'nothing'}" is not something setup can do. Use ${SETUP_ACTIONS.join(', ')}.`}); continue; }
    found.push({ok: true, request: {action, bot: cleanText(body.bot, 60), provider: cleanText(body.provider, 80), model: cleanText(body.model, 120), job: cleanText(body.job, MAX_JOB + 1), page: lower(body.page), name: cleanText(body.name, 81), team: cleanText(body.team, 80), settings: body.settings && typeof body.settings === 'object' && !Array.isArray(body.settings) ? body.settings : null, do: lower(body.do), site: cleanText(body.site, 300), choice: lower(body.choice), what: cleanText(body.do, 2000), every: body.every ?? null, at: cleanText(body.at, 8), on: cleanText(body.on, 12), stop: body.stop === true, ...(body.effort !== undefined && body.effort !== null ? {effort: lower(body.effort)} : {})}});
  }
  return found;
}
export const stripSetupBlocks = output => String(output ?? '').replace(controlFence('setup'), '').replace(/\n{3,}/g, '\n\n').trim();

/** A bot by name, or the speaking bot for "me" / "yourself" / its own name. */
function botNamed(state, name, speaker) {
  const want = lower(name);
  if (!want) return null;
  if (['me', 'myself', 'yourself', 'you', 'self'].includes(want)) return speaker || null;
  const bots = companyBots(state);
  return bots.find(b => lower(b.name) === want) || bots.find(b => lower(b.name).replace(/\s+/g, '') === want.replace(/\s+/g, '')) || null;
}
/** A provider by its label, its engine word (a subscription: "Claude", "ChatGPT") or its host. */
function providerNamed(providers, name) {
  const want = lower(name);
  if (!want) return null;
  return providers.find(p => lower(p.label) === want)
    || providers.find(p => p.kind === 'local-cli' && p.engine === ENGINE_WORDS[want.split(/\s+/)[0]])
    || providers.find(p => lower(p.host) === want || lower(p.label).includes(want))
    || null;
}
/** The model id a provider takes for what the bot wrote. A Claude subscription takes a shorthand for a
 * family alone ("Sonnet" is sonnet) and the full id for a version ("haiku 5.5" is claude-haiku-5-5).
 * A key provider's id is matched against its own list. */
export function modelFor(provider, wanted) {
  const want = String(wanted ?? '').trim();
  if (!want) return {ok: true, model: ''};
  if (provider.kind === 'local-cli') {
    const known = (CLI_MODELS[provider.engine] || []).map(([id]) => id);
    if (known.includes(lower(want))) return {ok: true, model: lower(want)};
    if (provider.engine === 'claude') {
      const m = /(fable|opus|sonnet|haiku)(?:[\s._-]*(\d+)(?:[._-](\d+))?)?/.exec(lower(want));
      if (m && !m[2]) return {ok: true, model: m[1]};
      if (m) {
        const id = `claude-${m[1]}-${m[2]}${m[3] ? `-${m[3]}` : ''}`;
        if (known.includes(id)) return {ok: true, model: id};
        const same = known.filter(k => k.startsWith(`claude-${m[1]}-`));
        return {ok: false, error: `${provider.label || 'The Claude subscription'} has no Claude ${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}. It offers ${same.join(', ')}.`};
      }
    }
    return /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,79}$/.test(want) ? {ok: true, model: want} : {ok: false, error: `"${want}" is not a model name.`};
  }
  const list = Array.isArray(provider.chatModels) ? provider.chatModels : Array.isArray(provider.models) ? provider.models : [];
  if (!list.length || list.includes(want)) return {ok: true, model: want};
  const near = list.find(id => lower(id) === lower(want)) || list.find(id => lower(id).endsWith(`/${lower(want)}`)) || list.find(id => lower(id).includes(lower(want)));
  return near ? {ok: true, model: near} : {ok: false, error: `${provider.label} has no model "${want}". It offers ${list.slice(0, 8).join(', ')}${list.length > 8 ? ', …' : ''}.`};
}

/** Turn one parsed request into the card the owner sees, or say why it cannot be.
 * @returns {{ok: true, card: object}|{ok: false, error: string}} */
export function resolveSetup(state, request, {speaker = null} = {}) {
  const providers = state?.ai?.providers || [];
  if (request.action === 'open') {
    const page = SETUP_PAGES[request.page];
    if (!page) return {ok: false, error: `there is no "${request.page || 'blank'}" page to open. Use models, connectors, permissions, agents or usage.`};
    // Gmail and Drive are one Google sign-in, so the card goes straight to it.
    if (GOOGLE_PAGES.includes(request.page)) return {ok: true, card: {action: 'open', section: 'conn', app: 'google', text: 'Connect Google (Gmail and Drive)'}};
    return {ok: true, card: {action: 'open', section: page[0], text: `Settings → ${page[1]}`}};
  }
  if (request.action === 'job') {
    const bot = botNamed(state, request.bot, speaker);
    if (!bot) return {ok: false, error: `there is no bot called "${request.bot || 'blank'}".`};
    const job = String(request.job || '').trim();
    if (job.length < MIN_JOB || job.length > MAX_JOB) return {ok: false, error: `a job is ${MIN_JOB} to ${MAX_JOB} characters.`};
    return {ok: true, card: {action: 'job', botId: bot.id, job, text: `New job for ${bot.name}: “${job.length > 240 ? `${job.slice(0, 240)}…` : job}”`}};
  }
  if (request.action === 'remove') {
    const bot = botNamed(state, request.bot, speaker);
    if (!bot) return {ok: false, error: `there is no bot called "${request.bot || 'blank'}". The bots are: ${companyBots(state).map(b => b.name).join(', ')}.`};
    if (bot.id === primaryOf(state)?.id) return {ok: false, error: `${bot.name} runs the company and cannot be removed.`};
    return {ok: true, card: {action: 'remove', botId: bot.id, text: `Remove ${bot.name}, with its chat and schedules`}};
  }
  if (request.action === 'team') return teamCard(state, request, speaker);
  if (request.action === 'schedule') return scheduleCard(state, request, speaker);
  if (request.action === 'rename' || request.action === 'settings' || request.action === 'rule') {
    const bot = botNamed(state, request.bot, speaker);
    if (!bot) return {ok: false, error: `there is no bot called "${request.bot || 'blank'}".`};
    if (request.action === 'rename') return renameCard(state, bot, request.name);
    if (request.action === 'settings') return settingsCard(state, bot, request.settings, speaker);
    return ruleCard(bot, request);
  }
  const bot = request.bot ? botNamed(state, request.bot, speaker) : null;
  if (request.bot && !bot) return {ok: false, error: `there is no bot called "${request.bot}".`};
  // How hard it thinks rides on the model action, alone or with a model.
  const wantsEffort = request.effort !== undefined;
  const effort = wantsEffort ? (['default', 'none', 'auto', 'normal'].includes(request.effort) ? '' : cleanEffort(request.effort)) : undefined;
  if (effort === null) return {ok: false, error: `"${request.effort}" is not an effort level. Use low, medium or high, or "default" for the model's own.`};
  const effortWords = effort ? `${effort} effort` : "the model's own default";
  if (wantsEffort && !request.provider && !request.model) {
    return {ok: true, card: {action: 'model', ...(bot ? {botId: bot.id} : {}), effort,
      text: bot ? `${bot.name} thinks with ${effortWords}` : `Everyone's effort: ${effortWords}`}};
  }
  const provider = providerNamed(providers, request.provider) || (!request.provider && request.model ? providers.find(p => p.id === (state?.ai?.bots?.[bot?.id]?.providerId || state?.ai?.defaultProviderId)) : null);
  if (!provider) return {ok: false, error: providers.length ? `no model is called "${request.provider || 'blank'}". Connected: ${providers.map(p => p.label).join(', ')}.` : 'no model is connected yet. Point the owner to Settings → Models and keys.'};
  const model = modelFor(provider, request.model);
  if (!model.ok) return {ok: false, error: model.error};
  const what = `${provider.label}${model.model ? ` · ${model.model}` : ''}`;
  const also = wantsEffort ? `, ${effortWords}` : '';
  return {ok: true, card: {action: 'model', ...(bot ? {botId: bot.id} : {}), providerId: provider.id, model: model.model, ...(wantsEffort ? {effort} : {}),
    text: bot ? `${bot.name} uses ${what}${also}` : `Everyone's default model: ${what}${also}`}};
}

function renameCard(state, bot, wanted) {
  const name = String(wanted ?? '').trim();
  if (!name || name.length > 80) return {ok: false, error: 'a bot name is 1 to 80 characters.'};
  const taken = companyBots(state).find(b => b.id !== bot.id && lower(b.name) === lower(name));
  if (taken) return {ok: false, error: `a bot is already called ${taken.name}.`};
  return {ok: true, card: {action: 'rename', botId: bot.id, name, text: `Rename ${bot.name} to ${name}`}};
}

function settingsCard(state, bot, wanted, speaker) {
  const picked = {};
  for (const key of BOT_SETTABLE) if (wanted && Object.hasOwn(wanted, key)) picked[key] = wanted[key];
  if (!Object.keys(picked).length) return {ok: false, error: `nothing to change. A bot may set ${BOT_SETTABLE.join(', ')}.`};
  if (Object.hasOwn(picked, 'reportsTo')) {
    const word = lower(picked.reportsTo);
    if (!word || ['none', 'nobody', 'solo', 'no one'].includes(word)) picked.reportsTo = null;
    else {
      const manager = botNamed(state, picked.reportsTo, speaker);
      if (!manager || manager.id === bot.id) return {ok: false, error: `there is no other bot called "${cleanText(picked.reportsTo, 60)}" to report to.`};
      picked.reportsTo = manager.id;
    }
  }
  let next;
  try { next = validateBotSettings(picked, bot.settings || {}); } catch (error) { return {ok: false, error: lower(error.message).replace(/\.$/, '') + '.'}; }
  const settings = Object.fromEntries(Object.keys(picked).map(key => [key, next[key]]));
  const words = botWords(state);
  return {ok: true, card: {action: 'settings', botId: bot.id, settings, text: `${bot.name}: ${Object.entries(settings).map(([k, v]) => words[k](v)).join(', ')}`}};
}

/** How a bot setting reads, for a card and for the brief. */
function botWords(state) {
  const nameOf = id => companyBots(state).find(b => b.id === id)?.name || 'nobody';
  return {
    replyLength: v => `${v} replies`, style: v => (v ? `style “${short(v, 80)}”` : 'no extra style'), memory: v => (v ? 'memory on' : 'no memory'),
    canHandoff: v => (v ? 'may hand work on' : 'keeps its work'), summonable: v => (v ? 'may be @mentioned anywhere' : 'only in its own group'),
    enabled: v => (v ? 'switched on' : 'switched off'), temperature: v => (v === null ? 'default temperature' : `temperature ${v}`),
    reportsTo: v => (v ? `reports to ${nameOf(v)}` : 'works solo'),
  };
}
const TEAM_WORDS = {
  checkpoints: v => (v ? 'asks you before each step' : 'runs every step without asking'),
  maxSteps: v => `at most ${v} steps`, botHandoffs: v => (v ? 'its bots may hand work to each other' : 'no hand-offs between its bots'),
};

function teamCard(state, request, speaker) {
  const groups = state?.groups || [];
  const want = lower(request.team);
  const group = want && !['this', 'mine', 'my team', 'our team', 'here'].includes(want)
    ? groups.find(g => lower(g.name) === want) || groups.find(g => lower(g.id) === want)
    : groups.find(g => (g.bots || []).some(b => b.id === speaker?.id));
  if (!group) return {ok: false, error: `there is no team called "${cleanText(request.team, 60) || 'blank'}".`};
  const picked = {};
  for (const key of TEAM_SETTABLE) if (request.settings && Object.hasOwn(request.settings, key)) picked[key] = request.settings[key];
  if (!Object.keys(picked).length) return {ok: false, error: `nothing to change. A team card may set ${TEAM_SETTABLE.join(', ')}.`};
  let next;
  try { next = validateGroupSettings(group, picked, group.settings || {}); } catch (error) { return {ok: false, error: lower(error.message).replace(/\.$/, '') + '.'}; }
  const settings = Object.fromEntries(Object.keys(picked).map(key => [key, next[key]]));
  return {ok: true, card: {action: 'team', groupId: group.id, settings, text: `${group.name || 'This team'}: ${Object.entries(settings).map(([k, v]) => TEAM_WORDS[k](v)).join(', ')}`}};
}

function ruleCard(bot, request) {
  const act = RULE_WORDS[request.do];
  if (!act) return {ok: false, error: `a rule is for open, send, post, delete or spend, not "${request.do || 'blank'}".`};
  const choice = request.choice === 'allow' ? 'always' : request.choice;
  if (!GRANT_CHOICES.includes(choice)) return {ok: false, error: 'a rule is always, ask or deny.'};
  if (!grantChoices(act).includes(choice)) return {ok: false, error: 'a payment is asked every time, so it can only be ask or deny.'};
  let scope = '';
  if (PER_SITE.includes(act)) {
    const site = String(request.site || '').trim();
    scope = scopeOf({action: act, target: /^https?:\/\//i.test(site) ? site : `https://${site}`});
    if (!site || !scope) return {ok: false, error: 'name the site the rule is for, like github.com.'};
  }
  return {ok: true, card: {action: 'rule', botId: bot.id, act, scope, choice, text: `${bot.name}: ${GRANT_LABELS[choice]} · ${grantWhat(act, scope)}`}};
}

/** The card a setup message carries, read back safely. Anything malformed is null, so no button is painted. */
export function setupCardOf(message) {
  let card;
  try { card = typeof message?.setup === 'string' ? JSON.parse(message.setup) : message?.setup; } catch { return null; }
  if (!card || typeof card !== 'object' || !SETUP_ACTIONS.includes(card.action)) return null;
  if (card.action === 'open') return Object.values(SETUP_PAGES).some(([key]) => key === card.section) ? card : null;
  if (card.action === 'job') return typeof card.botId === 'string' && typeof card.job === 'string' ? card : null;
  if (card.action === 'rename') return typeof card.botId === 'string' && typeof card.name === 'string' ? card : null;
  if (card.action === 'settings') return typeof card.botId === 'string' && card.settings && typeof card.settings === 'object' && Object.keys(card.settings).length && Object.keys(card.settings).every(k => BOT_SETTABLE.includes(k)) ? card : null;
  if (card.action === 'team') return typeof card.groupId === 'string' && card.settings && typeof card.settings === 'object' && Object.keys(card.settings).length && Object.keys(card.settings).every(k => TEAM_SETTABLE.includes(k)) ? card : null;
  if (card.action === 'remove') return typeof card.botId === 'string' ? card : null;
  if (card.action === 'schedule') return typeof card.botId === 'string' && (card.stop ? typeof card.taskId === 'string' : typeof card.groupId === 'string' && typeof card.message === 'string' && (Number.isInteger(card.every) || Boolean(cleanAt(card.at)))) ? card : null;
  if (card.action === 'rule') return typeof card.botId === 'string' && ASK_ACTIONS.includes(card.act) && GRANT_CHOICES.includes(card.choice) && typeof card.scope === 'string' ? card : null;
  return typeof card.providerId === 'string' || (typeof card.effort === 'string' && cleanEffort(card.effort) !== null) ? card : null;
}
/** Is the change already in place? Then the card is a done line with no button. An open card never is. */
/** Work on a timer: a recurring or one-off task for a bot (its message is run in that bot's chat), or
 * stopping one of its schedules, found by words from its message. */
function scheduleCard(state, request, speaker) {
  const bot = botNamed(state, request.bot, speaker);
  if (!bot) return {ok: false, error: `there is no bot called "${request.bot || 'blank'}".`};
  const what = String(request.what || '').trim();
  if (request.stop) {
    const words = lower(what), mine = scheduleRows(state, bot.id);
    const hits = words ? mine.filter(r => lower(r.what).includes(words)) : mine;
    if (!mine.length) return {ok: false, error: `${bot.name} has no schedule to stop.`};
    if (hits.length !== 1) return {ok: false, error: `say which schedule to stop with a few of its words in "do". ${bot.name} has: ${mine.map(r => `"${r.what}" ${r.when}`).join('; ')}.`};
    return {ok: true, card: {action: 'schedule', stop: true, taskId: hits[0].id, botId: bot.id, text: `Stop ${bot.name}: “${hits[0].what}” ${hits[0].when}`}};
  }
  if (what.length < 3) return {ok: false, error: 'say what to do in "do", as the message the bot will get each time.'};
  // A day of the week ("every Monday") is a weekly schedule on that day.
  const on = cleanDay(request.on);
  if (request.on && !on) return {ok: false, error: `"${request.on}" is not a day of the week. Use monday to sunday.`};
  const every = on && (request.every === undefined || request.every === null || request.every === '') ? 10080 : everyMinutes(request.every), at = cleanAt(request.at);
  if (on && every !== 10080) return {ok: false, error: 'a day of the week goes with every week: leave "every" out or set it to week.'};
  if (every === null) return {ok: false, error: `"${request.every}" is not how often. Use day, hour, week, or a number of minutes (at least ${MIN_EVERY} minutes, at most ${MAX_EVERY}).`};
  if (every === undefined && !at) return {ok: false, error: 'say how often in "every" (day, hour, week or minutes) or when in "at" (HH:MM), or both.'};
  if (request.at && !at) return {ok: false, error: `"${request.at}" is not a time of day. Use HH:MM, such as 08:00.`};
  const group = (state?.groups || []).find(g => (g.bots || []).some(b => b.id === bot.id));
  if (!group) return {ok: false, error: `${bot.name} is not in a team.`};
  return {ok: true, card: {action: 'schedule', botId: bot.id, groupId: group.id, message: what, ...(every ? {every} : {}), ...(at ? {at} : {}), ...(on ? {on} : {}), text: `${bot.name}: “${what}” ${whenWords({every, at, on})}`}};
}
export function setupDone(state, card) {
  if (!card || card.action === 'open') return false;
  if (card.action === 'remove') return !companyBots(state).some(b => b.id === card.botId);
  if (card.action === 'job') return companyBots(state).find(b => b.id === card.botId)?.instructions === card.job;
  if (card.action === 'schedule') {
    const rows = scheduleRows(state, card.botId);
    return card.stop ? !rows.some(r => r.id === card.taskId) : rows.some(r => r.what === card.message);
  }
  if (card.action === 'team') { const group = (state?.groups || []).find(g => g.id === card.groupId); const now = groupSettings(group || {}); return Boolean(group) && Object.entries(card.settings).every(([k, v]) => now[k] === v); }
  const bot = companyBots(state).find(b => b.id === card.botId);
  if (card.action === 'rename') return bot?.name === card.name;
  if (card.action === 'settings') { const now = botSettings(bot || {}); return Boolean(bot) && Object.entries(card.settings).every(([k, v]) => (now[k] ?? null) === v); }
  if (card.action === 'rule') { const g = (state?.grants || []).find(x => x.botId === card.botId && x.action === card.act && (x.scope || '') === card.scope); return (g?.choice || 'ask') === card.choice; }
  const ai = state?.ai || {};
  const own = card.botId ? ai.bots?.[card.botId] || {} : {providerId: ai.defaultProviderId, model: ai.defaultModel, effort: ai.defaultEffort};
  const sameModel = card.providerId === undefined || (own.providerId === card.providerId && (own.model || '') === (card.model || ''));
  const sameEffort = card.effort === undefined || (own.effort || '') === card.effort;
  return sameModel && sameEffort;
}
/** The button on a setup card. */
export const setupButton = card => (card.app === 'google' ? 'Connect Google' : card.action === 'open' ? `Open ${card.text.replace(/^Settings → /, '')}` : card.action === 'remove' ? 'Remove' : 'Apply');

/* ---------- what every bot knows ---------- */

function youLine(primary, speaker) {
  if (!primary) return undefined;
  if (speaker && speaker.id !== primary.id) return `You are ${speaker.name}. ${primary.name} is the primary bot and sets the app up, but you know this workspace too: when the owner asks you to change a setting, propose it yourself with the setup block instead of sending them to Settings.`;
  return `You are ${primary.name}, the primary bot. You know how this app works and you set it up for the owner, so they never have to learn the settings: when they ask for a change, propose it with the setup block.`;
}

const short = (text, n) => { const s = String(text ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const CLI_WORDS = {'signed-in': 'signed in', 'signed-out': 'signed out', missing: 'not installed', unknown: 'not reported yet'};

/** A compact picture of the workspace for the primary bot's prompt. `agents` is the paired devices
 * ({name, online, permissions, cli}); `connectors` is the connected services ({name, status}). */
export function workspaceBrief(state, {agents = [], connectors = [], speaker = null} = {}) {
  const ai = state?.ai || {}, providers = ai.providers || [];
  const label = id => providers.find(p => p.id === id)?.label || null;
  const models = providers.map(p => ({
    name: p.label,
    kind: p.kind === 'local-cli' ? `${p.engine === 'codex' ? 'ChatGPT' : 'Claude'} subscription, runs on this computer` : 'API key',
    ...(p.id === ai.defaultProviderId ? {default: true} : {}),
    models: p.kind === 'local-cli' ? (CLI_MODELS[p.engine] || []).map(([id]) => id) : (p.chatModels || p.models || []).slice(0, 12),
  }));
  const bots = companyBots(state).map(b => {
    const own = ai.bots?.[b.id] || {};
    const model = (own.providerId ? `${label(own.providerId) || 'a removed model'}${own.model ? ` · ${own.model}` : ''}` : 'the default') + (own.effort ? ` · ${own.effort} effort` : '');
    // Only what differs from a new bot, in the words a card uses; "off" stays its own flag.
    const set = botSettings(b), words = botWords(state);
    const changed = BOT_SETTABLE.filter(k => k !== 'enabled' && (set[k] ?? null) !== (BOT_DEFAULTS[k] ?? null)).map(k => words[k](set[k]));
    return {name: b.name, job: short(b.instructions, 140) || 'no job yet', model, ...(set.enabled === false ? {off: true} : {}), ...(changed.length ? {settings: changed.join(', ')} : {})};
  });
  const teams = (state?.groups || []).filter(g => g?.settings?.kind !== 'thread').map(g => {
    const set = groupSettings(g);
    const changed = TEAM_SETTABLE.filter(k => set[k] !== GROUP_DEFAULTS[k]).map(k => TEAM_WORDS[k](set[k]).replace('asks you', 'asks the owner'));
    return {name: g.name || g.id, bots: (g.bots || []).length, ...(changed.length ? {runs: changed.join(', ')} : {})};
  });
  const live = agents.filter(a => a.online && a.status !== 'revoked');
  const computer = live.length
    ? live.map(a => `${a.name}: online${(a.permissions || []).includes('browser.action') ? ', opens web pages' : ''}${a.cli ? `, claude ${CLI_WORDS[a.cli.claude] || 'unknown'}, codex ${CLI_WORDS[a.cli.codex] || 'unknown'}` : ''}`).join('; ')
    : agents.length ? 'paired but not running right now' : 'no computer connected';
  const named = id => companyBots(state).find(b => b.id === id)?.name;
  const rules = (state?.grants || []).filter(g => named(g.botId)).slice(0, 20)
    .map(g => `${named(g.botId)}: ${GRANT_LABELS[g.choice] || g.choice} ${g.action} ${g.scope}`);
  const waiting = pendingAsks(state || {}).slice(0, 10).map(a => askText(a, named(a.botId) || 'A bot'));
  const threads = (state?.groups || []).filter(g => g?.settings?.kind === 'thread').slice(-10).map(g => g.name);
  const schedules = scheduleRows(state).filter(r => named(r.botId)).slice(0, 20).map(r => `${named(r.botId)}: "${r.what}" ${r.when}`);
  return {
    you: youLine(primaryOf(state), speaker),
    models: models.length ? models : 'none connected yet',
    defaultModel: ai.defaultProviderId ? `${label(ai.defaultProviderId) || 'unknown'}${ai.defaultModel ? ` · ${ai.defaultModel}` : ''}${ai.defaultEffort ? ` · ${ai.defaultEffort} effort` : ''}` : 'none',
    bots,
    teams,
    computer,
    // Saved answers, what waits on the owner and the open threads: what Atlas needs to say where things stand.
    basicAccess: state?.askBasics ? 'every bot asks the owner before opening a web page or reading a connected app' : 'every bot opens web pages and reads connected apps without asking; sending, posting, deleting and paying ask',
    rules: rules.length ? rules : 'none',
    waitingOnOwner: waiting.length ? waiting : 'nothing',
    threads: threads.length ? threads : 'none',
    schedules: schedules.length ? schedules : 'none',
    connectors: connectors.length ? connectors.map(c => `${c.name}${c.status && c.status !== 'ready' ? ` (${c.status})` : ''}`) : 'none',
    facts: [
      'A bot opens a web page by asking with the browser block; the owner answers Decline, Allow or Always allow. Saved answers are in Settings → Permissions.',
      'This computer runs the browser and the claude and codex sign-in by itself; there is nothing to pair on it.',
      'Models and keys are added only by the owner, in Settings → Models and keys. Never ask for a key in chat; use the setup block to open that page.',
      'To connect Gmail or Google Drive, send the setup block {"action":"open","page":"gmail"}: its button starts the Google sign-in. MCP servers are connected in Settings → Connectors. An MCP server that runs on this computer is added there under On my computer, with the command that starts it; the owner types it, never you.',
      'When a run fails because a model is down or out of quota, propose another connected model with the setup block.',
    ],
  };
}
