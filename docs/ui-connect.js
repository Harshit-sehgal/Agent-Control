/** Settings → Connectors: Google, and the MCP servers a bot may use. Markup and the buttons; the rules
 * (what a row says, what a form sends, what Google's redirect back means) are pure and tested in
 * ui-connect-model.js.
 *
 * The panel is one of the admin pages (`adminPage('connectors')`), so it loads, and reloads after a change, into
 * the Settings body the same way. A handler does not catch errors: the host toasts them.
 *
 * Secrets: the Google client secret and an MCP address or header are typed here and sent once. The server never
 * answers with one, so nothing on this page can show or log one. */
import {esc, icon, btn, note, tag, field, textInput} from './ui-kit.js?v=588d41953d';
import {api, sync} from './ui-store.js?v=588d41953d';
import {toast, confirmSheet} from './ui-dialogs.js?v=588d41953d';
import {mcpRows, googleCard, mcpDraft, statusOf} from './ui-connect-model.js?v=588d41953d';

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
      <div class="cn-acts">${btn('Refresh tools', 'connector-refresh', {small: true, id: r.id})}${btn('Delete', 'connector-delete', {kind: 'danger', small: true, id: r.id, data: {name: r.name}})}</div></div>`;
  });
  const list = rows.length ? `<div class="cd cn-list">${rows.join('')}</div>` : '<div class="cd pad"><p class="st-quiet">No servers yet. Add one below and bots can use its tools, with your say-so.</p></div>';
  return `<section class="st-g"><h4 class="st-h">MCP servers</h4>${list}</section>`;
}

const addForm = () => `<section class="st-g"><h4 class="st-h">Add an MCP server</h4><div class="cd pad"><form id="connector-add-form" class="form cn-add" autocomplete="off">
  ${field('Name', textInput('name', {required: true, maxlength: 60, placeholder: 'Notes'}))}
  <fieldset class="cn-via"><legend class="field-label">Where it runs</legend>
    <div class="st-seg" role="radiogroup" aria-label="Where it runs">
      <label><input type="radio" name="via" value="http" checked><span>Web address</span></label>
      <label><input type="radio" name="via" value="agent"><span>On my agent</span></label>
    </div></fieldset>
  <div class="cn-if-http">
    ${field('Address', textInput('url', {placeholder: 'https://notes.example.org/mcp', autocomplete: 'off', spellcheck: 'false', inputmode: 'url'}), 'Saved encrypted. Only the host is shown afterwards.')}
    ${field('Headers, one per line (optional)', '<textarea class="input" name="headers" rows="2" placeholder="Authorization: Bearer ..." autocomplete="off" spellcheck="false"></textarea>', 'Stored encrypted, never shown again.')}
  </div>
  <div class="cn-if-agent">
    ${field('Server name on your agent', textInput('agentServer', {placeholder: 'files', autocomplete: 'off', spellcheck: 'false', maxlength: 40}), 'A server your paired agent already runs on its own machine. The command stays there; only the name travels.')}
  </div>
  <div class="cn-acts">${btn('Add server', null, {kind: 'primary', type: 'submit'})}</div>
  <p class="cn-testing">The server is reached first, so a typo saves nothing. Adding one on your agent can take up to a minute.</p>
</form></div></section>`;

/** The Connectors section: Google, the servers, the form. `res` is `GET /api/connectors`. */
export function connectorsPanel(res) {
  if (res?.demo) return note('Connectors need the Node server. The browser-only demo has no Gmail, Drive or MCP servers to connect. Run the full app to add them.');
  const connectors = Array.isArray(res?.connectors) ? res.connectors : [];
  return `<div class="cn-panel">${googlePanel(res?.google, connectors.find(c => c.id === 'google'))}${mcpPanel(connectors)}${addForm()}</div>`;
}

/** Fetch what the section shows. */
export const loadConnectors = () => api('/api/connectors');

/* ---------- what the buttons do ---------- */

export const connectActions = {
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
  'connector-add-form': async (form, values, ctx) => {
    const draft = mcpDraft(values);
    if (!draft.ok) throw new Error(draft.error);
    const submit = form.querySelector('[type=submit] span'), label = submit?.textContent;
    if (submit) submit.textContent = 'Reaching it…';
    try {
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
