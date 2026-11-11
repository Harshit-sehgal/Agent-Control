/** The bot knows the app and sets it up; the owner only taps.
 *
 * Two halves:
 *
 * - `workspaceBrief(state, {agents, connectors})` is what the primary bot is told about this workspace:
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
 *   `model` (a bot's model, or the default when `bot` is left out), `job` (a bot's job sentence), or
 *   `open` (a Settings page: models, connectors, permissions, agents, usage). The block never changes
 *   anything: it becomes a card in the chat with one button, and the owner's tap calls the same route
 *   the settings page calls, with the owner's own session. A model cannot add a key, grant a permission
 *   or reach a route the owner could not.
 *
 * Pure and browser-safe: the server reads replies with it and the UI paints the card from it. */
import {cleanText} from './core.js';
import {controlFence} from './reply-blocks.js';
import {companyBots, primaryOf} from './company.js';

export const SETUP_ACTIONS = ['model', 'job', 'open'];
/** Settings pages a bot may point to, by the word it uses, and the section key and title the app uses. */
export const SETUP_PAGES = {
  models: ['models', 'Models and keys'], keys: ['models', 'Models and keys'],
  connectors: ['conn', 'Connectors'], gmail: ['conn', 'Connectors'], drive: ['conn', 'Connectors'], mcp: ['conn', 'Connectors'],
  permissions: ['perm', 'Permissions'], agents: ['agents', 'Local agents'], computer: ['agents', 'Local agents'],
  usage: ['usage', 'Usage'], appearance: ['look', 'Appearance'], general: ['general', 'General'],
};
const MIN_JOB = 20, MAX_JOB = 3000, MAX_BLOCKS = 3;

export const SETUP_TOOL_HINT = 'To change a setting for the owner, put one fenced block named setup in your reply, holding JSON. '
  + '{"action":"model","bot":"<bot name, or leave out for everyone\'s default>","provider":"<a model name from workspace.models>","model":"<one of its models, or leave out for its default>"} sets a model. '
  + '{"action":"job","bot":"<bot name>","job":"<the new job, one or two sentences>"} rewrites a bot\'s job. '
  + '{"action":"open","page":"models|connectors|permissions|agents|usage"} shows the owner a Settings page, for things only they can do, such as pasting a key. '
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
    if (!SETUP_ACTIONS.includes(action)) { found.push({ok: false, error: `"${cleanText(body.action, 40) || 'nothing'}" is not something setup can do. Use model, job or open.`}); continue; }
    found.push({ok: true, request: {action, bot: cleanText(body.bot, 60), provider: cleanText(body.provider, 80), model: cleanText(body.model, 120), job: cleanText(body.job, MAX_JOB + 1), page: lower(body.page)}});
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
/** The model id a provider takes for what the bot wrote. A Claude subscription takes opus, sonnet or haiku,
 * so "haiku-5.5" or "Claude Haiku" is haiku. A key provider's id is matched against its own list. */
