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
 *   (Always allow / Ask each time / Deny for a bot, an action and a site; a payment Always allow names its site),
 *   `schedule`, `remove`, `signin`, `pause` (every bot), `limits` (pages, rounds, team steps per message),
 *   `basics` (ask before every page and app read), `forget` (a bot's memory notes), `disconnect` (a connector),
 *   `thread` (rename or delete one), or `open` (a Settings page: models, connectors, permissions, devices, usage).
 *   A bot's colour is named (COLOR_NAMES), never a palette number. The block never changes
 *   anything: it becomes a card in the chat with one button, and the owner's tap calls the same route
 *   the settings page calls, with the owner's own session. A model cannot add a key, type a command,
 *   make itself the primary bot, save a rule without the owner's tap, or reach a route the owner could not.
 *
 * Pure and browser-safe: the server reads replies with it and the UI paints the card from it. */
import {cleanText, validHttpUrl} from './core.js?v=a9557469c7';
import {cleanEffort, CLI_MODELS} from './ai-presets.js?v=a9557469c7';
import {everyMinutes, cleanAt, cleanDay, whenWords, scheduleRows, MIN_EVERY, MAX_EVERY} from './schedules.js?v=a9557469c7';
import {controlFence} from './reply-blocks.js?v=a9557469c7';
import {companyBots, primaryOf} from './company.js?v=a9557469c7';
import {GRANT_LABELS, GRANT_CHOICES, ASK_ACTIONS, askText, pendingAsks, scopeOf, grantChoices, isAskAction} from './asks.js?v=a9557469c7';
import {botSettings, validateBotSettings, groupSettings, validateGroupSettings, BOT_DEFAULTS, GROUP_DEFAULTS} from './bot-settings.js?v=a9557469c7';
import {grantWhat, payAlwaysText} from './ui-asks.js?v=a9557469c7';
import {COLOR_NAMES} from './ui-kit.js?v=a9557469c7';
import {SHAPES} from './company.js?v=a9557469c7';
import {limitsOf, BACKSTOP} from './limits.js?v=a9557469c7';
import {APPS, appById} from './app-catalog.js?v=a9557469c7';
import {PRESETS, presetOf} from './presets.js?v=a9557469c7';
import {titleOf as templateTitle} from './templates.js?v=a9557469c7';
import {briefingSchedule} from './briefing.js?v=a9557469c7';
import {monthByBot, tokensOf, short as shortCount} from './usage.js?v=a9557469c7';

export const SETUP_ACTIONS = ['model', 'job', 'rename', 'settings', 'team', 'rule', 'schedule', 'remove', 'open', 'signin', 'pause', 'limits', 'basics', 'forget', 'disconnect', 'thread', 'reconnect', 'connect', 'memory', 'template', 'preset', 'briefing'];
/** The bot settings a bot may propose. Not the primary role, the browser approval mode, or layout (pins, order). */
export const BOT_SETTABLE = ['replyLength', 'style', 'memory', 'canHandoff', 'summonable', 'enabled', 'temperature', 'reportsTo', 'tint', 'shape'];
const LIMIT_KEYS = ['pages', 'rounds', 'steps'];
const LIMIT_WORDS = {pages: 'pages per reply', rounds: 'rounds of pages in a row', steps: 'team steps per message', askCheckpoints: 'ask between bot-to-bot steps'};
/** The team (group) settings a bot may propose: approve between steps, the step limit, hand-offs between its bots. */
export const TEAM_SETTABLE = ['checkpoints', 'maxSteps', 'botHandoffs', 'routing', 'confirmPlan'];
const RULE_WORDS = {open: 'browser.use', browse: 'browser.use', browser: 'browser.use', 'browser.use': 'browser.use', web: 'browser.use', send: 'send', email: 'send', post: 'post', delete: 'delete', spend: 'spend', pay: 'spend', payment: 'spend', buy: 'spend'};
const PER_SITE = ['browser.use', 'send', 'post', 'delete'];
/** Settings pages a bot may point to, by the word it uses, and the section key and title the app uses. */
export const SETUP_PAGES = {
  models: ['models', 'Models and keys'], keys: ['models', 'Models and keys'],
  connectors: ['conn', 'Connectors'], gmail: ['conn', 'Connectors'], drive: ['conn', 'Connectors'], calendar: ['conn', 'Connectors'], google: ['conn', 'Connectors'], mcp: ['conn', 'Connectors'],
  permissions: ['perm', 'Permissions'], devices: ['agents', 'Local agents'], agents: ['agents', 'Local agents'], computer: ['agents', 'Local agents'],
  usage: ['usage', 'Usage'], appearance: ['look', 'Appearance'], look: ['look', 'Appearance'], theme: ['look', 'Appearance'], general: ['general', 'General'],
  notifications: ['notifications', 'Notifications'], alerts: ['notifications', 'Notifications'], workspaces: ['workspaces', 'Workspaces'], workspace: ['workspaces', 'Workspaces'],
  members: ['team', 'Team and access'], people: ['team', 'Team and access'], access: ['team', 'Team and access'],
  data: ['data', 'Data and security'], retention: ['data', 'Data and security'], security: ['data', 'Data and security'], backup: ['data', 'Data and security'],
  about: ['about', 'About this build'],
};
/** The page words a bot is told, one per page. */
const PAGE_LIST = 'models, connectors, gmail, drive, calendar, permissions, devices, usage, appearance, notifications, workspaces, members, data, about';
/** The Google words a bot may use, and the Google MCP app each one connects. */
const GOOGLE_PAGES = {gmail: 'gmail', google: 'gmail', mail: 'gmail', email: 'gmail', drive: 'google-drive', 'google drive': 'google-drive', docs: 'google-drive', calendar: 'google-calendar', 'google calendar': 'google-calendar'};
const googleApp = word => (Object.hasOwn(GOOGLE_PAGES, word) ? GOOGLE_PAGES[word] : null);
/** A public site as an https address ("reddit.com" → https://reddit.com/), or null: never an IP address or a local name. */
function signinUrl(value) {
  const text = String(value || '').trim();
  const url = validHttpUrl(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  if (!url) return null;
  const host = new URL(url).hostname;
  return host.includes('.') && !/^[\d.]+$/.test(host) && !host.includes(':') && !/(^|\.)(localhost|local|internal)$/i.test(host) ? url : null;
}
const MIN_JOB = 20, MAX_JOB = 3000, MAX_BLOCKS = 8;

export const SETUP_TOOL_HINT = 'To change a setting for the owner, put one fenced block named setup in your reply, holding JSON. '
  + '{"action":"model","bot":"<bot name, or leave out for everyone\'s default>","provider":"<a model name from workspace.models>","model":"<one of its models, or leave out for its default>","effort":"<low|medium|high|default, optional>"} sets a model and how hard it thinks (effort alone, with no provider, changes only the effort: high for hard or careful work, low for quick replies). '
  + '{"action":"job","bot":"<bot name>","job":"<the new job, one or two sentences>"} rewrites a bot\'s job. '
  + '{"action":"rename","bot":"<bot name>","name":"<new name>"} renames a bot. '
  + `{"action":"settings","bot":"<bot name>","settings":{"replyLength":"short|medium|long","style":"<tone>","memory":true|false,"canHandoff":true|false,"summonable":true|false,"enabled":true|false,"temperature":0-2,"reportsTo":"<manager bot name, or none>","colour":"<${COLOR_NAMES.join('|')}>","shape":"<${SHAPES.join('|')}>"}} changes how a bot works or looks; give only what changes. `
  + '{"action":"team","team":"<team name, or leave out for your own team>","settings":{"checkpoints":true|false,"maxSteps":1-30,"botHandoffs":true|false,"routing":"pipeline|mentions|everyone","confirmPlan":true|false}} changes how a team runs: checkpoints asks the owner before each step, routing is who answers a message with no @mention, confirmPlan shows the plan before a tracked task starts. '
  + '{"action":"rule","bot":"<bot name>","do":"open|send|post|delete|spend","site":"<site, e.g. github.com>","choice":"always|ask|deny"} saves what that bot may do without asking (a payment Always allow needs its site). {"action":"rule","bot":"<bot name>","do":"connector","connector":"<connector name>","tool":"<one of its tools, or leave out for reading it>","choice":"always|ask|deny"} is the same for a connected app: a write tool is its own rule. '
  + '{"action":"schedule","bot":"<bot name, or me>","do":"<the message that bot gets each time>","every":"day|hour|week|<minutes>","at":"<HH:MM, optional>","on":"<monday..sunday, optional: a weekly schedule on that day>"} puts work on a timer: the bot runs it in its own chat and the owner reads the result there. Give only "at" for a one-off later today or tomorrow. Add "stop":true with a few words of its message in "do" to stop one; to move one, send "change":"<a few words of its message>" with only the new "every", "at" or "on" (and "do" for a new message); workspace.schedules lists them. When the owner asks for something regular (every morning, each Monday), propose a schedule instead of telling them to come back. '
  + '{"action":"pause"} pauses every bot at once (the owner resumes them). '
  + `{"action":"limits","pages":1-${BACKSTOP.pages},"rounds":1-${BACKSTOP.rounds},"steps":1-${BACKSTOP.steps}} caps how far one message may go (pages per reply, rounds of pages in a row, team steps); "none" removes a cap; "askCheckpoints":true|false asks the owner between bot-to-bot steps; give only what changes. The owner saying "bots should open at most 3 pages per reply" or "no more than 10 steps" is this block ({"action":"limits","pages":3}), never a note about your own reply. `
  + '{"action":"basics","ask":true|false} true makes every bot ask before opening any web page or reading a connected app; false lets them browse and read without asking. '
  + '{"action":"template","title":"<short name>","text":"<the message it fills in>"} saves a task template the owner can tap under the message box; {"action":"template","remove":"<its title>"} deletes one. '
  + '{"action":"preset","preset":"careful|balanced|handsOff"} switches the safety preset: careful asks before every page, read, send, post or payment; balanced browses and reads freely and asks before sending, posting, deleting or paying; handsOff also sends, posts and changes connected apps without asking (payments and deletes still ask). '
  + '{"action":"briefing","at":"<HH:MM>"} turns on the daily briefing (the primary bot sums up what was done, what waits on the owner, what is coming and what failed, from the real records); {"action":"briefing","stop":true} turns it off. Use this, not a schedule, for a daily briefing or summary of the bots\' work. '
  + '{"action":"forget","bot":"<bot name>"} clears what that bot has learned (its memory notes), not its job. '
  + '{"action":"disconnect","connector":"<connector name>"} removes a connected service. {"action":"reconnect","connector":"<connector name>"} checks a connector that is not ready again, or has the owner sign in to it again. {"action":"connect","app":"<an app such as GitHub, Notion, Slack or Linear>"} connects an app with one tap, as the Connectors page does. '
  + '{"action":"thread","thread":"<words from its title>","name":"<new title>"} renames a thread; with "remove":true instead of a name it deletes the thread. {"action":"thread","new":true,"name":"<title>","message":"<the first message>"} starts a new thread for a separate piece of work. {"action":"memory","rule":"<words from a line the bots keep>","text":"<the new line>"} rewrites one line of the company notebook (add "bot" for that bot\'s own notes); "remove":true deletes it. '
  + '{"action":"remove","bot":"<bot name>"} removes a bot the owner no longer wants, with its chat and schedules (never Atlas). '
  + '{"action":"signin","site":"reddit.com"} gives the owner a button that opens the browser on this computer at that site, in their hands, to sign in once; use it when a site blocks you or needs the owner signed in (Reddit, LinkedIn, a shop or bank login), instead of only saying it is blocked. Never ask for a password in chat. ' + `{"action":"open","page":"${PAGE_LIST.replace(/, /g, '|')}"}` + ' shows the owner a Settings page, for things only they can do, such as pasting a key or pairing a computer ("devices" is the computers that run the browser, not bots). Every change to a bot (its job, name, settings, model, rules, schedules, removing it) is one of the blocks above, never a page to open; "gmail", "drive" or "calendar" is a button that connects that Google app, so use it whenever the owner wants email, Drive or their calendar connected. '
  + 'Nothing changes until the owner taps Apply on the card, so say in your reply what you proposed and why. Never ask for a key or password in chat.';

const short80 = text => { const t = String(text ?? '').replace(/\s+/g, ' ').trim(); return t.length > 80 ? `${t.slice(0, 80)}…` : t; };
const lower = value => String(value ?? '').trim().toLowerCase();
/** The HH:MM a briefing task runs at. */
const briefingAt = (state, id) => (state?.tasks || []).find(t => t?.id === id)?.payload?.at || '';
const has = value => value !== undefined && value !== null && value !== '';
const ENGINE_WORDS = {claude: 'claude', anthropic: 'claude', chatgpt: 'codex', codex: 'codex', openai: 'codex'};

/** Read every setup block. Each is {ok, request} or {ok: false, error}. */
export function parseSetupRequests(output) {
  const found = [];
  for (const match of String(output ?? '').matchAll(controlFence('setup'))) {
    if (found.length >= MAX_BLOCKS) { found.push({ok: false, error: `a reply may carry at most ${MAX_BLOCKS} setup blocks, so the rest were not offered. Offer them in your next reply.`}); break; }
    let body;
    try { body = JSON.parse(match[1].trim()); } catch { found.push({ok: false, error: 'the setup block was not valid JSON.'}); continue; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) { found.push({ok: false, error: 'the setup block was not an object.'}); continue; }
    const action = lower(body.action);
    if (!SETUP_ACTIONS.includes(action)) { found.push({ok: false, error: `"${cleanText(body.action, 40) || 'nothing'}" is not something setup can do. Use ${SETUP_ACTIONS.join(', ')}.`}); continue; }
    found.push({ok: true, request: {action, bot: cleanText(body.bot, 60), provider: cleanText(body.provider, 80), model: cleanText(body.model, 120), job: cleanText(body.job, MAX_JOB + 1), page: lower(body.page), name: cleanText(body.name, 81), team: cleanText(body.team, 80), settings: body.settings && typeof body.settings === 'object' && !Array.isArray(body.settings) ? body.settings : null, do: lower(body.do), site: cleanText(body.site, 300), choice: lower(body.choice), what: cleanText(body.do, 2000), every: body.every ?? null, at: cleanText(body.at, 8), on: cleanText(body.on, 12), stop: body.stop === true,
      // The newer cards: asking first, run limits, a connector, a thread.
      ...(body.ask !== undefined ? {ask: typeof body.ask === 'boolean' ? body.ask : lower(body.ask)} : {}),
      ...Object.fromEntries(LIMIT_KEYS.filter(k => body[k] !== undefined).map(k => [k, typeof body[k] === 'number' ? body[k] : lower(body[k])])),
      ...(body.connector !== undefined ? {connector: cleanText(body.connector, 80)} : {}),
      ...(body.thread !== undefined ? {thread: cleanText(body.thread, 160)} : {}), remove: body.remove === true,
      // A connector tool rule, a catalogue app, a memory line, a new thread, a schedule to change, asking between steps.
      ...(body.tool !== undefined ? {tool: cleanText(body.tool, 128)} : {}), ...(body.app !== undefined ? {app: cleanText(body.app, 80)} : {}),
      ...(body.rule !== undefined ? {rule: cleanText(body.rule, 240)} : {}), ...(body.text !== undefined ? {text: cleanText(body.text, 241)} : {}),
      ...(body.message !== undefined ? {message: cleanText(body.message, 4001)} : {}), create: body.new === true || body.create === true,
      ...(body.change !== undefined ? {change: cleanText(body.change, 200)} : {}),
      ...(body.askCheckpoints !== undefined ? {askCheckpoints: typeof body.askCheckpoints === 'boolean' ? body.askCheckpoints : lower(body.askCheckpoints)} : {}),
      ...(body.effort !== undefined && body.effort !== null ? {effort: lower(body.effort)} : {})}});
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
    if (['bots', 'bot', 'team', 'teams', 'company'].includes(request.page)) return {ok: false, error: 'bots are changed with a card, not a page: send {"action":"remove","bot":"<name>"} to remove one, or the job, rename, settings, model, rule or schedule block.'};
    const page = SETUP_PAGES[request.page];
    if (!page) return {ok: false, error: `there is no "${request.page || 'blank'}" page to open. Use ${PAGE_LIST}.`};
    // Gmail, Drive and Calendar are Google's own MCP servers: the card is the Connect button for that app.
    if (googleApp(request.page)) return connectCard(state, {app: googleApp(request.page)}, speaker);
    return {ok: true, card: {action: 'open', section: page[0], text: `Settings → ${page[1]}`}};
  }
  if (request.action === 'signin') {
    const url = signinUrl(request.site || request.url);
    if (!url) return {ok: false, error: `"${request.site || request.url || 'blank'}" is not a public site to sign in to. Name it like reddit.com.`};
    const botId = speaker?.id || primaryOf(state)?.id;
    if (!botId) return {ok: false, error: 'there is no bot whose browser to open.'};
    return {ok: true, card: {action: 'signin', botId, url, text: `Sign in to ${new URL(url).hostname.replace(/^www\./, '')} in this computer's browser. Bots use the same browser, so they can read it once you are signed in.`}};
  }
  if (request.action === 'job') {
    const bot = botNamed(state, request.bot, speaker);
    if (!bot) return {ok: false, error: `there is no bot called "${request.bot || 'blank'}".`};
    const job = String(request.job || '').trim();
    if (job.length < MIN_JOB || job.length > MAX_JOB) return {ok: false, error: `a job is ${MIN_JOB} to ${MAX_JOB} characters.`};
    return {ok: true, card: {action: 'job', botId: bot.id, job, text: `New job for ${bot.name}: “${job.length > JOB_LINE ? `${job.slice(0, JOB_LINE)}…` : job}”`}};
  }
  if (request.action === 'remove') {
    const bot = botNamed(state, request.bot, speaker);
    if (!bot) return {ok: false, error: `there is no bot called "${request.bot || 'blank'}". The bots are: ${companyBots(state).map(b => b.name).join(', ')}.`};
    if (bot.id === primaryOf(state)?.id) return {ok: false, error: `${bot.name} runs the company and cannot be removed.`};
    return {ok: true, card: {action: 'remove', botId: bot.id, text: `Remove ${bot.name}, with its chat and schedules`}};
  }
  if (request.action === 'team') return teamCard(state, request, speaker);
  if (request.action === 'pause') return {ok: true, card: {action: 'pause', text: 'Pause every bot until you resume them'}};
  if (request.action === 'limits') return limitsCard(state, request);
  if (request.action === 'basics') {
    const yes = {true: true, yes: true, on: true, false: false, no: false, off: false}[lower(request.ask)];
    if (typeof request.ask !== 'boolean' && yes === undefined) return {ok: false, error: 'say "ask": true to ask before every page and app read, or false to browse and read without asking.'};
    request = {...request, ask: typeof request.ask === 'boolean' ? request.ask : yes};
    return {ok: true, card: {action: 'basics', ask: request.ask, text: request.ask ? 'Every bot asks you before it opens a web page or reads a connected app' : 'Bots open web pages and read connected apps without asking; sending, posting, deleting and paying still ask'}};
  }
  if (request.action === 'template') {
    const list = Array.isArray(state?.templates) ? state.templates : [];
    if (typeof request.remove === 'string' && request.remove.trim()) {
      const want = lower(request.remove);
      const hit = list.find(t => lower(t.title) === want) || list.find(t => lower(t.title).includes(want) || lower(t.text).includes(want));
      if (!hit) return {ok: false, error: `there is no saved template called "${request.remove}". ${list.length ? `The saved ones are: ${list.map(t => t.title).join(', ')}.` : 'None are saved yet.'}`};
      return {ok: true, card: {action: 'template', remove: true, templateId: hit.id, text: `Delete the template “${hit.title}”`}};
    }
    const text = String(request.text ?? '').trim();
    if (text.length < 3 || text.length > 4000) return {ok: false, error: 'a template is a message of 3 to 4000 characters, in "text".'};
    // The title the saved template will carry (the server shortens it the same way), so the card shows what is saved.
    const title = templateTitle(String(request.title ?? '').trim() || text);
    return {ok: true, card: {action: 'template', title, templateText: text, text: `Save the template “${title}”: ${text.length > JOB_LINE ? `${text.slice(0, JOB_LINE)}…` : text}`}};
  }
  if (request.action === 'preset') {
    const want = lower(request.preset).replace(/[\s_-]+/g, '');
    const preset = PRESETS.find(p => p.id.toLowerCase() === want || p.name.toLowerCase().replace(/[\s_-]+/g, '') === want);
    if (!preset) return {ok: false, error: 'the presets are careful, balanced and handsOff.'};
    return {ok: true, card: {action: 'preset', preset: preset.id, text: `Switch to ${preset.name}: ${preset.text}`}};
  }
  if (request.action === 'briefing') {
    const on = briefingSchedule(state);
    if (request.stop === true) {
      if (!on) return {ok: false, error: 'the daily briefing is not on.'};
      return {ok: true, card: {action: 'briefing', stop: true, taskId: on.id, text: 'Turn off the daily briefing'}};
    }
    const at = cleanAt(has(request.at) ? request.at : '08:00');
    if (!at) return {ok: false, error: `"${request.at}" is not a time of day. Use HH:MM, such as 08:00.`};
    if (on && briefingAt(state, on.id) === at) return {ok: false, error: `the daily briefing is already on at ${at}.`};
    if (on) return {ok: true, card: {action: 'briefing', at, replaces: on.id, text: `Move the daily briefing to ${at} every day (it is ${on.when} now)`}};
    return {ok: true, card: {action: 'briefing', at, text: `Turn on the daily briefing every day at ${at}`}};
  }
  if (request.action === 'forget') {
    const bot = botNamed(state, request.bot, speaker);
    if (!bot) return {ok: false, error: `there is no bot called "${request.bot || 'blank'}".`};
    return {ok: true, card: {action: 'forget', botId: bot.id, text: `Forget what ${bot.name} has learned (its job stays)`}};
  }
  if (request.action === 'disconnect') {
    const list = (state?.connectors || []).filter(c => c?.id), want = lower(request.connector || request.name);
    const hit = want && (list.find(c => lower(c.id) === want) || list.find(c => lower(c.name) === want) || list.find(c => lower(c.name).includes(want)));
    if (!hit) return {ok: false, error: list.length ? `there is no connector called "${cleanText(request.connector, 60) || 'blank'}". Connected: ${list.map(c => c.name || c.id).join(', ')}.` : 'nothing is connected.'};
    return {ok: true, card: {action: 'disconnect', connectorId: hit.id, text: `Remove the ${hit.name || hit.id} connector`}};
  }
  if (request.action === 'thread') return threadCard(state, request);
  if (request.action === 'reconnect') return reconnectCard(state, request);
  if (request.action === 'connect') return connectCard(state, request, speaker);
  if (request.action === 'memory') return memoryCard(state, request, speaker);
  if (request.action === 'schedule') return scheduleCard(state, request, speaker);
  if (request.action === 'rename' || request.action === 'settings' || request.action === 'rule') {
    const bot = botNamed(state, request.bot, speaker);
    if (!bot) return {ok: false, error: `there is no bot called "${request.bot || 'blank'}".`};
    if (request.action === 'rename') return renameCard(state, bot, request.name);
    if (request.action === 'settings') return settingsCard(state, bot, request.settings, speaker);
    return request.do === 'connector' ? connectorRuleCard(state, bot, request) : ruleCard(bot, request);
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
  // A colour is named ("blue"); the bot never has to know the palette's numbers.
  const colour = wanted && (wanted.colour ?? wanted.color);
  if (colour !== undefined) {
    const at = typeof colour === 'number' ? colour : COLOR_NAMES.indexOf(lower(colour));
    if (!Number.isInteger(at) || !COLOR_NAMES[at]) return {ok: false, error: `"${cleanText(String(colour), 30)}" is not one of the colours: ${COLOR_NAMES.join(', ')}.`};
    picked.tint = at;
  }
  if (Object.hasOwn(picked, 'shape') && !SHAPES.includes(lower(picked.shape))) return {ok: false, error: `"${cleanText(String(picked.shape), 30)}" is not a shape. Use ${SHAPES.join(', ')}.`};
  if (Object.hasOwn(picked, 'shape')) picked.shape = lower(picked.shape);
  if (!Object.keys(picked).length) return {ok: false, error: `nothing to change. A bot may set ${[...BOT_SETTABLE.filter(k => k !== 'tint'), 'colour'].join(', ')}.`};
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
    tint: v => (v === null ? 'the default colour' : `${COLOR_NAMES[v] || 'a new'} colour`), shape: v => (v ? `${v} shape` : 'the default shape'),
  };
}
const TEAM_WORDS = {
  checkpoints: v => (v ? 'asks you before each step' : 'runs every step without asking'),
  maxSteps: v => `at most ${v} steps`, botHandoffs: v => (v ? 'its bots may hand work to each other' : 'no hand-offs between its bots'),
  routing: v => ({pipeline: 'its bots answer in order', mentions: 'only the first bot answers unless one is @mentioned', everyone: 'every bot answers'}[v] || `routing ${v}`),
  confirmPlan: v => (v ? 'shows the plan before it starts' : 'starts without showing the plan'),
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

/** How much of a job a job card's line shows; the rest is folded under it (setupDetail). */
const JOB_LINE = 240;

function ruleCard(bot, request) {
  const act = RULE_WORDS[request.do];
  if (!act) return {ok: false, error: `a rule is for open, send, post, delete or spend, not "${request.do || 'blank'}".`};
  const choice = request.choice === 'allow' ? 'always' : request.choice;
  if (!GRANT_CHOICES.includes(choice)) return {ok: false, error: 'a rule is always, ask or deny.'};
  let scope = '';
  if (act === 'spend' && choice === 'always' && !String(request.site || '').trim()) return {ok: false, error: 'a payment Always allow is for one site; name it, like shop.example.com.'};
  if (PER_SITE.includes(act) || (act === 'spend' && String(request.site || '').trim())) {
    const site = String(request.site || '').trim();
    scope = scopeOf({action: act, target: /^https?:\/\//i.test(site) ? site : `https://${site}`});
    if (!site || !scope) return {ok: false, error: 'name the site the rule is for, like github.com.'};
  }
  // Always allow on payments is confirmed before it is applied, with the words the ask card uses (ui-conversation.js).
  return {ok: true, card: {action: 'rule', botId: bot.id, act, scope, choice, text: `${bot.name}: ${GRANT_LABELS[choice]} · ${grantWhat(act, scope)}`,
    ...(act === 'spend' && choice === 'always' ? {confirmAlways: payAlwaysText(bot.name, scope)} : {})}};
}

function limitsCard(state, request) {
  const limits = {};
  for (const key of LIMIT_KEYS) {
    if (!Object.hasOwn(request, key)) continue;
    const value = request[key];
    if (value === null || ['none', 'no limit', 'off', 'unlimited'].includes(lower(value))) { limits[key] = null; continue; }
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > BACKSTOP[key]) return {ok: false, error: `${LIMIT_WORDS[key]} is a whole number from 1 to ${BACKSTOP[key]}, or "none".`};
    limits[key] = n;
  }
  if (Object.hasOwn(request, 'askCheckpoints')) {
    const on = typeof request.askCheckpoints === 'boolean' ? request.askCheckpoints : {true: true, yes: true, on: true, false: false, no: false, off: false}[lower(request.askCheckpoints)];
    if (on === undefined) return {ok: false, error: '"askCheckpoints" is true (ask the owner between bot-to-bot steps) or false.'};
    limits.askCheckpoints = on;
  }
  if (!Object.keys(limits).length) return {ok: false, error: `say which limit to change: ${[...LIMIT_KEYS, 'askCheckpoints'].join(', ')}.`};
  return {ok: true, card: {action: 'limits', limits, text: `Limits: ${Object.entries(limits).map(([k, v]) => (k === 'askCheckpoints' ? `${v ? '' : "don't "}${LIMIT_WORDS[k]}` : `${LIMIT_WORDS[k]} ${v === null ? 'no limit' : v}`)).join(', ')}`}};
}

function threadCard(state, request) {
  if (request.create || request.new === true) {
    const name = cleanText(request.name, 80), message = String(request.message || request.what || '').trim();
    if (!message || message.length > 4000) return {ok: false, error: 'a new thread needs its first message in "message" (up to 4000 characters), and a title in "name".'};
    return {ok: true, card: {action: 'thread', create: true, ...(name ? {name} : {}), message, text: `Start a thread${name ? ` “${name}”` : ''}: ${short(message, 200)}`}};
  }
  const threads = (state?.groups || []).filter(g => g?.settings?.kind === 'thread'), want = lower(request.thread);
  // "the Goa trip thread" finds "Plan a 3 day Goa trip": every word that names it is in the title.
  const words = want.split(/[^\p{L}\p{N}]+/u).filter(w => w && !['the', 'a', 'an', 'my', 'thread', 'about', 'on', 'for', 'chat'].includes(w));
  const exact = threads.filter(g => lower(g.name) === want);
  const hits = !want ? [] : exact.length ? exact : threads.filter(g => words.length && words.every(w => lower(g.name).includes(w)));
  if (hits.length !== 1) return {ok: false, error: threads.length ? `say which thread with words from its title. Threads: ${threads.slice(-10).map(g => `"${g.name}"`).join(', ')}.` : 'there are no threads.'};
  const thread = hits[0];
  if (request.remove) return {ok: true, card: {action: 'thread', groupId: thread.id, remove: true, text: `Delete the thread “${thread.name}” and its messages`}};
  const name = cleanText(request.name, 80);
  if (!name) return {ok: false, error: 'give the thread a new title in "name", or "remove":true to delete it.'};
  return {ok: true, card: {action: 'thread', groupId: thread.id, name, text: `Rename the thread “${thread.name}” to “${name}”`}};
}

/** The whole text a card's line shortens, for the card to show folded: a job longer than its line. Else ''. */
export const setupDetail = card => (card?.action === 'job' && typeof card.job === 'string' && card.job.length > JOB_LINE ? card.job : '');
/** The confirmation a card needs before it is applied: an Always allow on payments for a site. Else ''. A card
 * read back from a message is checked again here, so a rule without the text still confirms. */
export const setupConfirm = (card, botName = 'This bot') => (card?.action === 'rule' && card.act === 'spend' && card.choice === 'always'
  ? (typeof card.confirmAlways === 'string' && card.confirmAlways) || payAlwaysText(botName, card.scope) : '');

/** The card a setup message carries, read back safely. Anything malformed is null, so no button is painted. */
export function setupCardOf(message) {
  let card;
  try { card = typeof message?.setup === 'string' ? JSON.parse(message.setup) : message?.setup; } catch { return null; }
  if (!card || typeof card !== 'object' || !SETUP_ACTIONS.includes(card.action)) return null;
  if (card.action === 'open') return Object.values(SETUP_PAGES).some(([key]) => key === card.section) ? card : null;
  if (card.action === 'signin') return typeof card.botId === 'string' && signinUrl(card.url) === card.url && typeof card.text === 'string' ? card : null;
  if (card.action === 'job') return typeof card.botId === 'string' && typeof card.job === 'string' ? card : null;
  if (card.action === 'rename') return typeof card.botId === 'string' && typeof card.name === 'string' ? card : null;
  if (card.action === 'settings') return typeof card.botId === 'string' && card.settings && typeof card.settings === 'object' && Object.keys(card.settings).length && Object.keys(card.settings).every(k => BOT_SETTABLE.includes(k)) ? card : null;
  if (card.action === 'team') return typeof card.groupId === 'string' && card.settings && typeof card.settings === 'object' && Object.keys(card.settings).length && Object.keys(card.settings).every(k => TEAM_SETTABLE.includes(k)) ? card : null;
  if (card.action === 'remove' || card.action === 'forget') return typeof card.botId === 'string' ? card : null;
  if (card.action === 'pause') return card;
  if (card.action === 'template') return card.remove === true ? (typeof card.templateId === 'string' ? card : null) : typeof card.title === 'string' && typeof card.templateText === 'string' && card.templateText.trim() ? card : null;
  if (card.action === 'preset') return PRESETS.some(p => p.id === card.preset) ? card : null;
  if (card.action === 'briefing') return card.stop === true ? (typeof card.taskId === 'string' ? card : null) : typeof card.at === 'string' && cleanAt(card.at) === card.at && (card.replaces === undefined || typeof card.replaces === 'string') ? card : null;
  if (card.action === 'basics') return typeof card.ask === 'boolean' ? card : null;
  if (card.action === 'disconnect') return typeof card.connectorId === 'string' ? card : null;
  if (card.action === 'thread') return card.create === true ? (typeof card.message === 'string' && card.message.trim() ? card : null) : typeof card.groupId === 'string' && (card.remove === true || typeof card.name === 'string') ? card : null;
  if (card.action === 'limits') return card.limits && typeof card.limits === 'object' && Object.keys(card.limits).length && Object.entries(card.limits).every(([k, v]) => (k === 'askCheckpoints' ? typeof v === 'boolean' : LIMIT_KEYS.includes(k) && (v === null || (Number.isInteger(v) && v >= 1 && v <= BACKSTOP[k])))) ? card : null;
  if (card.action === 'schedule') return typeof card.botId === 'string' && (card.stop ? typeof card.taskId === 'string' : typeof card.groupId === 'string' && typeof card.message === 'string' && (Number.isInteger(card.every) || Boolean(cleanAt(card.at))) && (card.replaces === undefined || typeof card.replaces === 'string')) ? card : null;
  if (card.action === 'rule') return typeof card.botId === 'string' && isAskAction(card.act) && GRANT_CHOICES.includes(card.choice) && typeof card.scope === 'string' ? card : null;
  if (card.action === 'reconnect') return typeof card.connectorId === 'string' && (card.app === undefined || Boolean(appById(card.app)?.oauth)) ? card : null;
  if (card.action === 'connect') return appById(card.app) && !appById(card.app).google ? card : null;
  if (card.action === 'memory') return typeof card.ruleId === 'string' && typeof card.bot === 'string' && (card.remove === true || typeof card.newText === 'string') ? card : null;
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
  if (request.change) return changeScheduleCard(state, bot, request);
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
/** A connector by its id or name (or a word of its name). */
const connectorNamed = (list, name) => { const want = lower(name); return want ? list.find(c => lower(c.id) === want) || list.find(c => lower(c.name) === want) || list.find(c => lower(c.name).includes(want)) || null : null; };
const connectedList = list => (list.length ? `Connected: ${list.map(c => c.name || c.id).join(', ')}.` : 'nothing is connected.');

/** A rule for one connector: a write tool is its own rule (connector.<id>.write.<tool>), and reading is one rule
 * for the whole account (connector.<id>.read). The scope is the account, as the ask names it. */
function connectorRuleCard(state, bot, request) {
  const list = (state?.connectors || []).filter(c => c?.id && c.kind !== 'site');
  const hit = connectorNamed(list, request.connector);
  if (!hit) return {ok: false, error: `there is no connector called "${cleanText(request.connector, 60) || 'blank'}". ${connectedList(list)}`};
  const choice = request.choice === 'allow' ? 'always' : request.choice;
  if (!GRANT_CHOICES.includes(choice)) return {ok: false, error: 'a rule is always, ask or deny.'};
  const tools = hit.actions || [];
  const tool = request.tool ? tools.find(a => a.name === request.tool) || tools.find(a => lower(a.name) === lower(request.tool)) : null;
  if (request.tool && !tool) return {ok: false, error: `${hit.name} has no tool "${cleanText(request.tool, 60)}". Its tools: ${tools.map(a => a.name).join(', ') || 'none'}.`};
  const act = `connector.${hit.id}.${tool?.write ? `write.${tool.name}` : 'read'}`;
  const scope = scopeOf({action: act, target: String(hit.account || hit.name || hit.id)});
  if (!isAskAction(act) || !scope) return {ok: false, error: `${hit.name} cannot take a rule.`};
  return {ok: true, card: {action: 'rule', botId: bot.id, act, scope, choice, text: `${bot.name}: ${GRANT_LABELS[choice]} · ${grantWhat(act, scope)}`}};
}

/** Check a connector again; one that signed in with the app's own sign-in and needs it again opens that sign-in. */
function reconnectCard(state, request) {
  const list = (state?.connectors || []).filter(c => c?.id);
  const hit = connectorNamed(list, request.connector || request.name || request.app);
  if (!hit) return {ok: false, error: `there is no connector called "${cleanText(request.connector || request.app, 60) || 'blank'}". ${connectedList(list)}`};
  const app = hit.kind === 'mcp' && hit.status === 'reconnect' && appById(hit.app)?.oauth ? hit.app : undefined;
  return {ok: true, card: {action: 'reconnect', connectorId: hit.id, ...(app ? {app} : {}), text: app ? `Sign in to ${hit.name} again` : `Check ${hit.name} again and reconnect it`}};
}

/** Connect an app from the catalogue with the same one tap the Connectors page uses. "Google" is Gmail. */
function connectCard(state, request) {
  const want = lower(request.app || request.connector || request.name);
  const id = googleApp(want) || want;
  const app = APPS.find(a => a.id === id) || APPS.find(a => lower(a.name) === want) || null;
  if (!app) return {ok: false, error: `"${cleanText(request.app, 40) || 'blank'}" is not in the catalogue. Apps: ${APPS.map(a => a.name).join(', ')}.`};
  return {ok: true, card: {action: 'connect', app: app.id, text: `Connect ${app.name}`}};
}

const rulesOf = (state, key) => { const books = state?.memory?.rulebooks; return books && Object.hasOwn(books, key) && Array.isArray(books[key]?.rules) ? books[key].rules : []; };
/** Rewrite or delete one line the bots keep: in the company notebook, or in one bot's own notes when "bot" names it. */
function memoryCard(state, request, speaker) {
  const bot = request.bot ? botNamed(state, request.bot, speaker) : null;
  if (request.bot && !bot) return {ok: false, error: `there is no bot called "${request.bot}".`};
  const rules = rulesOf(state, bot ? `bot:${bot.id}` : 'company'), want = lower(request.rule);
  const words = want.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const exact = rules.filter(r => lower(r.text) === want);
  const hits = !want ? [] : exact.length ? exact : rules.filter(r => words.length && words.every(w => lower(r.text).includes(w)));
  const book = bot ? `${bot.name}'s notes` : 'the company notebook';
  if (hits.length !== 1) return {ok: false, error: rules.length ? `say which line with words from it in "rule". In ${book}: ${rules.slice(0, 12).map(r => `"${short(r.text, 80)}"`).join(', ')}.` : `${book} is empty.`};
  const [rule] = hits, base = {action: 'memory', bot: bot ? bot.id : 'company', ruleId: rule.id};
  if (request.remove) return {ok: true, card: {...base, remove: true, text: `Delete from ${book}: “${short(rule.text, 160)}”`}};
  const next = String(request.text ?? '').trim();
  if (next.length < 4 || next.length > 240) return {ok: false, error: 'the new line in "text" is 4 to 240 characters, or send "remove":true to delete it.'};
  return {ok: true, card: {...base, newText: next, text: `Change in ${book}: “${short(rule.text, 120)}” to “${short(next, 120)}”`}};
}

/** Move a schedule to a new time or a new rhythm: applied, the new one replaces the old one. What is not given stays. */
function changeScheduleCard(state, bot, request) {
  const words = lower(request.change), mine = scheduleRows(state, bot.id);
  const hits = mine.filter(r => lower(r.what).includes(words));
  if (hits.length !== 1) return {ok: false, error: mine.length ? `say which schedule to change with a few of its words in "change". ${bot.name} has: ${mine.map(r => `"${r.what}" ${r.when}`).join('; ')}.` : `${bot.name} has no schedule to change.`};
  const task = (state.tasks || []).find(t => t.id === hits[0].id), old = task?.payload || {};
  const given = value => value !== undefined && value !== null && value !== '';
  const on = given(request.on) ? cleanDay(request.on) : given(request.every) ? '' : cleanDay(old.on) || '';
  if (given(request.on) && !on) return {ok: false, error: `"${request.on}" is not a day of the week. Use monday to sunday.`};
  const every = given(request.every) ? everyMinutes(request.every) : given(request.on) ? 10080 : old.kind === 'interval' ? old.intervalMinutes : undefined;
  if (every === null) return {ok: false, error: `"${request.every}" is not how often. Use day, hour, week, or a number of minutes (at least ${MIN_EVERY} minutes, at most ${MAX_EVERY}).`};
  if (on && every !== 10080) return {ok: false, error: 'a day of the week goes with every week.'};
  const at = given(request.at) ? cleanAt(request.at) : cleanAt(old.at);
  if (given(request.at) && !at) return {ok: false, error: `"${request.at}" is not a time of day. Use HH:MM, such as 08:00.`};
  if (!every && !at) return {ok: false, error: 'say the new time in "at" or how often in "every".'};
  const message = String(request.what || '').trim().length >= 3 ? String(request.what).trim() : String(old.message || hits[0].what);
  return {ok: true, card: {action: 'schedule', replaces: task.id, botId: bot.id, groupId: old.groupId, message, ...(every ? {every} : {}), ...(at ? {at} : {}), ...(on ? {on} : {}), text: `Change ${bot.name}: “${short(message, 160)}” to ${whenWords({every, at, on})} (was ${hits[0].when})`}};
}

export function setupDone(state, card) {
  if (!card || card.action === 'open' || card.action === 'signin') return false;
  if (card.action === 'remove') return !companyBots(state).some(b => b.id === card.botId);
  if (card.action === 'pause') return state?.guard?.paused === true;
  if (card.action === 'basics') return Boolean(state?.askBasics) === card.ask;
  if (card.action === 'template') { const list = state?.templates || []; return card.remove ? !list.some(t => t.id === card.templateId) : list.some(t => t.text === card.templateText); }
  if (card.action === 'preset') return presetOf(state) === card.preset;
  if (card.action === 'briefing') { const on = briefingSchedule(state); return card.stop ? !on : Boolean(on) && (!card.replaces || briefingAt(state, on.id) === card.at); }
  if (card.action === 'limits') { const now = limitsOf(state); return Object.entries(card.limits).every(([k, v]) => now[k] === v); }
  if (card.action === 'forget') return !(state?.memory?.rulebooks?.[`bot:${card.botId}`]?.rules?.length);
  if (card.action === 'disconnect') return !(state?.connectors || []).some(c => c?.id === card.connectorId);
  if (card.action === 'thread' && card.create) return false;
  if (card.action === 'thread') { const g = (state?.groups || []).find(x => x.id === card.groupId); return card.remove ? !g : g?.name === card.name; }
  if (card.action === 'reconnect') return (state?.connectors || []).find(c => c?.id === card.connectorId)?.status === 'ready';
  if (card.action === 'connect') return (state?.connectors || []).some(c => c?.app === card.app);
  if (card.action === 'memory') { const rule = rulesOf(state, card.bot === 'company' ? 'company' : `bot:${card.bot}`).find(r => r.id === card.ruleId); return card.remove ? !rule : rule?.text === card.newText; }
  if (card.action === 'job') return companyBots(state).find(b => b.id === card.botId)?.instructions === card.job;
  if (card.action === 'schedule') {
    const rows = scheduleRows(state, card.botId);
    if (card.replaces) return !rows.some(r => r.id === card.replaces) && rows.some(r => r.what === card.message);
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
export const setupButton = card => (card.action === 'template' ? (card.remove ? 'Delete' : 'Save template') : card.action === 'preset' ? 'Switch' : card.action === 'briefing' ? (card.stop ? 'Stop briefing' : card.replaces ? 'Move' : 'Turn on') : (card.action === 'reconnect' ? (card.app ? 'Sign in again' : 'Reconnect') : card.action === 'connect' ? 'Connect' : card.action === 'memory' && card.remove ? 'Delete' : card.action === 'thread' && card.create ? 'Start' : card.action === 'signin' ? 'Sign in' : card.app === 'google' ? 'Connect Google' : card.action === 'open' ? `Open ${card.text.replace(/^Settings → /, '')}` : card.action === 'remove' || card.action === 'disconnect' ? 'Remove' : card.action === 'forget' ? 'Forget' : card.action === 'thread' && card.remove ? 'Delete' : card.action === 'pause' ? 'Pause' : 'Apply'));

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
  const everyBot = companyBots(state);
  // How each bot looks, in the words a colour or shape card uses, so "make Scout blue" needs no lookup.
  const lookOf = (b, i) => {
    const set = b.settings || {}, tint = Number.isInteger(set.tint) ? set.tint : i;
    const manager = everyBot.some(x => x.settings?.reportsTo === b.id);
    return `${COLOR_NAMES[Math.abs(tint) % COLOR_NAMES.length]} ${SHAPES.includes(set.shape) ? set.shape : set.lead === true ? 'circle' : manager ? 'hexagon' : 'rounded'}`;
  };
  const bots = everyBot.map((b, i) => {
    const own = ai.bots?.[b.id] || {};
    const model = (own.providerId ? `${label(own.providerId) || 'a removed model'}${own.model ? ` · ${own.model}` : ''}` : 'the default') + (own.effort ? ` · ${own.effort} effort` : '');
    // Only what differs from a new bot, in the words a card uses; "off" stays its own flag.
    const set = botSettings(b), words = botWords(state);
    const changed = BOT_SETTABLE.filter(k => !['enabled', 'tint', 'shape'].includes(k) && (set[k] ?? null) !== (BOT_DEFAULTS[k] ?? null)).map(k => words[k](set[k]));
    return {name: b.name, job: short(b.instructions, 140) || 'no job yet', model, look: lookOf(b, i), ...(set.enabled === false ? {off: true} : {}), ...(changed.length ? {settings: changed.join(', ')} : {})};
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
    ...(state?.guard?.paused ? {paused: true} : {}),
    running: state?.guard?.paused ? 'every bot is paused; the owner resumes them with Resume on the banner' : 'every bot is running; nothing is paused',
    limits: (() => { const l = limitsOf(state); return LIMIT_KEYS.map(k => `${l[k] ?? `no limit (at most ${BACKSTOP[k]})`}${k === 'pages' ? ' pages per reply' : k === 'rounds' ? ' rounds of pages' : ' team steps'}`).join(', '); })(),
    basicAccess: (state?.askBasics ? 'every bot asks the owner before opening a web page or reading a connected app' : 'every bot opens web pages and reads connected apps without asking; sending, posting, deleting and paying ask') + (state?.handsOff === true ? '. Hands-off is on: a send, a post or a connected-app change with no rule goes without asking; payments and deletes still ask' : ''),
    rules: rules.length ? rules : 'none',
    waitingOnOwner: waiting.length ? waiting : 'nothing',
    threads: threads.length ? threads : 'none',
    schedules: schedules.length ? schedules : 'none',
    templates: (state?.templates || []).slice(0, 20).map(t => `${t.title}: ${short80(t.text)}`),
    preset: ({careful: 'Careful', balanced: 'Balanced', handsOff: 'Hands-off'})[presetOf(state)] || 'Custom (the owner set rules by hand)',
    briefing: (() => { const on = briefingSchedule(state); return on ? `on, ${on.when}` : 'off'; })(),
    fallbackModel: ai.fallback?.providerId ? `${label(ai.fallback.providerId) || 'a removed model'}${ai.fallback.model ? ` · ${ai.fallback.model}` : ''} answers when a bot's model is down, busy or out of credit` : 'none',
    usageThisMonth: (() => {
      const m = monthByBot(state, new Map(companyBots(state).map(b => [b.id, b.name])));
      const day = Object.values(state?.usage?.days?.[new Date().toISOString().slice(0, 10)] || {});
      const tokens = day.reduce((n, u) => n + tokensOf(u), 0), calls = day.reduce((n, u) => n + (Number(u?.calls) || 0), 0);
      const today = tokens ? `${shortCount(tokens)} tokens in ${calls} model calls today (the day in UTC)` : 'nothing used today (the day in UTC)';
      return {today, total: m.total.tokens ? `${shortCount(m.total.tokens)} tokens in ${m.total.calls} model calls` : 'nothing used yet', byBot: m.rows.slice(0, 12).map(r => `${r.name}: ${shortCount(r.tokens)} tokens`), where: 'Settings → Usage shows it by bot and day, and the cost for models the owner priced'};
    })(),
    connectors: connectors.length ? connectors.map(c => `${c.name}${c.status && c.status !== 'ready' ? ` (${c.status})` : ''}`) : 'none',
    facts: [
      'Opening a web page and reading a connected app need no answer unless basicAccess or a rule says so; sending, posting, deleting and paying ask the owner unless a rule says Always allow. Rules are in Settings → Permissions.',
      live.length ? 'A computer is connected and runs the browser and the claude and codex sign-in; there is nothing to pair.' : 'No computer is connected now, so pages are read without the shared browser. A server started on the owner\'s own computer connects it by itself; otherwise propose the setup block {"action":"open","page":"devices"}.',
      'Models and keys are added only by the owner, in Settings → Models and keys. Never ask for a key in chat; use the setup block to open that page.',
      'To connect Gmail, Google Drive or Google Calendar, send the setup block {"action":"connect","app":"gmail"} (or "google-drive", "google-calendar"): its button signs the owner in to Google\'s own MCP server, and then you use its tools. Gmail\'s tools write drafts, which the owner sends from Gmail. MCP servers are connected in Settings → Connectors. An MCP server that runs on this computer is added there under On my computer, with the command that starts it; the owner types it, never you.',
      'When a run fails because a model is down or out of quota, propose another connected model with the setup block.',
      'A sentence about how bots should work from now on ("bots should open at most 3 pages", "always ask me before any site", "make Scout blue", "stop all bots") is a change to the setup: answer it with the setup block for it, not by redoing earlier work. Read it as about earlier work only when it plainly names that work.',
    ],
  };
}
