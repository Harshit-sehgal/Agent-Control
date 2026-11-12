/** The rules behind Settings → Connectors, the subscription part of Models and keys, and the
 * connector lines in a chat. Pure functions from what the server sends: no DOM, no globals, so
 * Node tests import them (tests/ui-connect-model.test.js). The markup is in ui-connect.js, ui-admin.js
 * and ui-conversation.js.
 *
 * Nothing here ever sees a key: a subscription has none, an MCP address is typed once and sent, and the
 * server never answers with it. */
import {cleanCliModel, cliEngineById, LOCAL_CLI_KIND, LOCAL_CLI_ENGINES, EFFORT_LEVELS, cleanEffort, CLI_MODELS} from './ai-presets.js?v=e7ef376d24';
import {appById} from './app-catalog.js?v=e7ef376d24';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/* ---------- the redirect back from Google ---------- */

const GOOGLE_REASONS = {
  state: 'That Google sign-in link was not started here, or it ran out. Choose Connect Google again.',
  denied: 'Google sign-in was cancelled, so nothing was connected.',
  code: 'Google did not send back a sign-in code. Try Connect Google again.',
  'no-refresh-token': 'Google did not give this app lasting access. Remove the app from your Google account\'s third-party access, then connect again.',
  setup: 'Save your Google client first, then choose Connect Google.',
  google: 'Google refused the sign-in. Check the client ID, the secret and the redirect address.',
};

/** What the address says about a Google sign-in that just finished (`?google=connected` or
 * `?google=error&reason=<code>`), as a sentence for a toast. Null when it says nothing. The reason is looked up,
 * never echoed. */
const CONNECT_REASONS = {
  state: 'That sign-in link was not started here, or it ran out. Choose Connect again.',
  denied: 'The sign-in was cancelled, so nothing was connected.',
  code: 'The app did not send back a sign-in code. Try Connect again.',
  register: 'The app did not let this app sign in. Try again, or connect it with a token.',
  'no-register': 'That app does not let an app sign in by itself yet. Connect it with a token instead.',
  setup: 'This workspace is not open any more. Sign in to the app again.',
  server: 'The app\'s server could not finish the sign-in. Try again in a moment.',
};
const appName = id => appById(String(id || ''))?.name || 'The app';

export function googleReturn(search) {
  const q = new URLSearchParams(String(search ?? ''));
  // An app's own MCP server signed in to directly: `?connect=connected&app=notion` or `?connect=error&app=...&reason=...`.
  const connect = q.get('connect'), name = appName(q.get('app'));
  if (connect === 'connected') return {ok: true, text: `${name} is connected. Bots use it on your account directly.`};
  if (connect === 'error') return {ok: false, text: `${name}: ${CONNECT_REASONS[q.get('reason')] || CONNECT_REASONS.server}`};
  const result = q.get('google');
  if (result === 'connected') return {ok: true, text: 'Google is connected.'};
  if (result === 'error') return {ok: false, text: GOOGLE_REASONS[q.get('reason')] || 'Google could not be connected. Try again.'};
  return null;
}

/** The query string without the two Google parameters (`''` when nothing else is left). */
export function withoutGoogleParams(search) {
  const q = new URLSearchParams(String(search ?? ''));
  q.delete('google'); q.delete('reason'); q.delete('connect'); q.delete('app');
  const rest = q.toString();
  return rest ? `?${rest}` : '';
}

/* ---------- connectors ---------- */

const STATUSES = {ready: ['Ready', 'good'], setup: ['Not signed in', 'warn'], reconnect: ['Reconnect', 'warn'], error: ['Problem', 'bad']};
/** A connector's status as a label and a tone for the tag. Unknown reads as Ready, like the server's default. */
export const statusOf = status => { const [label, tone] = STATUSES[status] || STATUSES.ready; return {label, tone}; };

