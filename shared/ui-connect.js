/** Settings → Connectors: the Connect apps catalogue (app-catalog.js), Google, and the MCP servers a bot may use. Markup and the buttons; the rules
 * (what a row says, what a form sends, what Google's redirect back means) are pure and tested in
 * ui-connect-model.js.
 *
 * The panel is one of the admin pages (`adminPage('connectors')`), so it loads, and reloads after a change, into
 * the Settings body the same way. A handler does not catch errors: the host toasts them.
 *
 * Secrets: the Google client secret and an MCP address or header are typed here and sent once. The server never
 * answers with one, so nothing on this page can show or log one. */
import {esc, icon, btn, note, tag, field, textInput, runFullApp, demoList} from './ui-kit.js';
import {api, sync, store, go} from './ui-store.js';
import {primaryOf} from './company.js';
import {toast, confirmSheet, openSheet, closeSheet} from './ui-dialogs.js';
import {mcpRows, googleCard, mcpDraft, statusOf} from './ui-connect-model.js';
import {catalogView, appById, appInputs, connectRequest, connectHow, APPS} from './app-catalog.js';

const GOOGLE_START = '/api/connectors/google/start';

const tools = (connector, label) => {
  const list = Array.isArray(connector?.actions) ? connector.actions : [];
  if (!list.length) return '';
  const items = list.map(a => `<li><code>${esc(a.name)}</code>${a.write ? tag('changes things', 'warn') : ''}${a.description ? `<small>${esc(a.description)}</small>` : ''}</li>`).join('');
  return `<details class="cn-tools"><summary>${esc(label)}${icon('chevron', 13)}</summary><ul>${items}</ul></details>`;
};

/** A line of what a card is, with its status tag. */
const head = (title, sub, status) => `<div class="cn-head"><span class="cn-ico" aria-hidden="true">${icon('plug', 18)}</span><span class="w"><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span>${status ? tag(status.label, status.tone) : ''}</div>`;

/* ---------- Google ---------- */

function googleSetupForm(card) {
  const steps = card.steps.map(s => `<li>${esc(s)}</li>`).join('');
  const copy = card.redirectUri ? `<div class="cn-copy"><code aria-label="Redirect address">${esc(card.redirectUri)}</code>${btn('Copy', 'connector-copy', {small: true, glyph: 'copy', data: {text: card.redirectUri}})}</div>` : '';
  return `<div class="cn-setup">
    <ol class="cn-steps">${steps}</ol>
    ${copy ? `<div class="cn-redirect"><span class="field-label">Redirect address to add in Google Cloud</span>${copy}</div>` : ''}
    <form id="google-setup-form" class="form" autocomplete="off">
      ${field('Client ID', textInput('clientId', {required: true, placeholder: '1234-abc.apps.googleusercontent.com', autocomplete: 'off', spellcheck: 'false', maxlength: 200}))}
      ${field('Client secret', textInput('clientSecret', {type: 'password', required: true, autocomplete: 'off', maxlength: 200}), 'Stored encrypted. It is never shown again.')}
      <div class="cn-acts">${btn('Save client', null, {kind: 'primary', type: 'submit'})}</div>
    </form>
    ${card.testingNote ? `<p class="cn-testing">${esc(card.testingNote)}</p>` : ''}
  </div>`;
}

const STATE_LINES = {
  none: ['Not set up', null, 'Gmail and Drive, with your own Google Cloud client'],
  ready: ['Not signed in', {label: 'Not signed in', tone: 'warn'}, 'Your client is saved. Sign in to finish.'],
  connected: ['Connected', {label: 'Connected', tone: 'good'}, ''],
  reconnect: ['Reconnect', {label: 'Reconnect', tone: 'warn'}, 'Google ended the sign-in. Reconnect to let bots use Gmail and Drive again.'],
  error: ['Problem', {label: 'Problem', tone: 'bad'}, ''],
};