export function modelFor(provider, wanted) {
  const want = String(wanted ?? '').trim();
  if (!want) return {ok: true, model: ''};
  if (provider.kind === 'local-cli') {
    if (provider.engine === 'claude') {
      const family = ['opus', 'sonnet', 'haiku'].find(f => lower(want).includes(f));
      if (family && !/^claude-[a-z]+-\d/.test(lower(want))) return {ok: true, model: family};
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
    return {ok: true, card: {action: 'open', section: page[0], text: `Settings → ${page[1]}`}};
  }
  if (request.action === 'job') {
    const bot = botNamed(state, request.bot, speaker);
    if (!bot) return {ok: false, error: `there is no bot called "${request.bot || 'blank'}".`};
    const job = String(request.job || '').trim();
    if (job.length < MIN_JOB || job.length > MAX_JOB) return {ok: false, error: `a job is ${MIN_JOB} to ${MAX_JOB} characters.`};
    return {ok: true, card: {action: 'job', botId: bot.id, job, text: `New job for ${bot.name}: “${job.length > 240 ? `${job.slice(0, 240)}…` : job}”`}};
  }
  const bot = request.bot ? botNamed(state, request.bot, speaker) : null;
  if (request.bot && !bot) return {ok: false, error: `there is no bot called "${request.bot}".`};
  const provider = providerNamed(providers, request.provider) || (!request.provider && request.model ? providers.find(p => p.id === (state?.ai?.bots?.[bot?.id]?.providerId || state?.ai?.defaultProviderId)) : null);
  if (!provider) return {ok: false, error: providers.length ? `no model is called "${request.provider || 'blank'}". Connected: ${providers.map(p => p.label).join(', ')}.` : 'no model is connected yet. Point the owner to Settings → Models and keys.'};
  const model = modelFor(provider, request.model);
  if (!model.ok) return {ok: false, error: model.error};
  const what = `${provider.label}${model.model ? ` · ${model.model}` : ''}`;
  return {ok: true, card: {action: 'model', ...(bot ? {botId: bot.id} : {}), providerId: provider.id, model: model.model,
    text: bot ? `${bot.name} uses ${what}` : `Everyone's default model: ${what}`}};
}

/** The card a setup message carries, read back safely. Anything malformed is null, so no button is painted. */
export function setupCardOf(message) {
  let card;
  try { card = typeof message?.setup === 'string' ? JSON.parse(message.setup) : message?.setup; } catch { return null; }
  if (!card || typeof card !== 'object' || !SETUP_ACTIONS.includes(card.action)) return null;
  if (card.action === 'open') return Object.values(SETUP_PAGES).some(([key]) => key === card.section) ? card : null;
  if (card.action === 'job') return typeof card.botId === 'string' && typeof card.job === 'string' ? card : null;
  return typeof card.providerId === 'string' ? card : null;
}
/** Is the change already in place? Then the card is a done line with no button. An open card never is. */
export function setupDone(state, card) {
  if (!card || card.action === 'open') return false;
  if (card.action === 'job') return companyBots(state).find(b => b.id === card.botId)?.instructions === card.job;
  const ai = state?.ai || {};
  if (card.botId) { const own = ai.bots?.[card.botId] || {}; return own.providerId === card.providerId && (own.model || '') === (card.model || ''); }
  return ai.defaultProviderId === card.providerId && (ai.defaultModel || '') === (card.model || '');
}
/** The button on a setup card. */
export const setupButton = card => (card.action === 'open' ? `Open ${card.text.replace(/^Settings → /, '')}` : 'Apply');

/* ---------- what the primary bot knows ---------- */

const short = (text, n) => { const s = String(text ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const CLI_WORDS = {'signed-in': 'signed in', 'signed-out': 'signed out', missing: 'not installed', unknown: 'not reported yet'};

/** A compact picture of the workspace for the primary bot's prompt. `agents` is the paired devices
 * ({name, online, permissions, cli}); `connectors` is the connected services ({name, status}). */
export function workspaceBrief(state, {agents = [], connectors = []} = {}) {
  const ai = state?.ai || {}, providers = ai.providers || [];
  const label = id => providers.find(p => p.id === id)?.label || null;
  const models = providers.map(p => ({
    name: p.label,
    kind: p.kind === 'local-cli' ? `${p.engine === 'codex' ? 'ChatGPT' : 'Claude'} subscription, runs on this computer` : 'API key',
    ...(p.id === ai.defaultProviderId ? {default: true} : {}),
    models: p.kind === 'local-cli' ? (p.engine === 'claude' ? ['opus', 'sonnet', 'haiku'] : []) : (p.chatModels || p.models || []).slice(0, 12),
  }));
  const bots = companyBots(state).map(b => {
    const own = ai.bots?.[b.id] || {};
    const model = own.providerId ? `${label(own.providerId) || 'a removed model'}${own.model ? ` · ${own.model}` : ''}` : 'the default';
    return {name: b.name, job: short(b.instructions, 140) || 'no job yet', model, ...(b.enabled === false ? {off: true} : {})};
  });
  const live = agents.filter(a => a.online && a.status !== 'revoked');
  const computer = live.length
    ? live.map(a => `${a.name}: online${(a.permissions || []).includes('browser.action') ? ', opens web pages' : ''}${a.cli ? `, claude ${CLI_WORDS[a.cli.claude] || 'unknown'}, codex ${CLI_WORDS[a.cli.codex] || 'unknown'}` : ''}`).join('; ')
    : agents.length ? 'paired but not running right now' : 'no computer connected';
  return {
    you: primaryOf(state) ? `You are ${primaryOf(state).name}, the primary bot. You know how this app works and you set it up for the owner, so they never have to learn the settings.` : undefined,
    models: models.length ? models : 'none connected yet',
    defaultModel: ai.defaultProviderId ? `${label(ai.defaultProviderId) || 'unknown'}${ai.defaultModel ? ` · ${ai.defaultModel}` : ''}` : 'none',
    bots,
    computer,
    connectors: connectors.length ? connectors.map(c => `${c.name}${c.status && c.status !== 'ready' ? ` (${c.status})` : ''}`) : 'none',
    facts: [
      'A bot opens a web page by asking with the browser block; the owner answers Decline, Allow or Always allow. Saved answers are in Settings → Permissions.',
      'This computer runs the browser and the claude and codex sign-in by itself; there is nothing to pair on it.',
      'Models and keys are added only by the owner, in Settings → Models and keys. Never ask for a key in chat; use the setup block to open that page.',
      'Gmail, Google Drive and MCP servers are connected in Settings → Connectors.',
      'When a run fails because a model is down or out of quota, propose another connected model with the setup block.',
    ],
  };
}
