/** Admin pages: notifications, team and access, local agents, data and security.
 * `adminPage(kind)` fetches and returns the body HTML; the handler tables are
 * wired by the host's delegated click, submit and change listeners. Handlers do
 * not catch errors, the host toasts them. */
import {esc, btn, row, box, field, note, empty, tag, fullDate, textInput} from './ui-kit.js?v=1ab2a4f06e';
import {store, api, sync} from './ui-store.js?v=1ab2a4f06e';
import {toast, openSheet, closeSheet, confirmSheet, askSheet} from './ui-dialogs.js?v=1ab2a4f06e';
import {PROTOCOLS, PROVIDER_PRESETS, presetById, protocolById, normaliseProtocol, normaliseBaseUrl, isChatModel, DEFAULT_PROTOCOL} from './ai-presets.js?v=1ab2a4f06e';
import {pushStatus, enablePush, disablePush} from './ui-push.js?v=1ab2a4f06e';

/** Title + one-line description per page, used by the host for the page header. */
export const ADMIN_PAGES = {
  notifications: {
    title: 'Notifications',
    sub: 'Reminders, failed tasks, revoked agents and approvals blocked by disputed evidence.',
  },
  workspaces: {
    title: 'Workspaces',
    sub: 'Each workspace has its own bots, posts, drafts, chats and members.',
  },
  team: {
    title: 'Team and access',
    sub: 'Accounts and active sessions for this workspace.',
  },
  agents: {
    title: 'Local agents',
    sub: 'Device processes that run permission-scoped work outbound.',
  },
  data: {
    title: 'Data and security',
    sub: 'Credential vault, retention policy and workspace backups.',
  },
  ai: {
    title: 'AI and models',
    sub: 'Bring your own key: add providers, choose the default model, and override it per bot.',
  },
};

/** The pairing code is shown once, so it lives only in memory until the page is left. */
let lastPairing = null;

const actionRow = (title, sub, buttons) => `<div class="row"><span class="row-main"><span class="row-title">${title}</span>${sub ? `<span class="row-sub">${sub}</span>` : ''}</span><span class="row-actions">${buttons}</span></div>`;

const PUSH_HELP = {
  insecure: 'Push needs a secure address. Open this app over https, or on localhost.',
  unsupported: 'This browser cannot receive push here. On an iPhone or iPad, add this app to the Home Screen first, then open it from there.',
  blocked: 'Notifications are blocked for this site. Allow them in the browser settings, then reload.',
  off: 'Get reminders, failed tasks and alerts on this device, even when the app is closed.',
  on: 'This device gets reminders, failed tasks and alerts, even when the app is closed.',
};
/** The host of a push endpoint, and nothing else: the path is a capability URL,
 * so it is only carried to the button that deletes it. */
function endpointHost(endpoint) {
  try { return new URL(endpoint).host; } catch { return 'a device this browser cannot read'; }
}

function deviceList(push) {
  const endpoints = Array.isArray(push.endpoints) ? push.endpoints : [];
  if (endpoints.length < 1) return '';
  const rows = endpoints.map(endpoint => actionRow(
    `${esc(endpointHost(endpoint))}${endpoint === push.mine ? ` ${tag('this device', 'good')}` : ''}`,
    endpoint === push.mine ? 'Signed in here.' : 'Signed in somewhere else.',
    btn('Remove', 'push-remove', {small: true, kind: 'danger', data: {endpoint}}),
  )).join('');
  return box(rows, `Devices, ${endpoints.length}`);
}

function pushPanel(push) {
  const buttons = push.state === 'on' ? btn('Send a test', 'push-test', {small: true}) + btn('Turn off', 'push-off', {small: true})
    : push.state === 'off' ? btn('Turn on', 'push-on', {kind: 'primary', small: true}) : '';
  const others = push.devices - (push.state === 'on' ? 1 : 0);
  return box(actionRow(`Push on this device ${tag(push.state === 'on' ? 'on' : 'off', push.state === 'on' ? 'good' : '')}`,
    esc(PUSH_HELP[push.state] || 'Push status is unavailable in this browser.') + (others > 0 ? ` ${others} other device${others === 1 ? '' : 's'} of yours ${others === 1 ? 'is' : 'are'} subscribed.` : ''), buttons), 'Push')
    + deviceList(push);
}

function workspacesPanel(res) {
  const list = res.workspaces || [], current = list.find(w => w.current);
  const rows = list.map(w => actionRow(`${esc(w.name)}${w.current ? ` ${tag('current', 'good')}` : ''}`, `You are ${esc(w.role)}`,
    w.current ? '' : btn('Switch', 'workspace-switch', {id: w.id, small: true}))).join('');
  const create = res.canCreate ? box(`<form id="workspace-form">${field('Name', textInput('name', {required: true, maxlength: 60, placeholder: 'Client work'}))}${btn('Create workspace', null, {kind: 'primary', type: 'submit'})}</form>`, 'New workspace')
    : note('Only an owner of the first workspace can create workspaces.');
  const manage = current?.role === 'owner' ? box(`<form id="workspace-rename-form">${field('Name of this workspace', `<input class="input" name="name" type="text" value="${esc(current.name)}" required maxlength="60">`)}${btn('Rename', null, {type: 'submit'})}</form>`
    + (current.id === 'default' ? '' : `<p>${btn('Delete this workspace', 'workspace-delete', {kind: 'danger', small: true, data: {name: current.name}})}</p>`), 'This workspace') : '';
  return box(rows, `Your workspaces, ${list.length}`) + create + manage
    + note('Switching changes what this browser shows. People are invited to one workspace at a time, under Team and access.');
}