function googlePanel(google, connector) {
  const card = googleCard(google);
  if (!card) return '';
  const [, status, line] = STATE_LINES[card.state];
  const who = card.account ? `Signed in as ${card.account}` : '';
  const sub = card.state === 'connected' ? who : (card.state === 'reconnect' && who ? `${who}. ${line}` : line);
  const message = card.state === 'error' && connector?.statusMessage ? `<p class="cn-msg">${esc(connector.statusMessage)}</p>` : '';
  const connect = card.connectLabel ? `<a class="btn primary" href="${GOOGLE_START}" data-google-connect>${icon('arrow', 17)}<span>${esc(card.connectLabel)}</span></a>` : '';
  const manage = card.state === 'none' ? '' : `${card.state === 'connected' ? btn('Check', 'connector-refresh', {small: true, id: 'google'}) : ''}${btn('Change client', 'google-change-client', {small: true})}${btn('Disconnect', 'connector-delete', {kind: 'danger', small: true, id: 'google', data: {name: 'Google'}})}`;
  const acts = connect || manage ? `<div class="cn-acts">${connect}${manage}</div>` : '';
  const body = card.state === 'none' ? googleSetupForm(card) : `<div class="cn-fold" hidden data-google-client>${googleSetupForm(card)}</div>`;
  const hint = card.state === 'connected' ? '<p class="cn-testing">Bots ask you before they use it. Your rules are under Permissions.</p>' : '';
  return `<section class="st-g" data-connector="google"><h4 class="st-h">Google</h4><div class="cd pad cn-card">${head('Google', sub, status)}${message}${acts}${card.state === 'connected' ? tools(connector, `${(connector?.actions || []).length} tools`) : ''}${hint}${body}</div></section>`;
}

/* ---------- MCP servers ---------- */

function mcpPanel(connectors) {
  const rows = mcpRows(connectors).map(r => {
    const raw = connectors.find(c => c.id === r.id), {name, where, detail, status} = r;
    const msg = r.message ? `<p class="cn-msg">${esc(r.message)}</p>` : '';
    return `<div class="cn-card cn-mcp" data-connector="${esc(r.id)}">${head(name, `${where} · ${detail}`, status)}${msg}${tools(raw, 'Tools')}
      <div class="cn-acts">${appById(raw?.app)?.oauth ? btn(r.status.label === 'Ready' ? 'Sign in again' : 'Sign in', 'catalog-oauth', {small: true, id: raw.app, kind: r.status.label === 'Ready' ? 'quiet' : 'primary'}) : ''}${btn('Refresh tools', 'connector-refresh', {small: true, id: r.id})}${btn('Delete', 'connector-delete', {kind: 'danger', small: true, id: r.id, data: {name: r.name}})}</div></div>`;
  });
  for (const c of connectors.filter(c => c?.kind === 'site')) {
    const {name, host} = c, app = appById(c.app), token = app && !app.google && appInputs(app).length ? btn('Add a token', 'catalog-token', {small: true, id: app.id}) : '';
    rows.unshift(`<div class="cn-card cn-site" data-connector="${esc(c.id)}">${head(name, `Signed in through the browser · ${host}`, statusOf('ready'))}
      <div class="cn-acts">${btn('Sign in again', 'catalog-signin', {small: true, id: c.app})}${token}${btn('Remove', 'connector-delete', {kind: 'danger', small: true, id: c.id, data: {name}})}</div></div>`);
  }
  const list = rows.length ? `<div class="cd cn-list">${rows.join('')}</div>` : '<div class="cd pad"><p class="st-quiet">No servers yet. Connect an app above and bots can use its tools, with your say-so.</p></div>';
  return `<section class="st-g" id="cn-connected"><h4 class="st-h">Connected</h4>${list}</section>`;
}

// A reload redraws the page, so the custom-server fold stays open when it was open (the old page is still there).
const customOpen = () => typeof document !== 'undefined' && Boolean(document.querySelector('.cn-custom')?.open);
const addForm = () => `<details class="st-g cn-custom"${customOpen() ? ' open' : ''}><summary class="st-h">Add a custom server${icon('chevron', 13)}</summary><div class="cd pad"><form id="connector-add-form" class="form cn-add" autocomplete="off">
  ${field('Name', textInput('name', {required: true, maxlength: 60, placeholder: 'Notes'}))}
  <fieldset class="cn-via"><legend class="field-label">Where it runs</legend>
    <div class="st-seg" role="radiogroup" aria-label="Where it runs">
      <label><input type="radio" name="via" value="http" checked><span>Web address</span></label>
      <label><input type="radio" name="via" value="agent"><span>On my computer</span></label>
    </div></fieldset>
  <div class="cn-if-http">
    ${field('Address', textInput('url', {placeholder: 'https://notes.example.org/mcp', autocomplete: 'off', spellcheck: 'false', inputmode: 'url'}), 'Saved encrypted. Only the host is shown afterwards.')}
    ${field('Headers, one per line (optional)', '<textarea class="input" name="headers" rows="2" placeholder="Authorization: Bearer ..." autocomplete="off" spellcheck="false"></textarea>', 'Stored encrypted, never shown again.')}
  </div>
  <div class="cn-if-agent">
    ${field('Command that starts it on this computer', textInput('command', {placeholder: 'npx -y @modelcontextprotocol/server-filesystem ~/notes', autocomplete: 'off', spellcheck: 'false', maxlength: 1000}), 'Runs on the computer this app runs on, without a shell. Only the owner can add one.')}
    ${field('Or the name it already has on a paired device', textInput('agentServer', {placeholder: 'files', autocomplete: 'off', spellcheck: 'false', maxlength: 40}), 'For a server set up in that device\'s own agent config. Only the name travels.')}
  </div>
  <div class="cn-acts">${btn('Add server', null, {kind: 'primary', type: 'submit'})}</div>
  <p class="cn-testing">The server is reached first, so a typo saves nothing. Adding one on your agent can take up to a minute.</p>
</form></div></details>`;

