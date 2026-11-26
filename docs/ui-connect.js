/** Settings → Connectors: the Connect apps catalogue (app-catalog.js) and the MCP servers a bot may use. Markup and the
 * buttons; the rules (what a row says, what a form sends, what a sign-in's redirect back means) are pure and tested in
 * ui-connect-model.js. Every app is a real MCP server; Gmail, Drive and Calendar are Google's own.
 *
 * The panel is one of the admin pages (`adminPage('connectors')`), so it loads, and reloads after a change, into
 * the Settings body the same way. A handler does not catch errors: the host toasts them.
 *
 * Secrets: an MCP address or header is typed here and sent once; sign-in clients live in the server's .env. The server never
 * answers with one, so nothing on this page can show or log one. */
import {esc, icon, btn, note, tag, field, textInput, runFullApp, demoList} from './ui-kit.js?v=2c827d8a6b';
import {api, sync} from './ui-store.js?v=2c827d8a6b';
import {toast, confirmSheet, openSheet, closeSheet} from './ui-dialogs.js?v=2c827d8a6b';
import {mcpRows, mcpDraft, statusOf} from './ui-connect-model.js?v=2c827d8a6b';
import {catalogView, appById, appInputs, connectRequest, connectHow, clientSetupLine, APPS} from './app-catalog.js?v=2c827d8a6b';

const tools = (connector, label) => {
  const list = Array.isArray(connector?.actions) ? connector.actions : [];
  if (!list.length) return '';
  const items = list.map(a => `<li><code>${esc(a.name)}</code>${a.write ? tag('changes things', 'warn') : ''}${a.description ? `<small>${esc(a.description)}</small>` : ''}</li>`).join('');
  return `<details class="cn-tools"><summary>${esc(label)}${icon('chevron', 13)}</summary><ul>${items}</ul></details>`;
};

/** A line of what a card is, with its status tag. */
const head = (title, sub, status) => `<div class="cn-head"><span class="cn-ico" aria-hidden="true">${icon('plug', 18)}</span><span class="w"><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span>${status ? tag(status.label, status.tone) : ''}</div>`;

/* ---------- MCP servers ---------- */

function mcpPanel(connectors) {
  const rows = mcpRows(connectors).map(r => {
    const raw = connectors.find(c => c.id === r.id), {name, where, detail, status} = r;
    const msg = r.message ? `<p class="cn-msg">${esc(r.message)}</p>` : '';
    return `<div class="cn-card cn-mcp" data-connector="${esc(r.id)}">${head(name, `${where} · ${detail}`, status)}${msg}${tools(raw, 'Tools')}
      <div class="cn-acts">${appById(raw?.app)?.oauth ? btn(r.status.label === 'Ready' ? 'Sign in again' : 'Sign in', 'catalog-oauth', {small: true, id: raw.app, kind: r.status.label === 'Ready' ? 'quiet' : 'primary'}) : ''}${btn('Refresh tools', 'connector-refresh', {small: true, id: r.id})}${btn('Delete', 'connector-delete', {kind: 'danger', small: true, id: r.id, data: {name: r.name}})}</div></div>`;
  });
  // Older connections from before every app was an MCP server: a website signed in to in the browser, and Google
  // through its own API. They keep working until removed; Connect gives the app's real MCP server.
  for (const c of connectors.filter(c => c?.kind === 'site' || c?.kind === 'google')) {
    const name = c.kind === 'google' ? 'Google' : c.name, app = c.kind === 'google' ? appById('gmail') : appById(c.app);
    const upgrade = app ? btn(`Connect ${app.name}`, 'catalog-connect-row', {small: true, id: app.id, kind: c.kind === 'google' && c.status !== 'ready' ? 'quiet' : 'primary'}) : '';
    // A Google sign-in that ended can be restored with the client it already saved, without moving to MCP.
    const again = c.kind === 'google' && ['reconnect', 'error', 'setup'].includes(c.status) ? `<a class="btn primary small" href="/api/connectors/google/start" data-google-connect>${icon('arrow', 15)}<span>Reconnect Google</span></a>` : '';
    rows.push(`<div class="cn-card cn-site" data-connector="${esc(c.id)}">${head(name, `Older connection · ${c.kind === 'google' ? 'Google\'s API' : `through the browser · ${c.host || ''}`}`, statusOf(c.status || 'ready'))}
      <div class="cn-acts">${again}${upgrade}${btn('Remove', 'connector-delete', {kind: 'danger', small: true, id: c.id, data: {name}})}</div></div>`);
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

/** The Connectors section: the catalogue, the servers, the form. `res` is `GET /api/connectors`. */
export function connectorsPanel(res) {
  if (res?.demo) return `${note('Connectors need the Node server. The browser-only demo has no MCP servers to connect; the full app connects every app below.')}${runFullApp()}${demoList(APPS.map(a => ({name: a.name, sub: a.blurb || '', tag: a.category})), 'Apps the full app connects')}`;
  const connectors = Array.isArray(res?.connectors) ? res.connectors : [];
  lastRes = res;
  return `<div class="cn-panel">${catalogPanel(res)}${mcpPanel(connectors)}${addForm()}</div>`;
}

/** Fetch what the section shows. */
export const loadConnectors = () => api('/api/connectors');

/** One tap on Connect for a catalogue app, from the Connectors page or a bot's setup card. True when it connected
 * here; false when the tap moved on to a sign-in page or the token sheet. `busy` runs just before a direct connect. */
export async function connectAppNow(app, {busy = () => {}} = {}) {
  // From a chat's setup card this page may not have loaded yet, so which sign-in clients the server has is asked for.
  const res = lastRes || await loadConnectors().catch(() => null);
  const how = connectHow(app, {clients: res?.clients});
  // The app's own server signs the owner in: bots then work on the account directly, with its tools.
  if (how === 'oauth') { window.location.assign(`/api/connectors/mcp/start?app=${encodeURIComponent(app.id)}`); return false; }
  if (how === 'setup') { toast(clientSetupLine(app), true); return false; }
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
  'catalog-connect-row': async (button, ctx) => { const app = appById(button.dataset.id); if (app && await connectAppNow(app)) { await sync(); await ctx.reload(); } },
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
};