/** The MCP servers as rows. Google has a card of its own. */
export function mcpRows(connectors) {
  return (Array.isArray(connectors) ? connectors : []).filter(c => c?.kind === 'mcp').map(c => {
    const actions = Array.isArray(c.actions) ? c.actions : [], writes = actions.filter(a => a.write).length;
    const detail = !actions.length ? 'No tools yet' : `${plural(actions.length, 'tool')}, ${writes ? `${writes} can change things` : 'none change anything'}`;
    const status = c.status || 'ready';
    return {
      id: c.id, name: c.name, status: statusOf(status), detail,
      where: c.transport === 'stdio' ? `On your agent · ${c.agentServer || ''}`.trim() : (c.host || ''),
      message: status === 'ready' ? '' : String(c.statusMessage || ''),
      checkedAt: c.checkedAt || null,
    };
  });
}

/** The Google card from `google` in `GET /api/connectors`. Null when the server gave none (the demo). */
export function googleCard(google) {
  if (!google || typeof google !== 'object' || !('configured' in google)) return null;
  const status = google.status || 'none';
  const state = google.connected ? 'connected' : !google.configured ? 'none' : status === 'reconnect' || status === 'error' ? status : 'ready';
  return {
    state,
    account: google.account || '',
    // The address has a box of its own with a Copy button, so a step that quotes it points at that box instead of printing it twice.
    steps: (Array.isArray(google.steps) ? google.steps : []).map(step => (google.redirectUri ? String(step).split(google.redirectUri).join('the address shown below') : step)),
    redirectUri: google.redirectUri || '',
    testingNote: google.testingNote || '',
    // Connect Google is a link to the server's start route; it needs a saved client first.
    connectLabel: state === 'ready' ? 'Connect Google' : state === 'reconnect' || state === 'error' ? 'Reconnect Google' : null,
    showForm: state === 'none',
  };
}

/* ---------- the add forms ---------- */

const HEADER_LINE = /^([A-Za-z0-9!#$%&'*+.^_`|~-]{1,64})\s*:\s*(.+)$/;
function parseHeaders(text) {
  const headers = {};
  const lines = String(text ?? '').split('\n').map(l => l.trim()).filter(Boolean);
  for (const [i, line] of lines.entries()) {
    const m = HEADER_LINE.exec(line);
    if (!m) return {error: `Header line ${i + 1} should look like Name: value.`};
    headers[m[1]] = m[2].trim();
  }
  return {headers};
}

/** The body for `POST /api/connectors`, or `{ok: false, error}`. Over HTTP it is an address and optional headers;
 * on the agent it is only the name of a server the agent's own machine has set up (the server never takes a command). */
export function mcpDraft(values = {}) {
  const name = String(values.name ?? '').trim();
  if (!name) return {ok: false, error: 'Give the server a name.'};
  if (name.length > 60) return {ok: false, error: 'Keep the name to 60 characters.'};
  if (values.via === 'agent') {
    const command = String(values.command ?? '').trim();
    // With a command, the server is started on this computer first (POST /api/agents/local/mcp), under a name
    // made from the connector's when none is typed.
    const typed = String(values.agentServer ?? '').trim();
    const agentServer = typed || (command ? name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) : '');
    if (!agentServer) return {ok: false, error: 'Type the name the server has on your agent, or the command that starts it on this computer.'};
    if (command) {
      if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(agentServer)) return {ok: false, error: 'On this computer the server name uses lowercase letters, digits and dashes only.'};
      return {ok: true, body: {kind: 'mcp', name, agentServer}, local: {name: agentServer, command}};
    }
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(agentServer)) return {ok: false, error: 'The agent server name uses letters, digits and . _ - only.'};
    return {ok: true, body: {kind: 'mcp', name, agentServer}};
  }
  const url = String(values.url ?? '').trim();
  if (!url) return {ok: false, error: 'Paste the server address.'};
  if (!/^https?:\/\/\S+$/i.test(url)) return {ok: false, error: 'The address must start with http:// or https://.'};
  const parsed = parseHeaders(values.headers);
  if (parsed.error) return {ok: false, error: parsed.error};
  return {ok: true, body: {kind: 'mcp', name, url, ...(Object.keys(parsed.headers).length ? {headers: parsed.headers} : {})}};
}