/* ---------- the Connect apps catalogue ---------- */

// What the catalogue is filtered by, and the last answer it drew, so typing filters without a reload.
const filters = {query: '', category: 'All'};
let lastRes = null;
const ALL_LIMIT = 4;

const tile = app => `<span class="ca-tile t${app.tint}" aria-hidden="true">${esc(app.mono)}</span>`;

function appRow(app) {
  const right = app.connected
    ? tag('Connected', 'good')
    : `<button type="button" class="ca-go" data-action="catalog-connect" data-id="${esc(app.id)}" aria-label="Connect ${esc(app.name)}"><span>Connect</span></button>`;
  return `<li class="ca-app" data-app="${esc(app.id)}">${tile(app)}<span class="ca-txt"><b>${esc(app.name)}</b><small>${esc(app.blurb)}</small></span>${right}</li>`;
}

function catalogSections(view) {
  if (!view.sections.length) return `<p class="st-quiet ca-none">No apps match “${esc(filters.query.trim())}”. Add it as a custom server below.</p>`;
  const browsing = filters.category === 'All' && !filters.query.trim();
  return view.sections.map(s => {
    const cut = browsing && s.id !== 'recommended' && s.apps.length > ALL_LIMIT;
    const apps = cut ? s.apps.slice(0, ALL_LIMIT) : s.apps;
    const more = cut ? `<button type="button" class="ca-more" data-action="catalog-chip" data-cat="${esc(s.title)}">View all ${s.apps.length}${icon('chevron', 13)}</button>` : '';
    return `<section class="ca-sec" aria-label="${esc(s.title)}"><div class="ca-sh"><h4 class="st-h">${esc(s.title)}</h4>${more}</div><ul class="ca-grid">${apps.map(appRow).join('')}</ul></section>`;
  }).join('');
}

function catalogPanel(res) {
  const view = catalogView(res, filters);
  const marks = view.connected.slice(0, 4).map(tile).join('');
  const summary = `<button type="button" class="ca-sum" data-action="catalog-show-connected"${view.connectedCount ? '' : ' disabled'}>${marks ? `<span class="ca-stack">${marks}</span>` : ''}<span>${view.connectedCount} connected</span>${view.connectedCount ? icon('chevron', 14) : ''}</button>`;
  const chips = view.chips.map(c => `<button type="button" class="ca-chip" data-action="catalog-chip" data-cat="${esc(c.label)}" aria-pressed="${c.selected}">${esc(c.label)}</button>`).join('');
  return `<section class="ca" aria-labelledby="ca-title">
    <div class="ca-top"><h3 id="ca-title">Connect apps</h3>${summary}</div>
    <label class="ca-find">${icon('search', 18)}<input id="ca-search" class="input" type="search" placeholder="Search apps" aria-label="Search apps" autocomplete="off" spellcheck="false" maxlength="60" value="${esc(filters.query)}"></label>
    <div class="ca-chips" role="group" aria-label="Categories">${chips}</div>
    <div id="ca-results" aria-live="polite">${catalogSections(view)}</div>
  </section>`;
}

/** Redraw the results (and the chips' pressed state) for the current filters. */
function redrawCatalog() {
  const results = document.getElementById('ca-results');
  if (!results) return;
  results.innerHTML = catalogSections(catalogView(lastRes, filters));
  for (const chip of document.querySelectorAll('.ca-chip')) chip.setAttribute('aria-pressed', String(chip.dataset.cat === filters.category));
}

/** `input` on the search box filters live. Returns true when it was the search box. */
export function catalogSearch(control) {
  if (control?.id !== 'ca-search') return false;
  filters.query = control.value;
  redrawCatalog();
  return true;
}