function notificationsPanel(list, prefs, push) {
  const unread = list.filter(n => n.status !== 'read');
  const items = list.length
    ? list.map(n => actionRow(
      `${esc(n.title)}${n.status === 'read' ? '' : ` ${tag('new', 'good')}`}`,
      `${esc(n.body || '')} · ${esc(n.channel || 'in_app')} · ${esc(fullDate(n.created_at))}`,
      n.status === 'read' ? '' : btn('Mark read', 'notification-read', {id: n.id, small: true}),
    )).join('')
    : empty('No notifications yet', 'Reminders and alerts will show up here.');
  const readAll = unread.length ? `<p>${btn('Mark all read', 'notifications-read-all', {small: true})}</p>` : '';
  const form = `<form id="notif-prefs-form">
    <label class="check-row"><input type="checkbox" name="inApp" ${prefs.inApp ? 'checked' : ''}><span>In-app (always recorded)</span></label>
    <label class="check-row"><input type="checkbox" name="webhook" ${prefs.webhook ? 'checked' : ''}><span>Webhook</span></label>
    ${field('Webhook credential id (from the vault)', textInput('webhookCredentialId', {value: prefs.webhookCredentialId || '', placeholder: 'uuid of a stored webhook credential'}))}
    <label class="check-row"><input type="checkbox" name="email" ${prefs.email ? 'checked' : ''}><span>Email (needs EMAIL_RELAY_URL on the server)</span></label>
    ${field('Email address', textInput('emailAddress', {type: 'email', value: prefs.emailAddress || ''}))}
    ${btn('Save preferences', null, {kind: 'primary', type: 'submit'})}
  </form>`;
  return `${readAll}${box(items, `Recent, ${unread.length} unread`)}${pushPanel(push)}${box(form, 'Delivery channels')}`;
}