const DEFAULT_NAME = {claude: 'My Claude', codex: 'My ChatGPT'};
/** The body for a subscription provider. Only these four fields are ever built, so a key typed anywhere cannot ride along. */
export function cliDraft(values = {}) {
  const engine = cliEngineById(values.engine);
  if (!engine) return {ok: false, error: `Pick the engine: ${LOCAL_CLI_ENGINES.map(e => e.id).join(' or ')}.`};
  const model = cleanCliModel(values.model);
  if (model === null) return {ok: false, error: 'That model name is not valid. Use letters, digits and . _ : / - only.'};
  const label = String(values.label ?? '').trim() || DEFAULT_NAME[engine.id];
  return {ok: true, body: {kind: LOCAL_CLI_KIND, label: label.slice(0, 80), engine: engine.id, model}};
}

/* ---------- the model dropdown ---------- */

/** The value of the last row, which opens a box for any id. */
export const OTHER_MODEL = '__other';
/** Every model a subscription can run, shorthands first, then each by its full name (shared/ai-presets.js). */
export const CLI_MODEL_CHOICES = CLI_MODELS;

/** The rows of a model dropdown: Default, then what the provider offers (a subscription's known names, or an
 * API provider's chat models by their label), then Other…. A saved id the list lacks stays in, picked, so
 * opening the page never changes the model behind your back.
 * @returns {{value: string, label: string, selected: boolean}[]} */
export function modelChoices({provider = null, current = '', defaultLabel = 'Default'} = {}) {
  const labels = provider?.labels && typeof provider.labels === 'object' ? provider.labels : {};
  const known = provider?.kind === LOCAL_CLI_KIND
    ? CLI_MODEL_CHOICES[provider.engine] || []
    : (Array.isArray(provider?.chatModels) ? provider.chatModels : []).filter(id => typeof id === 'string' && id).map(id => [id, String(labels[id] || '').trim() || id]);
  const rows = [['', defaultLabel], ...known];
  const now = String(current ?? '').trim();
  if (now && !rows.some(([value]) => value === now)) rows.splice(1, 0, [now, `${now} (current)`]);
  return [...rows.map(([value, label]) => ({value, label, selected: value === now})), {value: OTHER_MODEL, label: 'Other…', selected: false}];
}

/** The model a form posts: the picked row, or what was typed after Other…. */
export const chosenModel = values => String((values?.model === OTHER_MODEL ? values.modelOther : values?.model) ?? '').trim();

/** A bot's model picker as one list: "Workspace default" on top, then a group per connected provider with
 * its own default, its models, and "Another <provider> model…" to type any id. Each row's value is
 * `providerId|model`, so one select answers both questions the old two dropdowns asked.
 * @returns {{top: {value: string, label: string, selected: boolean}, groups: {label: string, rows: {value: string, label: string, selected: boolean}[]}[]}} */
export function botModelChoices(ai = {}, own = {}) {
  const providers = Array.isArray(ai?.providers) ? ai.providers : [];
  const fallback = providers.find(p => p.id === ai?.defaultProviderId) || null;
  // An override with a model but no provider runs on the workspace default's provider.
  const pinned = own?.providerId || (own?.model ? fallback?.id : '') || '';
  const now = String(own?.model ?? '').trim();
  const defaultModel = fallback ? (ai.defaultModel || (fallback.kind === LOCAL_CLI_KIND ? fallback.model || 'default model' : 'default model')) : '';
  const top = {value: '', label: fallback ? `Workspace default · ${fallback.label} · ${defaultModel}` : 'Workspace default', selected: !pinned};
  // The workspace default's provider comes first: it is the one most bots run on.
  const ordered = fallback ? [fallback, ...providers.filter(p => p !== fallback)] : providers;
  const groups = ordered.map(p => {
    const mine = p.id === pinned;
    const rows = modelChoices({provider: p, current: mine ? now : '', defaultLabel: `${p.label} · its default`});
    return {label: p.label || p.id, rows: rows.map(r => ({
      value: `${p.id}|${r.value}`,
      label: r.value === OTHER_MODEL ? `Another ${p.label} model…` : r.label,
      selected: mine && r.value !== OTHER_MODEL && r.value === now,
    }))};
  });
  return {top, groups};
}