const hostOf = url => { try { return new URL(url).host; } catch { return url; } };

function fieldFor(input) {
  const type = input.kind === 'secret' ? 'password' : input.kind === 'email' ? 'email' : input.kind === 'url' ? 'url' : 'text';
  // textInput writes every attribute it is given, so `required` is only passed when it is true.
  const control = textInput(input.key, {type, value: input.default || '', ...(input.placeholder ? {placeholder: input.placeholder} : {}), ...(input.optional || input.default ? {} : {required: true}), autocomplete: 'off', spellcheck: 'false', maxlength: 4000});
  const help = [input.hint, input.where ? `Get it at ${input.where}.` : ''].filter(Boolean).join(' ');
  return field(input.label, control, help);
}

function connectSheet(app) {
  const where = app.web ? `Connects to ${hostOf(app.web.url)}. The token is stored encrypted and never shown again.` : 'Runs on this computer. Its settings stay in the local agent\'s own config.';
  openSheet(`<form id="catalog-connect-form" class="form ca-form" autocomplete="off">
    ${appInputs(app).map(fieldFor).join('')}
    <input type="hidden" name="app" value="${esc(app.id)}">
    <p class="cn-testing">${esc(where)}</p>
    <div class="sheet-actions">${btn('Connect', null, {kind: 'primary', type: 'submit', wide: true})}</div>
  </form>`, {title: `Connect ${app.name}`, sub: app.blurb});
}

/** Send what Connect builds: the local server first when it runs here, then the connector. Returns the connector. */
async function connectApp(app, values) {
  const request = connectRequest(app, values);
  if (!request.ok) throw new Error(request.error);
  if (request.local) await api('/api/agents/local/mcp', 'POST', request.local);
  const made = await api('/api/connectors', 'POST', request.body);
  const n = (made?.actions || []).length;
  toast(`${app.name} connected${n ? ` with ${n} tool${n === 1 ? '' : 's'}` : ''}.`);
  return made;
}

/** One tap on an app with a web sign-in: remember it, then hand the owner the shared browser on its sign-in page.
 * Bots then open its pages as the owner, through the browser block; nothing is typed for them. */
async function signIn(app) {
  const bot = primaryOf(store.state);
  if (!bot) throw new Error('Add a bot first. It opens the sign-in page for you.');
  await api('/api/connectors', 'POST', {kind: 'site', app: app.id});
  go({profile: bot.id, sub: 'computer'});
  await api(`/api/browser-live/${encodeURIComponent(bot.id)}/takeover`, 'POST', {});
  await api(`/api/browser-live/${encodeURIComponent(bot.id)}/input`, 'POST', {type: 'navigate', url: app.site});
  toast(`You are in control. Sign in to ${app.google ? 'Gmail' : app.name}, then tap Hand back control.`);
}

/** The Connectors section: Google, the servers, the form. `res` is `GET /api/connectors`. */
export function connectorsPanel(res) {
  if (res?.demo) return `${note('Connectors need the Node server. The browser-only demo has no Gmail, Drive or MCP servers to connect; the full app connects every app below.')}${runFullApp()}${demoList(APPS.map(a => ({name: a.name, sub: a.blurb || '', tag: a.category})), 'Apps the full app connects')}`;
  const connectors = Array.isArray(res?.connectors) ? res.connectors : [];
  lastRes = res;
  return `<div class="cn-panel">${catalogPanel(res)}${googlePanel(res?.google, connectors.find(c => c.id === 'google'))}${mcpPanel(connectors)}${addForm()}</div>`;
}

/** Fetch what the section shows. */
export const loadConnectors = () => api('/api/connectors');

/** One tap on Connect for a catalogue app, from the Connectors page or a bot's setup card. True when it connected
 * here; false when the tap moved on to a sign-in page or the token sheet. `busy` runs just before a direct connect. */
export async function connectAppNow(app, {busy = () => {}} = {}) {
  const how = connectHow(app, {googleClient: Boolean(lastRes?.google?.configured)});
  if (how === 'google') { window.location.assign(GOOGLE_START); return false; }
  // The app's own server signs the owner in, like Google: bots then work on the account directly, with its tools.
  if (how === 'oauth') { window.location.assign(`/api/connectors/mcp/start?app=${encodeURIComponent(app.id)}`); return false; }
  if (how === 'gmail' || how === 'site') { await signIn(app); return false; }
  if (how === 'form') { connectSheet(app); return false; }
  busy();
  await connectApp(app, Object.fromEntries(appInputs(app).filter(i => i.default).map(i => [i.key, i.default])));
  return true;
}