function teamPanel(usersRes, sessionsRes) {
  const users = usersRes.users || [];
  const sessions = sessionsRes.sessions || [];
  const roles = usersRes.roles || [];
  const me = store.state?.me?.email;
  const members = users.map(user => {
    const isMe = me === user.email;
    const choices = roles.filter(r => r !== 'owner');
    const select = user.role === 'owner' ? '<span>owner</span>' : `<select class="input" data-action="set-role" data-id="${esc(user.id)}" aria-label="Role for ${esc(user.email)}">${choices.map(r => `<option value="${esc(r)}" ${r === user.role ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select>`;
    const disable = isMe ? '' : btn(user.disabled ? 'Enable' : 'Disable', 'toggle-user-disabled', {id: user.id, small: true, data: {disable: user.disabled ? '0' : '1'}});
    const remove = isMe ? '' : btn('Remove', 'remove-user', {kind: 'danger', id: user.id, small: true});
    return actionRow(
      `${esc(user.email)}${user.disabled ? ` ${tag('disabled', 'bad')}` : ''}${isMe ? ` ${tag('you', 'good')}` : ''}`,
      `Joined ${esc(fullDate(user.createdAt))}`,
      select + disable + remove,
    );
  }).join('');
  const invite = `<form id="create-user-form">
    <div class="form-grid">
      ${field('Email', textInput('email', {type: 'email', required: true}))}
      ${field('Role', '<select class="input" name="role"><option value="viewer">viewer</option><option value="member" selected>member</option><option value="admin">admin</option></select>')}
    </div>
    ${field('Temporary password (min 8 chars)', textInput('password', {type: 'password', minlength: 8, required: true}))}
    <p class="field-help">Someone who already has an account keeps their own password and is added to this workspace.</p>
    ${btn('Create user', null, {kind: 'primary', type: 'submit'})}
  </form>`;
  const sessionRows = sessions.map(session => actionRow(
    `${session.current ? 'This device' : 'Another device'}${session.current ? ` ${tag('current', 'good')}` : ''}`,
    `${esc(session.ip || 'unknown ip')} · expires ${esc(fullDate(session.expiresAt))}`,
    session.current ? '' : btn('Revoke', 'revoke-session', {kind: 'danger', id: session.id, small: true}),
  )).join('');
  return `<p>${btn('Sign out everywhere', 'revoke-sessions', {small: true})}</p>`
    + box(members, `Members, ${users.length}`)
    + box(invite, 'Invite a user')
    + box(sessionRows || empty('No active sessions'), `Your sessions, ${sessions.length}`);
}

function agentsPanel(res, pairing) {
  const agents = res.agents || [];
  const actions = res.actions || [];
  const code = pairing
    ? note(`<strong>Pairing code</strong> (shown once, expires ${esc(fullDate(pairing.expiresAt))})<br><span class="code">${esc(pairing.code)}</span>`)
    : '';
  const tone = status => (status === 'online' ? 'good' : status === 'revoked' ? 'bad' : 'warn');
  const rows = agents.length
    ? agents.map(agent => {
      const granted = agent.permissions || [];
      const tasks = agent.tasks || {};
      const toggles = actions.map(p => btn(p, 'toggle-agent-permission', {
        kind: granted.includes(p) ? 'primary' : 'quiet',
        id: agent.id,
        small: true,
        data: {permission: p, on: granted.includes(p) ? 'true' : 'false'},
      })).join('');
      return actionRow(
        `${esc(agent.name)} ${tag(agent.status, tone(agent.status))}`,
        `${granted.map(esc).join(', ') || 'no permissions'} · queued ${esc(tasks.queued ?? 0)} · running ${esc(tasks.running ?? 0)} · failed ${esc(tasks.failed ?? 0)}${agent.lastSeenAt ? ` · seen ${esc(fullDate(agent.lastSeenAt))}` : ''}`,
        toggles + btn('Revoke', 'revoke-agent', {kind: 'danger', id: agent.id, small: true}),
      );
    }).join('')
    : empty('No local agents', 'Create a pairing code, then pair a device.');
  // The admin chooses the scope when issuing the code; the device cannot widen it.
  const perms = actions.map(p => `<label class="check-row"><input type="checkbox" name="permissions" value="${esc(p)}" checked><span>${esc(p)}</span></label>`).join('');
  const form = `<form id="pairing-form">
    ${field('Device name', textInput('label', {placeholder: 'Laptop', maxlength: 120}))}
    <fieldset class="contract-fieldset"><legend>Permissions</legend>${perms}<p class="field-help">The device can only ever be granted a subset of these.</p></fieldset>
    ${btn('Create pairing code', null, {kind: 'primary', type: 'submit'})}
  </form>`;
  return form + code
    + box(rows, `Paired agents, ${agents.length}`)
    + note('A local agent runs only the task kinds it has been granted and can never publish.');
}

function credentialsPanel(list) {
  const rows = list.length
    ? list.map(c => actionRow(
      `${esc(c.name)} ${tag(c.kind)}`,
      `Added ${esc(fullDate(c.createdAt))}${c.expiresAt ? ` · expires ${esc(fullDate(c.expiresAt))}` : ''}${c.createdBy ? ` · by ${esc(c.createdBy)}` : ''}`,
      btn('Reveal', 'reveal-credential', {id: c.id, small: true}) + btn('Delete', 'delete-credential', {kind: 'danger', id: c.id, small: true}),
    )).join('')
    : empty('No credentials stored');
  const kinds = ['api_key', 'webhook', 'token', 'other'].map(k => `<option value="${k}">${k}</option>`).join('');
  const form = `<form id="credential-form">
    <div class="form-grid">
      ${field('Name', textInput('name', {required: true, maxlength: 120}))}
      ${field('Kind', `<select class="input" name="kind">${kinds}</select>`)}
    </div>
    ${field('Secret value', '<textarea class="input" name="value" rows="2" required></textarea>')}
    ${btn('Store credential', null, {kind: 'primary', type: 'submit'})}
  </form>`;
  return note('Stored encrypted (AES-256-GCM). Values are never listed; reveal is admin-only and written to the audit log.')
    + box(rows, `Credentials, ${list.length}`)
    + box(form, 'Add credential');
}

function retentionPanel(policy, preview) {
  const pol = policy || {};
  const pv = preview || {};
  const rows = Object.entries(pol).map(([k, v]) => row({title: esc(k), right: `${esc(String(v))} day(s)`})).join('');
  const counts = Object.entries(pv).filter(([k, v]) => typeof v === 'number' && k !== 'dryRun');
  const would = counts.length
    ? row({title: 'Would prune now', right: counts.map(([k, v]) => `${esc(k)} ${esc(String(v))}`).join(' · ')})
    : '';
  const inner = `${rows}${would}<p>${btn('Prune now', 'prune-retention', {kind: 'danger', small: true})}</p>`;
  return note('Pruning removes only exhaust (events, finished tasks, sent notifications, runs), never drafts, candidates or evidence.')
    + box(inner, 'Retention');
}

function backupPanel() {
  const inner = `<textarea class="input" id="restore-doc" rows="3" placeholder="Paste a backup document here to restore" aria-label="Backup document"></textarea>
    <p>${btn('Download backup', 'backup-export', {kind: 'primary'})} ${btn('Restore from pasted document', 'backup-restore', {kind: 'danger'})}</p>`;
  return note('Export contains workspace data only; credentials and sessions never travel. Restoring replaces the workspace, so it asks for confirmation.')
    + box(inner, 'Backup and restore');
}

/** Model ids offered by a picker. Bounded so a provider with a huge catalogue
 * (OpenRouter) does not bloat the page, and matched to the server's own cap so a
 * model the API sent is never silently unpickable. */
const MODEL_LIMIT = 300;
/** The row still reports the size of the whole catalogue, so the page keeps more
 * ids than it offers. The server sends at most 300 per provider. */
const MODEL_CACHE = 300;
/** GET /api/ai reports a model count only, so the ids, the endpoint, the model
 * labels, the API version, any custom-header NAMES and the catalogue error are
 * remembered from the save/refresh responses that do send them. Kept for the life
 * of the page, which is exactly what the pickers and the edit sheet need. */
const listings = new Map();
const idList = value => (Array.isArray(value) ? value.filter(id => typeof id === 'string' && id !== '') : []);
const labelMap = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
/** Fold one listing into what the page knows. Only the keys the caller sends are
 * replaced, so a catalogue refresh keeps the endpoint and a rename keeps the ids. */
function rememberListing(listing) {
  if (!listing?.id) return;
  const previous = listings.get(listing.id) || {};
  const next = {...previous, id: listing.id};
  if (Array.isArray(listing.models) || Array.isArray(listing.chatModels) || Array.isArray(listing.allModels)) {
    // A newer listing sends chat-capable ids in `models` and labels them; the
    // filter is the fallback for a flat list that was not pre-filtered.
    const flat = idList(listing.models), chat = idList(listing.chatModels), all = idList(listing.allModels);
    next.chatModels = (chat.length ? chat : flat.filter(isChatModel)).slice(0, MODEL_CACHE);
    next.models = (flat.length ? flat : next.chatModels).slice(0, MODEL_CACHE);
    next.allModels = (all.length ? all : next.models).slice(0, MODEL_CACHE);
    next.idsKnown = true;
  }
  if (listing.labels !== undefined) next.labels = {...(previous.labels || {}), ...labelMap(listing.labels)};
  for (const key of ['baseUrl', 'protocol', 'apiVersion']) {
    if (listing[key] !== undefined) next[key] = String(listing[key] || '');
  }
  if (listing.hasHeaders !== undefined) next.hasHeaders = idList(listing.hasHeaders).slice(0, 40);
  if (listing.keyOptional !== undefined) next.keyOptional = Boolean(listing.keyOptional);
  if (listing.modelsAt !== undefined) next.modelsAt = listing.modelsAt || null;
  if (listing.modelsError !== undefined) next.modelsError = String(listing.modelsError || '');
  if (listing.modelsTruncated !== undefined) next.modelsTruncated = Boolean(listing.modelsTruncated);
  listings.set(listing.id, next);
}
/** A provider row with what the panel knows, from the listing if this response
 * carried it and from the cache otherwise. `chatModels` stays null when the page
 * has never seen the ids, so a row falls back to the count the summary reported. */
const providerView = p => {
  const cached = listings.get(p.id) || {};
  const fellBack = !Array.isArray(p.models) && !Array.isArray(p.chatModels) && !Array.isArray(p.allModels) && !cached.idsKnown;
  return {...p,
    baseUrl: p.baseUrl || cached.baseUrl || '',
    protocol: p.protocol || cached.protocol || '',
    apiVersion: p.apiVersion || cached.apiVersion || '',
    keyOptional: p.keyOptional ?? cached.keyOptional ?? false,
    hasHeaders: Array.isArray(p.hasHeaders) ? idList(p.hasHeaders) : cached.hasHeaders || [],
    labels: {...(cached.labels || {}), ...labelMap(p.labels)},
    modelsError: p.modelsError || cached.modelsError || '',
    modelsTruncated: p.modelsTruncated ?? cached.modelsTruncated ?? false,
    models: (Array.isArray(p.models) ? idList(p.models) : cached.models || []).slice(0, MODEL_CACHE),
    chatModels: fellBack ? null : (Array.isArray(p.chatModels) ? idList(p.chatModels) : cached.chatModels || []).slice(0, MODEL_CACHE),
    allModels: (Array.isArray(p.allModels) ? idList(p.allModels) : cached.allModels || []).slice(0, MODEL_CACHE)};
};
/** Chat-capable count for a row: the ids when the page has them, else the count
 * the summary reported. */
const chatCount = p => (Array.isArray(p.chatModels) ? p.chatModels.length : Number(p.modelCount ?? 0));
/** Ids past the chat filter, so a row can show the whole catalogue was read. */
const listedCount = p => (Array.isArray(p.allModels) ? p.allModels.length : 0);

const protocolName = id => protocolById(id)?.label || String(id || DEFAULT_PROTOCOL);
const needsApiVersion = protocol => Boolean(protocolById(protocol)?.needsApiVersion);
// An empty value means "let the server read the host", which is what a custom
// endpoint wants: paste an Anthropic URL and it speaks Messages.
const protocolSelect = current => `<select class="input" name="protocol" data-action="ai-protocol"><option value=""${normaliseProtocol(current) ? '' : ' selected'}>Auto-detect from URL</option>${PROTOCOLS.map(p => `<option value="${esc(p.id)}"${p.id === normaliseProtocol(current) ? ' selected' : ''}>${esc(p.label)}</option>`).join('')}</select>`;
/** Azure is per-tenant and a custom gateway is anyone's, so both ship no endpoint:
 * the option has to say the URL is the user's to type. */
const presetLabel = preset => (preset.needsEndpoint ? `${preset.label} (enter your endpoint)` : preset.label);
const ENDPOINT_HINTS = {azure: 'https://NAME.openai.azure.com', custom: 'https://your-gateway.example/v1'};
const BASE_PLACEHOLDER = 'https://api.openai.com/v1';
const presetSelect = () => `<select class="input" name="preset" data-action="ai-preset"><option value="">Choose a provider…</option>${PROVIDER_PRESETS.map(p => `<option value="${esc(p.id)}">${esc(presetLabel(p))}</option>`).join('')}</select>`;
/** A picker of model ids. The value stays the id so free text still works, and
 * `labels[id]` is what the list shows when the provider names its models. */
const modelOptions = (models, labels = {}) => idList(models).slice(0, MODEL_LIMIT).map(id => {
  const shown = String(labelMap(labels)[id] ?? '').trim();
  return shown && shown !== id
    ? `<option value="${esc(id)}" label="${esc(shown)}">${esc(shown)}</option>`
    : `<option value="${esc(id)}"></option>`;
}).join('');
/** The datalist for a provider's chat-capable models, labelled when the provider
 * names them. The AI page and the per-bot override both offer this list. */
export const providerModelOptions = p => {
  const view = providerView(p || {});
  return modelOptions(view.chatModels || [], view.labels);
};
/** Azure wants its api-version in the query string. The field is in both forms but
 * hidden (and disabled, so it never posts) unless the protocol needs it, so the
 * form does not grow for everyone else. */
const apiVersionField = (value = '', shown = false) => `<div data-ai-version${shown ? '' : ' hidden'}>${field('API version', textInput('apiVersion', {value, placeholder: '2024-10-21', autocomplete: 'off', ...(shown ? {} : {disabled: true})}), 'Azure only - the value from your deployment.')}</div>`;
/** Show or hide the API version field for the protocol now selected. Client-side,
 * so switching presets costs no round trip. */
function syncApiVersionField(form, protocol) {
  const wrap = form?.querySelector?.('[data-ai-version]');
  if (!wrap) return;
  const needed = needsApiVersion(protocol);
  wrap.hidden = !needed;
  const input = wrap.querySelector('[name=apiVersion]');
  if (input) input.disabled = !needed;
}
/** Custom request headers, one `Name: value` per line. */
const headersField = value => field('Custom headers', `<textarea class="input" name="headers" rows="3" placeholder="X-Api-Key: ... / anthropic-beta: ..." autocomplete="off" spellcheck="false">${esc(value)}</textarea>`, 'Optional: one Name: value per line, sent with every request.');
/** Custom request headers, one `Name: value` per line. Returns the object the
 * server stores plus any line that could not be read: a dropped typo used to be
 * silent, and the only symptom was a 401 from the provider. */
function parseHeaders(text) {
  const headers = {}, invalid = [];
  String(text || '').split('\n').forEach((line, index) => {
    const raw = line.trim();
    if (!raw || raw.startsWith('#')) return;
    const at = raw.indexOf(':');
    const name = at < 1 ? '' : raw.slice(0, at).trim();
    const value = at < 1 ? '' : raw.slice(at + 1).trim();
    // The same name rule the server enforces, checked here so the sheet says so
    // instead of accepting a line and then losing it.
    if (!name || !value || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(name)) invalid.push({line: index + 1, text: raw.slice(0, 60)});
    else headers[name] = value;
  });
  return {headers, invalid};
}
/** The error to show when a header line could not be read, or ''. */
const headerProblem = invalid => (invalid.length
  ? `Header line${invalid.length > 1 ? 's' : ''} ${invalid.map(item => item.line).join(', ')} could not be read. Use one "Name: value" per line.`
  : '');
const modelsToast = (p, verb) => p.modelsError
  ? `Provider "${p.label}" ${verb}, but its model list could not be read: ${p.modelsError}`
  : `Provider "${p.label}" ${verb} with ${chatCount(providerView(p))} model(s).`;

/** Rename, re-point or rotate the key of a saved provider. */
function editProviderSheet(provider) {
  const view = providerView(provider);
  const saved = (view.hasHeaders || []).map(esc).join(', ');
  const headerNote = view.hasHeaders?.length
    ? note(`Saved headers: ${saved}. Values are never sent to this page, and an empty box keeps them; anything you type replaces the whole set.`)
    : note('Custom headers are optional: one Name: value per line, sent with every request.');
  openSheet(`<form id="ai-edit-form" class="form">
    <input type="hidden" name="id" value="${esc(provider.id)}">
    ${field('Name', textInput('label', {value: provider.label, required: true, maxlength: 80}))}
    ${field('Base URL', textInput('baseUrl', {value: view.baseUrl, placeholder: `https://… (blank keeps ${provider.host || 'the saved URL'})`, autocomplete: 'off'}))}
    ${field('Protocol', protocolSelect(provider.protocol), 'The body shape this endpoint speaks.')}
    ${apiVersionField(view.apiVersion, needsApiVersion(view.protocol))}
    ${field('New API key (leave blank to keep the saved one)', textInput('apiKey', {type: 'password', autocomplete: 'off'}))}
    ${headersField('')}
    ${headerNote}
    ${note('Changing the endpoint or the key re-reads the model list with the saved key.')}
    <div class="sheet-actions">${btn('Save provider', null, {kind: 'primary', type: 'submit', wide: true})}${btn('Cancel', 'close-sheet', {wide: true})}</div>
  </form>`, {title: `Edit ${provider.label}`, sub: provider.host});
}

function aiPanel(res) {
  // Keep every listing this response carried, so switching the default provider
  // repaints the picker and the edit sheet from memory, without a round trip.
  for (const p of res.providers || []) if (!listings.has(p.id) && Array.isArray(p.chatModels || p.models)) rememberListing(p);
  const providers = (res.providers || []).map(providerView);
  const rows = providers.length
    ? providers.map(p => {
      // N is what can answer a chat; the rest of the account's catalogue is a
      // quiet count beside it, so a long model list is visibly read in full.
      const chat = chatCount(p), listed = listedCount(p);
      const extra = listed > chat ? ` (+${listed - chat} listed)` : '';
      const version = needsApiVersion(p.protocol) && p.apiVersion ? ` · api-version ${esc(p.apiVersion)}` : '';
      return actionRow(
        `${esc(p.label)} ${p.isDefault || p.id === res.defaultProviderId ? tag('default', 'good') : ''}`,
        `${esc(p.host)} · ${esc(protocolName(p.protocol))} · ${chat} model(s)${extra}${p.modelsTruncated ? ' · list capped' : ''}${version}${p.modelsError ? ` ${tag(p.modelsError, 'warn')}` : ''}`,
        btn('Test', 'ai-test-provider', {id: p.id, small: true})
          + btn('Refresh models', 'ai-load-models', {id: p.id, small: true})
          + btn('Edit', 'ai-edit-provider', {id: p.id, small: true})
          + (p.id === res.defaultProviderId ? '' : btn('Make default', 'ai-default-provider', {id: p.id, small: true}))
          + btn('Delete', 'ai-delete-provider', {kind: 'danger', id: p.id, small: true}),
      );
    }).join('')
    : empty('No providers yet');
  const add = `<form id="ai-provider-form">
    ${field('Provider preset', presetSelect(), 'Fills the name, endpoint and protocol below. Azure and a custom gateway ask you to type the endpoint.')}
    ${field('Name', textInput('label', {required: true, maxlength: 80, placeholder: 'OpenAI, Groq, my router'}))}
    ${field('Base URL', textInput('baseUrl', {required: true, placeholder: BASE_PLACEHOLDER, autocomplete: 'off'}))}
    ${field('Protocol', protocolSelect(''), 'The body shape this endpoint speaks. Auto-detect reads the host; chat completions is what almost every other provider accepts.')}
    ${apiVersionField('', false)}
    ${field('API key', textInput('apiKey', {type: 'password', required: true, autocomplete: 'off'}))}
    ${headersField('')}
    ${btn('Save provider', null, {kind: 'primary', type: 'submit'})}
  </form>`;
  const options = providers.map(p => `<option value="${esc(p.id)}" ${p.id === res.defaultProviderId ? 'selected' : ''}>${esc(p.label)}</option>`).join('');
  const picked = providers.find(p => p.id === res.defaultProviderId) || providers[0];
  const defaults = providers.length ? `<form id="ai-default-form">
    ${field('Default provider', `<select class="input" name="providerId" data-action="ai-default-provider-pick">${options}</select>`)}
    ${field('Default model', textInput('model', {value: res.defaultModel || '', placeholder: 'auto, gpt-4o-mini, llama-3.3-70b', list: 'ai-models', autocomplete: 'off'}), 'Pick one from the list, or type an id the provider accepts.')}
    <datalist id="ai-models">${providerModelOptions(picked)}</datalist>
    <p>${btn('Load models', 'ai-load-models', {small: true})} ${btn('Save', null, {kind: 'primary', type: 'submit'})}</p>
  </form>` : '';
  return note('Bring your own key. Five wire protocols work: OpenAI chat completions, OpenAI responses, Anthropic Messages for Claude, Google Gemini, and Azure OpenAI (which needs your resource endpoint and an API version). The model list comes from the provider with your saved key, so the picker shows models that key can actually use. Keys are stored encrypted and never shown again - only the provider name, host, model list and the NAMES of any custom headers are visible. Local servers (Ollama, LM Studio, vLLM, Jan) accept any string as the key.')
    + box(rows, `Providers, ${providers.length}`)
    + box(add, 'Add a provider')
    + (defaults ? box(defaults, 'Default for this workspace') : '');
}

/** Fetches what the page needs and returns its body HTML (no page header). Throws on API error. */
export async function adminPage(kind) {
  if (kind === 'ai') {
    const res = await api('/api/ai');
    // Admin-only detail (endpoints, cached model ids, catalogue errors). The demo
    // shim has no such route, so a failure just falls back to the summary.
    const full = await api('/api/ai/providers').catch(() => null);
    if (full?.providers?.length) { full.providers.forEach(rememberListing); return aiPanel({...res, providers: full.providers}); }
    return aiPanel(res);
  }
  if (kind === 'team') {
    const [users, sessions] = await Promise.all([api('/api/users'), api('/api/sessions')]);
    return teamPanel(users, sessions);
  }
  if (kind === 'data') {
    const [creds, retention] = await Promise.all([api('/api/credentials'), api('/api/retention/preview')]);
    return credentialsPanel(creds.credentials || []) + retentionPanel(retention.policy, retention.preview)
      // A backup carries every account's password hash, so only the owner gets it.
      + (store.state?.me?.role === 'owner' ? backupPanel() : note('Backup and restore are available to the workspace owner.'));
  }
  if (kind === 'notifications') {
    const [list, prefs, push] = await Promise.all([api('/api/notifications'), api('/api/notification-prefs'), pushStatus()]);
    return notificationsPanel(list.notifications || [], prefs, push);
  }
  if (kind === 'workspaces') {
    return workspacesPanel(await api('/api/workspaces'));
  }
  if (kind === 'agents') {
    const res = await api('/api/agents');
    // Shown once: hand the code to this render and forget it.
    const pairing = lastPairing;
    lastPairing = null;
    return agentsPanel(res, pairing);
  }
  throw new Error(`Unknown admin page: ${kind}`);
}

/** Everything on screen belongs to the workspace that was just left, so the
 * app starts again from the chat list instead of patching each piece. */
function enterWorkspace() {
  location.hash = '#chats';
  location.reload();
}

/** data-action handlers: (button, ctx) => Promise. ctx = {reload: () => Promise} re-renders the current admin page. */
export const adminActions = {
  'notifications-read-all': async (button, ctx) => {
    const snap = await api('/api/notifications');
    const ids = (snap.notifications || []).filter(n => n.status !== 'read').map(n => n.id);
    await api('/api/notifications/read', 'POST', {ids});
    await sync();
    await ctx.reload();
  },
  'notification-read': async (button, ctx) => {
    await api('/api/notifications/read', 'POST', {ids: [button.dataset.id]});
    await sync();
    await ctx.reload();
  },
  'push-on': async (button, ctx) => {
    await enablePush();
    toast('Push is on for this device.');
    await ctx.reload();
  },
  'push-off': async (button, ctx) => {
    await disablePush();
    toast('Push is off for this device.');
    await ctx.reload();
  },
  'push-remove': async (button, ctx) => {
    // A stale device cannot be reached to unsubscribe itself, so this is the
    // only way to stop sending to it. The current device is allowed too: it is
    // the same thing the Turn off button does, and refusing it here would read
    // as a broken button.
    await api('/api/push/subscriptions', 'DELETE', {endpoint: button.dataset.endpoint});
    toast('That device will not be sent to again.');
    await ctx.reload();
  },
  'push-test': async () => {
    const {results} = await api('/api/push/test', 'POST', {});
    const failed = results.filter(r => r.startsWith('failed'));
    if (failed.length) throw new Error(failed[0].replace(/^failed: /, ''));
    toast(`Test sent to ${results.length} device${results.length === 1 ? '' : 's'}.`);
  },
  'workspace-switch': async button => {
    await api('/api/workspaces/switch', 'POST', {id: button.dataset.id});
    enterWorkspace();
  },
  'workspace-delete': async button => {
    const name = button.dataset.name;
    const typed = await askSheet(`Delete "${name}"?`, {sub: 'Its bots, posts, drafts and chats are removed for everyone and cannot be recovered. Type the workspace name to confirm.', submit: 'Delete workspace'});
    if (typed === null) return;
    await api('/api/workspaces/current', 'DELETE', {confirm: typed});
    enterWorkspace();
  },
  'revoke-sessions': async (button, ctx) => {
    if (!await confirmSheet('Sign out every other session?', {confirm: 'Sign out', danger: true})) return;
    await api('/api/sessions/revoke-all', 'POST', {});
    toast('Other sessions signed out.');
    await ctx.reload();
  },
  'revoke-session': async (button, ctx) => {
    await api(`/api/sessions/${button.dataset.id}`, 'DELETE', {});
    toast('Session revoked.');
    await ctx.reload();
  },
  'remove-user': async (button, ctx) => {
    if (!await confirmSheet('Remove this user from the workspace?', {confirm: 'Remove', danger: true})) return;
    await api(`/api/users/${button.dataset.id}`, 'DELETE', {});
    toast('User removed.');
    await ctx.reload();
  },
  'toggle-user-disabled': async (button, ctx) => {
    const disable = button.dataset.disable === '1';
    if (disable && !await confirmSheet('Disable this account?', {confirm: 'Disable', danger: true, detail: 'They cannot sign in. Their sessions are revoked.'})) return;
    await api(`/api/users/${button.dataset.id}`, 'PATCH', {disabled: disable});
    toast(disable ? 'Account disabled.' : 'Account enabled.');
    await ctx.reload();
  },
  'revoke-agent': async (button, ctx) => {
    if (!await confirmSheet('Revoke this local agent?', {confirm: 'Revoke', danger: true, detail: 'Its in-flight work is failed.'})) return;
    await api(`/api/agents/${button.dataset.id}`, 'DELETE', {});
    toast('Agent revoked.');
    await ctx.reload();
  },
  'toggle-agent-permission': async (button, ctx) => {
    const id = button.dataset.id;
    const permission = button.dataset.permission;
    const turnOn = button.dataset.on !== 'true';
    const siblings = document.querySelectorAll(`[data-action="toggle-agent-permission"][data-id="${CSS.escape(id)}"]`);
    const next = [...siblings]
      .filter(b => (b.dataset.permission === permission ? turnOn : b.dataset.on === 'true'))
      .map(b => b.dataset.permission);
    await api(`/api/agents/${id}`, 'PATCH', {permissions: next});
    toast('Permissions updated.');
    await ctx.reload();
  },
  'ai-delete-provider': async (button, ctx) => {
    if (!await confirmSheet('Remove this provider? Its saved key is deleted too.', {confirm: 'Delete', danger: true})) return;
    await api(`/api/ai/providers/${button.dataset.id}`, 'DELETE');
    toast('Provider removed.');
    await sync(); await ctx.reload();
  },
  'ai-default-provider': async (button, ctx) => {
    await api('/api/ai', 'PATCH', {providerId: button.dataset.id});
    toast('Default provider set.');
    await sync(); await ctx.reload();
  },
  'ai-edit-provider': async button => {
    // Read the listing again: the panel may be older than another admin's change.
    const providers = (await api('/api/ai')).providers || [];
    const provider = providers.find(p => p.id === button.dataset.id);
    if (!provider) throw new Error('Provider not found.');
    editProviderSheet(provider);
  },
  'ai-test-provider': async button => {
    const id = button.dataset.id;
    if (!id) return;
    // One small round trip with the stored key: the quickest proof the endpoint,
    // the key and the model really work. A failure is the provider's own message,
    // which the host toasts as-is.
    button.disabled = true;
    try {
      const res = await api(`/api/ai/providers/${id}/test`, 'POST', {});
      toast(`Connected · ${res.model || 'model'} · ${Number(res.ms) || 0} ms`);
    } finally {
      button.disabled = false;
    }
  },
  'ai-load-models': async (button, ctx) => {
    // A row button names its own provider; the default form uses its select.
    const form = button.closest('form'), id = button.dataset.id || form?.querySelector('[name=providerId]')?.value;
    if (!id) { toast('Add a provider first.'); return; }
    let res;
    try {
      res = await api(`/api/ai/providers/${id}/models`, 'POST', {});
    } catch (error) {
      // The server keeps the failure on the provider, so show it where the row is.
      const message = String(error.message || 'Could not read the model list.');
      rememberListing({id, modelsError: message});
      toast(message, true);
      if (button.dataset.id) await ctx.reload();
      return;
    }
    // A newer response names the chat-capable list and labels the ids; an older
    // one sends a single list, which the row still keeps in full.
    const models = (res.chatModels?.length ? res.chatModels : res.models) || [];
    rememberListing({id, models: res.models, chatModels: res.chatModels, allModels: res.allModels, labels: res.labels, protocol: res.protocol, modelsError: ''});
    const list = form?.querySelector('#ai-models') || document.getElementById('ai-models');
    if (list) list.innerHTML = modelOptions(models, res.labels || listings.get(id)?.labels || {});
    toast(models.length ? `${models.length} model(s) available — pick one above.` : 'The provider returned no model list.');
    if (button.dataset.id) await ctx.reload();
  },
  'reveal-credential': async button => {
    const res = await api(`/api/credentials/${button.dataset.id}/reveal`, 'POST', {});
    await askSheet('Credential value', {value: res.value, readonly: true, submit: 'Done', sub: 'Copy it now. It is not shown again.'});
  },
  'delete-credential': async (button, ctx) => {
    if (!await confirmSheet('Delete this credential?', {confirm: 'Delete', danger: true, detail: 'This cannot be undone.'})) return;
    await api(`/api/credentials/${button.dataset.id}`, 'DELETE', {});
    toast('Credential deleted.');
    await ctx.reload();
  },
  'prune-retention': async (button, ctx) => {
    const ok = await confirmSheet('Prune exhaust older than the retention policy?', {
      confirm: 'Prune',
      danger: true,
      detail: 'Drafts, candidates and evidence are never touched.',
    });
    if (!ok) return;
    const res = await api('/api/retention/prune', 'POST', {});
    toast(`Pruned ${res.events} event(s), ${res.doneTasks} task(s), ${res.runs} run(s).`);
    await ctx.reload();
  },
  'backup-export': async () => {
    const doc = await api('/api/admin/backup');
    const blob = new Blob([JSON.stringify(doc, null, 2)], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'agent-control-backup.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Backup downloaded.');
  },
  'backup-restore': async (button, ctx) => {
    const text = (document.getElementById('restore-doc')?.value || '').trim();
    if (!text) throw new Error('Paste a backup document first.');
    // Parse before asking, so a bad paste fails before the user confirms.
    let doc;
    try { doc = JSON.parse(text); } catch { throw new Error('That is not a valid backup document.'); }
    if (!await confirmSheet('Replace this workspace with the pasted backup?', {confirm: 'Restore', danger: true})) return;
    // The server validates the request body itself as the backup document.
    const res = await api('/api/admin/restore', 'POST', {...doc, force: true});
    toast(`Restored ${res.restored} row(s).`);
    await sync();
    await ctx.reload();
  },
};

/** form submit handlers keyed by form id: (form, values, ctx). `values` = Object.fromEntries(new FormData(form)). */
export const adminForms = {
  'workspace-form': async (form, values) => {
    const created = await api('/api/workspaces', 'POST', {name: values.name});
    await api('/api/workspaces/switch', 'POST', {id: created.id});
    enterWorkspace();
  },
  'workspace-rename-form': async (form, values, ctx) => {
    await api('/api/workspaces/current', 'PATCH', {name: values.name});
    toast('Workspace renamed.');
    await sync();
    await ctx.reload();
  },
  'pairing-form': async (form, values, ctx) => {
    const permissions = [...form.querySelectorAll('input[name="permissions"]:checked')].map(x => x.value);
    lastPairing = await api('/api/agents/pair', 'POST', {label: values.label, permissions});
    await ctx.reload();
    toast('Pairing code created. It is shown once.');
  },
  'ai-provider-form': async (form, values, ctx) => {
    const parsed = parseHeaders(values.headers), problem = headerProblem(parsed.invalid);
    if (problem) throw new Error(problem);
    const headers = parsed.headers;
    const p = await api('/api/ai/providers', 'POST', {
      label: values.label,
      // A pasted endpoint path ("…/v1/chat/completions") is trimmed back to its base.
      baseUrl: normaliseBaseUrl(values.baseUrl, values.protocol),
      apiKey: values.apiKey,
      protocol: values.protocol || undefined,
      preset: values.preset || undefined,
      apiVersion: (values.apiVersion || '').trim() || undefined,
      headers: Object.keys(headers).length ? headers : undefined,
    });
    rememberListing(p);
    form.reset();
    // reset() restores the empty protocol but not the hidden branch, so re-apply it.
    syncApiVersionField(form, form.elements.namedItem('protocol')?.value || '');
    toast(modelsToast(p, 'saved'));
    // Providers change what "AI is available" means app-wide, so refresh the snapshot.
    await sync(); await ctx.reload();
  },
  'ai-edit-form': async (form, values, ctx) => {
    // A blank endpoint or key keeps what is stored, so only what was typed travels.
    const body = {label: values.label, protocol: values.protocol};
    if ((values.baseUrl || '').trim()) body.baseUrl = normaliseBaseUrl(values.baseUrl, values.protocol);
    if ((values.apiKey || '').trim()) body.apiKey = values.apiKey.trim();
    if ((values.apiVersion || '').trim()) body.apiVersion = values.apiVersion.trim();
    // Values are never shown here, so an empty box keeps the saved set and anything
    // typed replaces it wholesale - text with no usable line clears the set, which
    // is what the sheet says it will do.
    const headerText = String(values.headers || '').trim();
    if (headerText) {
      const parsed = parseHeaders(headerText), problem = headerProblem(parsed.invalid);
      if (problem) throw new Error(problem);
      body.headers = parsed.headers;
    }
    const p = await api(`/api/ai/providers/${values.id}`, 'PATCH', body);
    rememberListing(p);
    closeSheet();
    toast(modelsToast(p, 'updated'));
    await sync(); await ctx.reload();
  },
  'ai-default-form': async (form, values, ctx) => {
    await api('/api/ai', 'PATCH', {providerId: values.providerId, model: values.model || ''});
    toast('Default model saved.');
    await sync(); await ctx.reload();
  },
  'create-user-form': async (form, values, ctx) => {
    const res = await api('/api/users', 'POST', {email: values.email, password: values.password, role: values.role});
    form.reset();
    toast(res.existing ? `${res.email} already had an account and now belongs to this workspace too. Their password is unchanged.` : `User ${res.email || values.email} created.`);
    await ctx.reload();
  },
  'credential-form': async (form, values, ctx) => {
    const res = await api('/api/credentials', 'POST', {name: values.name, kind: values.kind, value: values.value});
    form.reset();
    toast(`Stored credential "${res.name}".`);
    await ctx.reload();
  },
  'notif-prefs-form': async (form, values, ctx) => {
    const checked = name => form.querySelector(`[name="${name}"]`)?.checked;
    await api('/api/notification-prefs', 'PATCH', {
      inApp: checked('inApp'),
      webhook: checked('webhook'),
      webhookCredentialId: values.webhookCredentialId || null,
      email: checked('email'),
      emailAddress: values.emailAddress || '',
    });
    toast('Notification preferences saved.');
    await ctx.reload();
  },
};

/** `change` event handlers keyed by the control's data-action: (control, ctx). */
export const adminChanges = {
  // Picking a preset fills the endpoint fields and hides or shows the API version;
  // the protocol follows the preset.
  'ai-preset': control => {
    const preset = presetById(control.value), form = control.form;
    if (!preset || !form) return;
    const set = (name, value) => { const node = form.elements.namedItem(name); if (node && typeof value === 'string') node.value = value; };
    set('label', preset.label);
    // A custom endpoint or a per-tenant cloud ships no URL, so clear the box and
    // say what belongs there instead of leaving the last provider's endpoint.
    set('baseUrl', preset.needsEndpoint ? '' : preset.baseUrl);
    const url = form.elements.namedItem('baseUrl');
    if (url) url.placeholder = preset.needsEndpoint ? (ENDPOINT_HINTS[preset.id] || BASE_PLACEHOLDER) : BASE_PLACEHOLDER;
    set('protocol', preset.protocol);
    syncApiVersionField(form, preset.protocol);
  },
  // Azure is the only protocol that needs the query-string version, so the field
  // appears and disappears with the selection, without a server round trip.
  'ai-protocol': control => syncApiVersionField(control.form, control.value),
  'ai-default-provider-pick': control => {
    const list = control.form?.querySelector('#ai-models');
    if (list) list.innerHTML = providerModelOptions({id: control.value});
  },
  'set-role': async (control, ctx) => {
    try {
      await api(`/api/users/${control.dataset.id}`, 'PATCH', {role: control.value});
    } catch (error) {
      // Put the select back to the server's value before the host reports the error.
      await ctx.reload();
      throw error;
    }
    toast('Role updated.');
    await ctx.reload();
  },
};