/** What the grouped picker posts: `{providerId, model}`, with the typed id after "Another…". */
export function pickedModel(values) {
  const raw = String(values?.model ?? '');
  if (!raw.includes('|')) return {providerId: null, model: ''};
  const at = raw.indexOf('|'), providerId = raw.slice(0, at) || null, model = raw.slice(at + 1);
  return {providerId, model: String(model === OTHER_MODEL ? values?.modelOther ?? '' : model).trim()};
}

/** The effort choices as radio rows: Default (send nothing), then the three levels. */
export function effortChoices(current = '') {
  const now = cleanEffort(current) || '';
  return [{value: '', label: 'Default', hint: "The model decides."}, ...EFFORT_LEVELS.map(l => ({value: l.id, label: l.label, hint: l.hint}))]
    .map(r => ({...r, selected: r.value === now}));
}

/* ---------- the CLI sign-in of each paired agent ---------- */

export const SIGN_IN_HINT = 'Run `claude` (or `codex`) in a terminal on that machine to sign in.';
const WORDS = {'signed-in': ['Signed in', 'good'], 'signed-out': ['Signed out', 'warn'], missing: ['Not installed', 'bad'], unknown: ['Not reported yet', '']};
const ENGINE_NAME = {claude: 'Claude', codex: 'ChatGPT'};
const wordOf = status => (WORDS[status] ? status : 'unknown');

/** One row per agent that is not revoked: its `claude` and `codex` sign-in as the device last said. */
export function agentCliRows(agents) {
  return (Array.isArray(agents) ? agents : []).filter(a => a && a.status !== 'revoked').map(a => {
    const engines = ['claude', 'codex'].map(id => {
      const status = wordOf(a.cli?.[id]), [word, tone] = WORDS[status];
      return {id, name: ENGINE_NAME[id], status, word, tone};
    });
    return {id: a.id, name: a.name, online: a.status === 'online', engines, hint: engines.some(e => e.status === 'signed-out') ? SIGN_IN_HINT : ''};
  });
}

/* ---------- what a paired computer may do, and how busy it is ---------- */

const ACTION_COPY = {
  'http.check': ['Check web addresses', 'Fetches an address to see whether it answers'],
  'browser.capture': ['Read web pages', 'Opens a page and reads it, without clicking'],
  'browser.action': ['Click and type on pages', 'Acts on a page; bots still ask you first'],
  'model.run': ['Run your Claude or ChatGPT plan', 'Through claude or codex on this computer'],
  'mcp.call': ['Use its MCP servers', 'Tools of servers that run on this computer'],
};

/** The permission switches of one computer: every action the server offers, with a plain name, and whether it is granted. */
export function agentPermissionRows(actions, granted) {
  const on = new Set(Array.isArray(granted) ? granted : []);
  return (Array.isArray(actions) ? actions : []).map(id => {
    const [label, note] = ACTION_COPY[id] || [id, ''];
    return {id, label, note, on: on.has(id)};
  });
}

/** What a computer has in its queue, in a few words: "Idle" or "2 queued · 1 failed". */
export function agentWorkLine(tasks) {
  const n = key => Math.max(0, Number(tasks?.[key]) || 0);
  const parts = [[n('queued'), 'queued'], [n('running'), 'running'], [n('failed'), 'failed']].filter(([count]) => count).map(([count, word]) => `${count} ${word}`);
  return parts.length ? parts.join(' · ') : 'Idle';
}