/* ---------- what the buttons do ---------- */

export const connectActions = {
  'catalog-chip': button => {
    filters.category = button.dataset.cat || 'All';
    redrawCatalog();
    if (button.classList.contains('ca-more')) document.querySelector('.ca-chips')?.scrollIntoView({block: 'nearest', behavior: 'smooth'});
  },
  'catalog-show-connected': () => document.getElementById('cn-connected')?.scrollIntoView({block: 'start', behavior: 'smooth'}),
  'catalog-connect': async (button, ctx) => {
    const app = appById(button.dataset.id);
    if (!app) return;
    const label = button.querySelector('span');
    const busy = () => { button.disabled = true; if (label) label.textContent = 'Connecting…'; };
    try { if (!(await connectAppNow(app, {busy}))) return; }
    catch (error) { button.disabled = false; if (label) label.textContent = 'Connect'; throw error; }
    await sync(); await ctx.reload();
  },
  'catalog-oauth': button => { const app = appById(button.dataset.id); if (app?.oauth) window.location.assign(`/api/connectors/mcp/start?app=${encodeURIComponent(app.id)}`); },
  'catalog-signin': async button => { const app = appById(button.dataset.id); if (app) await signIn(app); },
  'catalog-token': button => { const app = appById(button.dataset.id); if (app) connectSheet(app); },
  'connector-refresh': async (button, ctx) => {
    const id = button.dataset.id;
    const result = await api(`/api/connectors/${encodeURIComponent(id)}/refresh`, 'POST', {});
    const name = result?.name || 'The connector', status = result?.status || 'ready';
    if (status === 'ready') toast(`${name} is ready.`);
    else toast(`${name}: ${statusOf(status).label.toLowerCase()}. ${result.statusMessage || ''}`.trim(), status === 'error');
    await sync(); await ctx.reload();
  },
  'connector-delete': async (button, ctx) => {
    const name = button.dataset.name || 'this connector';
    if (!await confirmSheet(`Remove ${name}?`, {confirm: 'Remove', danger: true, detail: 'Bots lose it, and the rules you set for it and its saved sign-in are deleted. This cannot be undone.'})) return;
    await api(`/api/connectors/${encodeURIComponent(button.dataset.id)}`, 'DELETE');
    toast(`${name} removed.`);
    await sync(); await ctx.reload();
  },
  'google-change-client': button => {
    const fold = button.closest('.cn-card')?.querySelector('[data-google-client]');
    if (!fold) return;
    fold.hidden = !fold.hidden;
    if (!fold.hidden) fold.querySelector('input')?.focus({preventScroll: false});
  },
  'connector-copy': async button => {
    try { await navigator.clipboard.writeText(button.dataset.text || ''); toast('Copied.'); }
    catch { toast('Select the address and copy it by hand.', true); }
  },
};

export const connectForms = {
  'catalog-connect-form': async (form, values, ctx) => {
    const app = appById(values.app);
    if (!app) throw new Error('That app is not in the list any more.');
    const submit = form.querySelector('[type=submit] span');
    if (submit) submit.textContent = 'Connecting…';
    try { await connectApp(app, values); }
    finally { if (submit) submit.textContent = 'Connect'; }
    closeSheet();
    await sync(); await ctx.reload();
  },
  'connector-add-form': async (form, values, ctx) => {
    const draft = mcpDraft(values);
    if (!draft.ok) throw new Error(draft.error);
    const submit = form.querySelector('[type=submit] span'), label = submit?.textContent;
    if (submit) submit.textContent = 'Reaching it…';
    try {
      if (draft.local) await api('/api/agents/local/mcp', 'POST', draft.local);
      const made = await api('/api/connectors', 'POST', draft.body);
      form.reset();
      const n = (made?.actions || []).length;
      toast(`${made?.name || 'Server'} added${n ? ` with ${n} tool${n === 1 ? '' : 's'}` : ''}.`);
    } finally { if (submit) submit.textContent = label; }
    await sync(); await ctx.reload();
  },
  'google-setup-form': async (form, values, ctx) => {
    await api('/api/connectors/google/setup', 'POST', {clientId: values.clientId, clientSecret: values.clientSecret});
    form.reset();
    toast('Client saved. Now choose Connect Google.');
    await sync(); await ctx.reload();
  },
};