/** The sub-line of a subscription provider: its engine, its model, and where it is signed in. One signed-in machine is enough. */
export function subscriptionLine(provider, agents) {
  const id = provider.engine, name = ENGINE_NAME[id] || String(id);
  const head = `${name} subscription · ${provider.model || 'default model'}`;
  const live = (Array.isArray(agents) ? agents : []).filter(a => a && a.status !== 'revoked');
  // A run goes to a machine that is running, so those decide; a sleeping one only speaks when none is awake.
  const seen = (live.some(a => a.status === 'online') ? live.filter(a => a.status === 'online') : live).map(a => ({name: a.name, status: wordOf(a.cli?.[id])}));
  if (!seen.length) return `${head} · no paired agent yet`;
  const best = seen.find(s => s.status === 'signed-in') || seen.find(s => s.status === 'signed-out') || seen.find(s => s.status === 'missing') || seen[0];
  const tail = {'signed-in': `signed in on ${best.name}`, 'signed-out': `signed out on ${best.name}`, missing: `not installed on ${best.name}`, unknown: `not reported yet by ${best.name}`}[best.status];
  return `${head} · ${tail}`;
}

/* ---------- chat lines ---------- */

const accountOf = (state, id) => (state?.connectors || []).find(c => c.id === id)?.account || '';
/** A connector line: what was read or done, and on which account. A send held for Undo carries `undo`; it is `open` only
 * while its window runs and nothing after it in the chat says it was undone or sent (the server writes `send-<activityId>`). */
export function connectorLine(message, {state, items = [], now = Date.now()} = {}) {
  const base = {tone: message.kind === 'connector-error' ? 'error' : 'ok', text: String(message.text ?? ''), account: accountOf(state, message.connectorId)};
  if (!message.activityId || !message.undoUntil) return {...base, undo: null};
  const until = Date.parse(message.undoUntil), settledId = `send-${message.activityId}`.slice(0, 64);
  const settled = items.some(item => item.message?.id === settledId);
  const open = Number.isFinite(until) && now < until && !settled;
  // Once the window is shut the line must not promise an Undo that is gone.
  return {...base, text: open ? base.text : base.text.replace(/\s*You can undo it until it goes out\.\s*$/, ''), undo: {activityId: message.activityId, until, open}};
}

/** The line a usage limit leaves: the server's own sentence, and a Switch button to the provider it named, until the bot uses it. */
export function modelLimitLine(message, {state}) {
  const providers = state?.ai?.providers || [], target = providers.find(p => p.id === message.switchTo);
  const switchTo = target ? {id: target.id, label: target.label} : null;
  const using = state?.ai?.bots?.[message.botId]?.providerId;
  return {text: String(message.text ?? ''), botId: message.botId || null, switchTo, open: Boolean(switchTo && message.botId && using !== switchTo.id)};
}

/** The no-model card's one tap: which sign-in on this computer to use, and the provider it already has.
 * Claude first, then ChatGPT, from a device that is online now. Pure.
 * @returns {{engine: string, label: string, providerId: string|null}|{error: string}} */
export function cliChoice(agents, providers) {
  const live = (Array.isArray(agents) ? agents : []).filter(a => a && a.status !== 'revoked');
  if (!live.length) return {error: 'No computer is connected. A server started on your own computer connects it by itself.'};
  const online = live.filter(a => a.status === 'online');
  if (!online.length) return {error: 'Your computer is not online right now. Restart the server on it and try again.'};
  const engine = ['claude', 'codex'].find(id => online.some(a => a.cli?.[id] === 'signed-in'));
  if (!engine) return {error: 'This computer is not signed in yet. Run `claude` (or `codex`) once in a terminal there to sign in, then tap again.'};
  const have = (Array.isArray(providers) ? providers : []).find(p => p.kind === 'local-cli' && p.engine === engine);
  return {engine, label: `My ${ENGINE_NAME[engine]}`, providerId: have?.id || null};
}
