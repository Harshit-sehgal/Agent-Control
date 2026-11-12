/** Admin pages inside Settings: Models and keys, Connectors, Notifications, Workspaces, Team and access,
 * Local agents, and Data and security. `adminPage(kind)` fetches and returns the body HTML; the handler
 * tables are wired by the host's delegated click, submit and change listeners. Handlers do not catch
 * errors, the host toasts them.
 *
 * The look is Settings and Connectors: a titled card (`.st-g`, `.cd`), rows with a switch or a small
 * button on the right, a segmented pill for a choice of few, and one primary action per card. */
import {esc, icon, btn, field, note, empty, tag, fullDate, textInput, switchBtn, modelSelect, effortPicker, runFullApp, demoList} from './ui-kit.js?v=71b92f8de6';
import {store, api, sync, isAdmin, isStaticDemo} from './ui-store.js?v=71b92f8de6';
import {toast, openSheet, closeSheet, confirmSheet, askSheet} from './ui-dialogs.js?v=71b92f8de6';
import {PROTOCOLS, PROVIDER_PRESETS, presetById, protocolById, normaliseProtocol, normaliseBaseUrl, isChatModel, DEFAULT_PROTOCOL} from './ai-presets.js?v=71b92f8de6';
import {pushStatus, enablePush, disablePush} from './ui-push.js?v=71b92f8de6';
import {connectorsPanel, loadConnectors, connectActions, connectForms} from './ui-connect.js?v=71b92f8de6';
import {cliDraft, modelChoices, chosenModel, effortChoices, OTHER_MODEL, agentCliRows, agentPermissionRows, agentWorkLine, subscriptionLine, SIGN_IN_HINT} from './ui-connect-model.js?v=71b92f8de6';
import {LOCAL_CLI_ENGINES, LOCAL_CLI_KIND} from './ai-presets.js?v=71b92f8de6';

/** The pages Settings can load into its body. Only the keys are read (is this a page?). */
export const ADMIN_PAGES = {notifications: true, workspaces: true, team: true, agents: true, data: true, connectors: true, ai: true};

/** The pairing code is shown once, so it lives only in memory until the page is left. */
let lastPairing = null;
/** Which "Add a model" form is open: the choice survives the repaint that follows adding one. */
let addKind = 'sub';

/* ---------- the pieces every page is made of ---------- */

const dataAttrs = data => Object.entries(data || {}).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('');
const cap = text => String(text).charAt(0).toUpperCase() + String(text).slice(1);
/** A titled card. `aside` sits opposite the title (a status tag or one small button). */
const group = (label, inner, {pad = false, aside = '', cls = ''} = {}) => `<section class="st-g">${label ? (aside ? `<div class="ad-hd"><h4 class="st-h">${esc(label)}</h4>${aside}</div>` : `<h4 class="st-h">${esc(label)}</h4>`) : ''}<div class="cd${pad ? ' pad' : ''}${cls ? ` ${cls}` : ''}">${inner}</div></section>`;
/** A row: title (markup the caller has escaped), a quiet line under it, and whatever sits on the right. */
const line = (title, sub = '', right = '', cls = '') => `<div class="rw${cls ? ` ${cls}` : ''}"><span class="w">${title}${sub ? `<small>${sub}</small>` : ''}</span>${right}</div>`;
const switchRow = (title, sub, on, label, attrs, extra = '') => `<div class="rw"><span class="w">${esc(title)}${sub ? `<small>${sub}</small>` : ''}</span>${extra}${switchBtn(on, label, attrs)}</div>`;
/** A card in a list, headed the way a Connectors card is: a round icon, a name, a line, a tag. */
const entry = (glyph, title, sub, aside, body = '') => `<div class="cn-card cn-mcp"><div class="cn-head"><span class="cn-ico" aria-hidden="true">${icon(glyph, 18)}</span><span class="w"><b>${title}</b>${sub ? `<small>${sub}</small>` : ''}</span>${aside}</div>${body}</div>`;
const acts = html => `<div class="cn-acts">${html}</div>`;
const quiet = text => `<div class="cd pad"><p class="st-quiet">${esc(text)}</p></div>`;
const hint = html => `<p class="st-note">${html}</p>`;
const panel = (...parts) => `<div class="ad-panel">${parts.filter(Boolean).join('')}</div>`;
/** A choice of few that acts at once (a role): the pills of Settings. */
const seg = (label, items, action, data = {}) => `<span class="st-seg" role="group" aria-label="${esc(label)}">${items.map(([value, text, on]) => `<button type="button" data-action="${esc(action)}"${dataAttrs({...data, value})} aria-pressed="${on ? 'true' : 'false'}">${esc(text)}</button>`).join('')}</span>`;
/** A choice of few inside a form: the same pills over radio buttons, so the form reads its value. */
const radioSeg = (legend, name, options, checked, action = '') => `<fieldset class="cn-via"><legend class="field-label">${esc(legend)}</legend><div class="st-seg" role="radiogroup" aria-label="${esc(legend)}">${options.map(([value, text]) => `<label><input type="radio" name="${esc(name)}" value="${esc(value)}"${action ? ` data-action="${esc(action)}"` : ''}${value === checked ? ' checked' : ''}><span>${esc(text)}</span></label>`).join('')}</div></fieldset>`;
const kebab = (action, label, data) => `<button type="button" class="rbtn small ad-more" data-action="${esc(action)}"${dataAttrs(data)} aria-haspopup="dialog" aria-label="${esc(label)}">${icon('dots', 18)}</button>`;
const withCode = text => esc(text).replace(/`([^`]+)`/g, '<code>$1</code>');

/* ---------- Workspaces ---------- */

function workspacesPanel(res) {
  const list = res.workspaces || [], current = list.find(w => w.current);
  const rows = list.map(w => line(esc(w.name), `You are ${esc(w.role)}`, w.current ? tag('current', 'good') : btn('Switch', 'workspace-switch', {id: w.id, small: true}))).join('');
  const create = res.canCreate
    ? `<form id="workspace-form">${group('New workspace', `<div class="ad-form">${field('Name', textInput('name', {required: true, maxlength: 60, placeholder: 'Client work'}))}<div class="cn-acts">${btn('Create workspace', null, {kind: 'primary', type: 'submit'})}</div></div>`, {pad: true})}</form>`
    : hint('Only an owner of the first workspace can create workspaces.');
  const manage = current?.role === 'owner'
    ? `<form id="workspace-rename-form">${group('This workspace', `<div class="ad-form">${field('Name', `<input class="input" name="name" type="text" value="${esc(current.name)}" required maxlength="60">`)}<div class="cn-acts">${btn('Rename', null, {kind: 'primary', type: 'submit'})}${current.id === 'default' ? '' : btn('Delete this workspace', 'workspace-delete', {kind: 'danger', small: true, data: {name: current.name}})}</div></div>`, {pad: true})}</form>`
    : '';
  return panel(group(`Your workspaces, ${list.length}`, rows), create, manage, hint('Switching changes what this browser shows. People are added to one workspace at a time, under Team and access.'));
}

/* ---------- Notifications ---------- */

const PUSH_HELP = {
  insecure: 'Push needs a secure address. Open this app over https, or on localhost.',
  unsupported: 'This browser cannot receive push here. On an iPhone or iPad, add this app to the Home Screen first, then open it from there.',
  blocked: 'Notifications are blocked for this site. Allow them in the browser settings, then reload.',
  off: 'Reminders, failed tasks and alerts on this device, even when the app is closed.',
  on: 'This device gets reminders, failed tasks and alerts, even when the app is closed.',
};
/** The host of a push endpoint, and nothing else: the path is a capability URL,
 * so it is only carried to the button that deletes it. */
function endpointHost(endpoint) {
  try { return new URL(endpoint).host; } catch { return 'a device this browser cannot read'; }
}

function devicesCard(push) {
  const endpoints = Array.isArray(push.endpoints) ? push.endpoints : [];
  if (endpoints.length < 1) return '';
  const rows = endpoints.map(endpoint => line(
    `${esc(endpointHost(endpoint))}${endpoint === push.mine ? ` ${tag('this device', 'good')}` : ''}`,
    endpoint === push.mine ? 'Signed in here.' : 'Signed in somewhere else.',
    btn('Remove', 'push-remove', {small: true, kind: 'danger', data: {endpoint}}),
  )).join('');
  return group(`Devices, ${endpoints.length}`, rows, {aside: push.state === 'on' ? btn('Send a test', 'push-test', {small: true}) : ''});
}

/** The ways to hear about things. Webhook and email show only when they can really deliver: a webhook needs a
 * stored webhook address to send to, and email needs the server to have a mailbox or relay (`emailReady`). One that
 * is already switched on stays visible so it can be switched off. */
function channelsCard(prefs, push, credentials, emailReady) {
  const hooks = credentials.filter(c => c.kind === 'webhook' && !c.expired);
  const others = push.devices - (push.state === 'on' ? 1 : 0);
  const pushable = push.state === 'on' || push.state === 'off';
  const pushSub = `${esc(PUSH_HELP[push.state] || 'Push status is unavailable in this browser.')}${others > 0 ? ` ${others} other device${others === 1 ? '' : 's'} of yours ${others === 1 ? 'is' : 'are'} subscribed.` : ''}`;
  let rows = switchRow('In the app', 'Listed under Recent on this page.', prefs.inApp, 'In the app', ' data-action="notif-pref" data-pref="inApp"')
    + switchRow('Push on this device', pushSub, push.state === 'on', 'Push on this device', ` data-action="push-toggle"${pushable ? '' : ' disabled'}`);
  if (hooks.length || prefs.webhook) {
    const picked = prefs.webhookCredentialId || hooks[0]?.id || '';
    const choices = hooks.map(c => `<option value="${esc(c.id)}"${c.id === picked ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
    rows += switchRow('Webhook', 'Posts each notice to a web address you saved under Data and security.', prefs.webhook, 'Webhook', ' data-action="notif-pref" data-pref="webhook"')
      + (hooks.length ? line('Send to', '', `<select class="input ad-sel" name="webhookCredentialId" data-action="notif-webhook-pick" aria-label="Webhook address">${choices}</select>`) : '');
  }
  if (emailReady || prefs.email) {
    rows += switchRow('Email', emailReady ? 'Sends each notice to the address below.' : 'Nothing is sent: this server has no mailbox or relay (SMTP_HOST or EMAIL_RELAY_URL). Switch it off, or set one.', prefs.email, 'Email', ' data-action="notif-pref" data-pref="email"')
      + `<form id="notif-email-form" class="rw ad-addr">${textInput('emailAddress', {type: 'email', value: prefs.emailAddress || '', placeholder: 'you@example.com', 'aria-label': 'Email address', autocomplete: 'email'})}${btn('Save', null, {small: true, type: 'submit'})}</form>`;
  }
  return group('Tell me by', rows);
}

function notificationsPanel({list, prefs, push, credentials, emailReady}) {
  const unread = list.filter(n => n.status !== 'read');
  const shown = list.slice(0, 25);
  const items = shown.length
    ? shown.map(n => line(
      `${esc(n.title)}${n.status === 'read' ? '' : ` ${tag('new', 'good')}`}`,
      `${n.body ? `${esc(n.body)} · ` : ''}${n.channel && n.channel !== 'in_app' ? `${esc(n.channel)} · ` : ''}${esc(fullDate(n.created_at))}`,
      n.status === 'read' ? '' : btn('Mark read', 'notification-read', {id: n.id, small: true}),
    )).join('') + (list.length > shown.length ? `<div class="ad-lbl">${list.length - shown.length} older are kept</div>` : '')
    : '';
  const recent = shown.length
    ? group(unread.length ? `Recent, ${unread.length} new` : 'Recent', items, {aside: unread.length ? btn('Mark all read', 'notifications-read-all', {small: true}) : ''})
    : group('Recent', empty('No notifications yet', 'Reminders and alerts will show up here.'));
  return panel(recent, channelsCard(prefs, push, credentials, emailReady), devicesCard(push));
}

/* ---------- Team and access ---------- */

function teamPanel(usersRes) {
  const users = usersRes.users || [];
  // Least to most trusted, whatever order the server lists them in; a role this page has not heard of goes last.
  const offered = (usersRes.roles || []).filter(r => r !== 'owner');
  const choices = [...['viewer', 'member', 'admin'].filter(r => offered.includes(r)), ...offered.filter(r => !['viewer', 'member', 'admin'].includes(r))];
  const me = store.state?.me?.email;
  const members = users.map(user => {
    const isMe = me === user.email;
    const owner = user.role === 'owner';
    const role = owner ? '' : seg(`Role for ${user.email}`, choices.map(r => [r, cap(r), r === user.role]), 'set-role', {id: user.id});
    const disable = isMe || owner ? '' : btn(user.disabled ? 'Enable' : 'Disable', 'toggle-user-disabled', {id: user.id, small: true, data: {disable: user.disabled ? '0' : '1'}});
    const remove = isMe || owner ? '' : btn('Remove', 'remove-user', {kind: 'danger', id: user.id, small: true});
    const tags = `${owner ? tag('owner') : ''}${user.disabled ? tag('disabled', 'bad') : ''}${isMe ? tag('you', 'good') : ''}`;
    return entry('people', esc(user.email), `Joined ${esc(fullDate(user.createdAt))}`, tags, role + disable + remove ? acts(role + disable + remove) : '');
  });
  const invite = `<form id="create-user-form" class="ad-form">
    <div class="form-grid">${field('Email', textInput('email', {type: 'email', required: true}))}${field('Temporary password (min 8 chars)', textInput('password', {type: 'password', minlength: 8, required: true}))}</div>
    ${radioSeg('Role', 'role', [['viewer', 'Viewer'], ['member', 'Member'], ['admin', 'Admin']], 'member')}
    <p class="cn-testing">Someone who already has an account keeps their own password and is added to this workspace.</p>
    <div class="cn-acts">${btn('Create user', null, {kind: 'primary', type: 'submit'})}</div>
  </form>`;
  return panel(group(`Members, ${users.length}`, members.join(''), {cls: 'cn-list'}), group('Add a person', invite, {pad: true}));
}

/* ---------- Local agents ---------- */

const tone = status => (status === 'online' ? 'good' : status === 'revoked' ? 'bad' : 'warn');
const STATUS_WORD = {online: 'Online', stale: 'Not running now', paired: 'Not started yet', revoked: 'Revoked'};

/** One paired computer: its state, whether claude and codex are signed in there, what it may do, and Revoke. */
function agentCard(agent, actions) {
  if (agent.status === 'revoked') return group(agent.name, line('Revoked', 'It can no longer take work.'), {aside: tag('revoked', 'bad')});
  const cli = agentCliRows([agent])[0];
  const signIn = cli.engines.map(e => line(esc(e.name), e.status === 'signed-out' ? withCode(SIGN_IN_HINT) : '', tag(e.word, e.tone))).join('');
  const perms = agentPermissionRows(actions, agent.permissions || []).map(p => switchRow(p.label, `${esc(p.note)}${p.note ? ' · ' : ''}<code>${esc(p.id)}</code>`, p.on, p.label, ` data-action="toggle-agent-permission" data-id="${esc(agent.id)}" data-permission="${esc(p.id)}"`)).join('');
  const seen = agent.lastSeenAt ? `Last seen ${esc(fullDate(agent.lastSeenAt))}` : 'Not seen yet';
  const rows = line(seen, '', `<span class="pv">${esc(agentWorkLine(agent.tasks))}</span>`)
    + signIn + `<div class="ad-lbl">Allowed to</div>${perms}`
    + `<button type="button" class="rw bad" data-action="revoke-agent" data-id="${esc(agent.id)}"><span class="w">Revoke<small>Stops it taking work. Anything it is doing fails.</small></span></button>`;
  return group(agent.name, rows, {aside: tag(STATUS_WORD[agent.status] || agent.status, tone(agent.status))});
}

function pairingCard(pairing) {
  if (!pairing) return '';
  const command = `node agent/agent.mjs pair --server ${location.origin} --code ${pairing.code}`;
  return group('Pairing code', `<span class="code">${esc(pairing.code)}</span>
    <p class="cn-testing">Shown once, and it ends ${esc(fullDate(pairing.expiresAt))}. On the computer, from this app's folder, run:</p>
    <div class="cn-copy"><code>${esc(command)}</code>${btn('Copy', 'connector-copy', {small: true, glyph: 'copy', data: {text: command}})}</div>`, {pad: true});
}

function pairForm(actions) {
  // The admin chooses the scope when issuing the code; the device cannot widen it.
  const perms = agentPermissionRows(actions, actions).map(p => switchRow(p.label, `${esc(p.note)}${p.note ? ' · ' : ''}<code>${esc(p.id)}</code>`, true, p.label, ` data-action="ad-flip" data-permission="${esc(p.id)}"`)).join('');
  return `<form id="pairing-form">${group('Pair a computer', `<div class="ad-pad">${field('Name', textInput('label', {placeholder: 'Laptop', maxlength: 120}))}</div><div class="ad-lbl">It may</div>${perms}<div class="ad-foot">${btn('Create pairing code', null, {kind: 'primary', type: 'submit'})}</div>`)}</form>`;
}

function agentsPanel(res, pairing) {
  const agents = res.agents || [], actions = res.actions || [];
  const cards = agents.length
    ? agents.map(a => agentCard(a, actions)).join('')
    : quiet('No computer is paired yet. Pair one below to use your own Claude or ChatGPT plan, give bots a browser, or reach an MCP server that runs on your machine.');
  return panel(pairingCard(pairing), cards, pairForm(actions), hint('A computer runs only what you allow here. Revoke it any time.'));
}

/* ---------- Data and security ---------- */

/** Secrets the app keeps for itself (a model's key, a connector's sign-in): it uses them and never shows them, so the
 * server refuses to reveal them and there is no Reveal to press. They are managed under Models and keys and Connectors. */
const KIND_WORDS = {api_key: 'API key', webhook: 'Webhook', token: 'Token', other: 'Other'};
const APP_KEPT = {google_client: 'Google client', google_token: 'Google sign-in', connector_mcp: 'MCP server', ai_provider: 'Model key', ai_headers: 'Model headers'};
function credentialsPanel(list) {
  const rows = list.map(c => entry('key', esc(c.name), `Added ${esc(fullDate(c.createdAt))}${c.expiresAt ? ` · expires ${esc(fullDate(c.expiresAt))}` : ''}${c.createdBy ? ` · by ${esc(c.createdBy)}` : ''}`, tag(APP_KEPT[c.kind] || KIND_WORDS[c.kind] || c.kind),
    acts((APP_KEPT[c.kind] ? '' : btn('Reveal', 'reveal-credential', {id: c.id, small: true})) + btn('Delete', 'delete-credential', {kind: 'danger', id: c.id, small: true}))));
  const form = `<form id="credential-form" class="ad-form">
    ${field('Name', textInput('name', {required: true, maxlength: 120}))}
    ${radioSeg('Kind', 'kind', [['api_key', 'API key'], ['webhook', 'Webhook'], ['token', 'Token'], ['other', 'Other']], 'api_key')}
    ${field('Secret value', '<textarea class="input" name="value" rows="2" required autocomplete="off" spellcheck="false"></textarea>')}
    <div class="cn-acts">${btn('Store credential', null, {kind: 'primary', type: 'submit'})}</div>
  </form>`;
  return hint('Stored encrypted (AES-256-GCM). Values are never listed; revealing one is admin-only and written to the audit log.')
    + (rows.length ? group(`Credentials, ${list.length}`, rows.join(''), {cls: 'cn-list'}) : group('Credentials', empty('No credentials stored')))
    + group('Add a credential', form, {pad: true});
}

const RETENTION_LABELS = {events: 'Activity log', doneTasks: 'Finished tasks', runs: 'Run history'};
function retentionPanel(policy, preview) {
  const rows = Object.entries(policy || {}).map(([k, v]) => line(esc(RETENTION_LABELS[k] || k), '', `<span class="pv">${esc(String(v))} days</span>`)).join('');
  const counts = Object.entries(preview || {}).filter(([k, v]) => typeof v === 'number' && k !== 'dryRun');
  const total = counts.reduce((sum, [, v]) => sum + v, 0);
  const would = line(total ? 'Would be removed now' : 'Nothing to remove now', total ? esc(counts.filter(([, v]) => v).map(([k, v]) => `${RETENTION_LABELS[k] || k} ${v}`).join(' · ')) : '');
  return group('Retention', `${rows}${would}<div class="ad-foot">${btn('Prune now', 'prune-retention', {kind: 'danger', small: true})}</div>`)
    + hint('Pruning removes only old exhaust: events, finished tasks and runs. Bots, chats and memory are never touched.');
}

function backupPanel() {
  const restore = `<details class="cn-tools ad-restore"><summary>Restore from a backup${icon('chevron', 13)}</summary>
    <div class="ad-form"><textarea class="input" id="restore-doc" rows="3" placeholder="Paste a backup document here" aria-label="Backup document" autocomplete="off" spellcheck="false"></textarea>
    <div class="cn-acts">${btn('Restore from pasted document', 'backup-restore', {kind: 'danger', small: true})}</div></div></details>`;
  return group('Backup and restore', `<div class="ad-form"><div class="cn-acts">${btn('Download backup', 'backup-export', {kind: 'primary'})}</div>${restore}</div>`, {pad: true})
    + hint('A backup holds this workspace\'s data only; credentials and sessions never travel. Restoring replaces the workspace, so it asks first.');
}

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

/** What "no model" means in each dropdown: a subscription leaves it to its command, a key to the provider. */
const CLI_DEFAULT = 'Default (the CLI picks)', API_DEFAULT = 'The provider\'s default';
const defaultLabelFor = provider => (provider?.kind === LOCAL_CLI_KIND ? CLI_DEFAULT : API_DEFAULT);
/** Put new rows in a dropdown already on the page, keeping what was picked when it is still there. */
export function refillModelSelect(select, rows) {
  if (!select) return;
  const keep = select.value;
  select.innerHTML = rows.map(r => `<option value="${esc(r.value)}"${r.selected ? ' selected' : ''}>${esc(r.label)}</option>`).join('');
  if (keep && keep !== OTHER_MODEL && rows.some(r => r.value === keep)) select.value = keep;
  showOtherBox(select);
}
/** Other… opens a box for any id; any other row closes it. */
function showOtherBox(select) {
  const box = select?.parentElement?.querySelector('.model-other'); if (!box) return;
  // A grouped picker's typed-id rows are `<provider>|__other`.
  const open = select.value === OTHER_MODEL || select.value.endsWith(`|${OTHER_MODEL}`);
  box.hidden = !open; box.disabled = !open;
  if (open) box.focus();
}

const ENGINE_CHOICES = LOCAL_CLI_ENGINES.map(e => [e.id, e.label.replace(/ \(.*\)$/, '')]);
/** Use the Claude or ChatGPT plan you already pay for: no key, the model runs in the CLI on a paired computer. */
const subscriptionForm = () => `<form id="cli-provider-form" class="ad-form" autocomplete="off"${addKind === 'sub' ? '' : ' hidden'}>
    ${radioSeg('Which one', 'engine', ENGINE_CHOICES, 'claude', 'cli-engine')}
    ${field('Name', textInput('label', {maxlength: 80, placeholder: 'My Claude'}), 'Optional.')}
    ${field('Model', modelSelect(modelChoices({provider: {kind: LOCAL_CLI_KIND, engine: 'claude'}, defaultLabel: CLI_DEFAULT})), 'Pick one, or Other… to type a name.')}
    <div class="cn-acts">${btn('Add subscription', null, {kind: 'primary', type: 'submit'})}</div>
    <p class="cn-testing">No key is stored. The model runs through the command-line tool on a paired computer that is signed in to your account.</p>
  </form>`;

const apiForm = () => `<form id="ai-provider-form" class="ad-form"${addKind === 'api' ? '' : ' hidden'}>
    ${field('Provider', presetSelect(), 'Fills in the name and address. Azure and a custom gateway ask you to type the endpoint.')}
    ${field('Name', textInput('label', {required: true, maxlength: 80, placeholder: 'OpenAI, Groq, my router'}))}
    ${field('Base URL', textInput('baseUrl', {required: true, placeholder: BASE_PLACEHOLDER, autocomplete: 'off'}))}
    ${apiVersionField('', false)}
    ${field('API key', textInput('apiKey', {type: 'password', required: true, autocomplete: 'off'}), 'Stored encrypted and never shown again. A local server such as Ollama accepts any text.')}
    <details class="cn-tools"><summary>More options${icon('chevron', 13)}</summary><div class="ad-form ad-fold">
      ${field('Protocol', protocolSelect(''), 'Auto-detect reads the address. Chat completions is what almost every other provider accepts.')}
      ${headersField('')}
    </div></details>
    <div class="cn-acts">${btn('Save provider', null, {kind: 'primary', type: 'submit'})}</div>
  </form>`;

/** One saved provider. Test and Make default stay in sight; the rest is under the dots. */
function providerEntry(p, res, agents) {
  const isDefault = p.isDefault || p.id === res.defaultProviderId;
  const makeDefault = isDefault ? '' : btn('Make default', 'ai-default-provider', {id: p.id, small: true});
  const subscription = p.kind === LOCAL_CLI_KIND;
  const more = kebab('ai-more', `More for ${p.label}`, {id: p.id, name: p.label, kind: subscription ? 'sub' : 'api', host: p.host || ''});
  const star = isDefault ? tag('default', 'good') : '';
  // A subscription has no key and no catalogue: it is checked by what its agent says about the CLI's sign-in.
  if (subscription) return entry('chip', esc(p.label), esc(subscriptionLine(p, agents)), star, acts(btn('Check sign-in', 'ai-check-cli', {id: p.id, small: true}) + makeDefault + more));
  // N is what can answer a chat; the rest of the account's catalogue is a quiet count beside it.
  const chat = chatCount(p), listed = listedCount(p);
  const extra = listed > chat ? ` (+${listed - chat} listed)` : '';
  const version = needsApiVersion(p.protocol) && p.apiVersion ? ` · api-version ${esc(p.apiVersion)}` : '';
  const problem = p.modelsError ? `<p class="cn-msg">${esc(p.modelsError)}</p>` : '';
  return entry('key', esc(p.label), `${esc(p.host)} · ${esc(protocolName(p.protocol))} · ${chat} model(s)${extra}${p.modelsTruncated ? ' · list capped' : ''}${version}`, star,
    problem + acts(btn('Test', 'ai-test-provider', {id: p.id, small: true}) + makeDefault + more));
}

function aiPanel(res) {
  // Keep every listing this response carried, so switching the default provider
  // repaints the picker and the edit sheet from memory, without a round trip.
  for (const p of res.providers || []) if (!listings.has(p.id) && Array.isArray(p.chatModels || p.models)) rememberListing(p);
  const providers = (res.providers || []).map(providerView);
  const picked = providers.find(p => p.id === res.defaultProviderId) || providers[0];
  const modelLabel = picked ? `Default model for ${picked.label}` : '';
  const defaults = picked ? `<form id="ai-default-form" class="ad-form">
    <input type="hidden" name="providerId" value="${esc(picked.id)}">
    ${field(modelLabel, modelSelect(modelChoices({provider: picked, current: res.defaultModel || '', defaultLabel: defaultLabelFor(picked)})), 'Bots without a model of their own use it.')}
    ${effortPicker(effortChoices(res.defaultEffort || ''), {help: 'How hard every bot thinks unless it has its own setting. Higher is better on hard work, slower and costs more.'})}
    <div class="cn-acts">${btn('Save', null, {kind: 'primary', type: 'submit'})}</div>
  </form>` : '';
  const choose = `<div class="st-seg" role="group" aria-label="What to add">${[['sub', 'Subscription'], ['api', 'API key']].map(([key, text]) => `<button type="button" data-action="ai-add-kind" data-kind="${key}" aria-pressed="${key === addKind}">${text}</button>`).join('')}</div>`;
  const link = !isStaticDemo() && isAdmin()
    ? group('', `<button type="button" class="rw" data-action="settings-open" data-section="agents"><span class="w">Sign-in on your computers<small>Whether claude and codex are signed in is under Local agents.</small></span>${icon('chevron', 18)}</button>`)
    : '';
  return panel(
    hint('Bring your own key, or use the Claude or ChatGPT plan you already pay for. Keys are stored encrypted and never shown again.'),
    providers.length ? group('Models', providers.map(p => providerEntry(p, res, res.agents)).join(''), {cls: 'cn-list'}) : quiet('No model yet. Add one below.'),
    defaults && group('Default model', defaults, {pad: true}),
    group('Add a model', `<div class="ad-form">${choose}${subscriptionForm()}${apiForm()}</div>`, {pad: true}),
    link,
  );
}

/** Refill the Default model dropdown when the provider it is for has a fresh list. */
function fillDefaultPicker(id) {
  const form = document.getElementById('ai-default-form');
  if (!form || form.elements.namedItem('providerId')?.value !== id) return;
  const provider = providerView({...(listings.get(id) || {}), id, kind: 'api'});
  refillModelSelect(form.elements.namedItem('model'), modelChoices({provider, current: form.elements.namedItem('model').value, defaultLabel: API_DEFAULT}));
}
/** A key provider whose list the page has never seen reads it by itself once the page is up: no button to press. */
function autoLoadModels(provider) {
  if (!provider || provider.kind === LOCAL_CLI_KIND || provider.chatModels?.length) return;
  setTimeout(() => adminActions['ai-load-models']({dataset: {id: provider.id}, closest: () => null}, {reload: async () => {}}, {quiet: true}).catch(() => {}), 0);
}

/** Fetches what the page needs and returns its body HTML (no page header). Throws on API error. */
export async function adminPage(kind) {
  if (kind === 'connectors') return connectorsPanel(await loadConnectors());
  if (kind === 'ai') {
    const res = await api('/api/ai');
    // The browser-only demo has no providers to manage and says so.
    if (res?.demo) return `${note('Models and keys need the Node server. The browser-only demo answers with built-in replies, so there is no key to add here. The full app speaks to every provider below.')}${runFullApp()}${demoList(PROVIDER_PRESETS.map(p => ({name: p.label, sub: p.note || ''})), 'Providers the full app supports')}`;
    // Admin-only detail (endpoints, cached model ids, catalogue errors). The demo
    // shim has no such route, so a failure just falls back to the summary.
    const full = await api('/api/ai/providers').catch(() => null);
    // Which paired computers have `claude` and `codex` signed in. A failure only hides that part.
    const agents = (await api('/api/agents').catch(() => null))?.agents || [];
    const view = full?.providers?.length ? {...res, providers: full.providers, agents} : {...res, agents};
    if (full?.providers?.length) full.providers.forEach(rememberListing);
    const providers = (view.providers || []).map(providerView);
    autoLoadModels(providers.find(p => p.id === view.defaultProviderId) || providers[0]);
    return aiPanel(view);
  }
  if (kind === 'team') return teamPanel(await api('/api/users'));
  if (kind === 'data') {
    const [creds, retention] = await Promise.all([api('/api/credentials'), api('/api/retention/preview')]);
    return panel(credentialsPanel(creds.credentials || []), retentionPanel(retention.policy, retention.preview),
      // A backup carries every account's password hash, so only the owner gets it.
      store.state?.me?.role === 'owner' ? backupPanel() : hint('Backup and restore are available to the workspace owner.'));
  }
  if (kind === 'notifications') {
    const [list, prefs, push, creds] = await Promise.all([api('/api/notifications'), api('/api/notification-prefs'), pushStatus(), api('/api/credentials').catch(() => null)]);
    return notificationsPanel({list: list.notifications || [], prefs, push, credentials: creds?.credentials || [], emailReady: Boolean(prefs.emailReady)});
  }
  if (kind === 'workspaces') return workspacesPanel(await api('/api/workspaces'));
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
  ...connectActions,
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
  // A channel switch saves at once; the switch only moves when the server took it.
  'notif-pref': async button => {
    const key = button.dataset.pref, on = button.getAttribute('aria-checked') !== 'true', body = {[key]: on};
    const card = button.closest('.cd');
    if (key === 'webhook') body.webhookCredentialId = card?.querySelector('[name=webhookCredentialId]')?.value || undefined;
    if (key === 'email' && on) body.emailAddress = card?.querySelector('[name=emailAddress]')?.value.trim() || undefined;
    await api('/api/notification-prefs', 'PATCH', body);
    button.setAttribute('aria-checked', String(on));
  },
  'push-toggle': async (button, ctx) => {
    const on = button.getAttribute('aria-checked') === 'true';
    if (on) await disablePush(); else await enablePush();
    toast(on ? 'Push is off for this device.' : 'Push is on for this device.');
    await ctx.reload();
  },
  // A switch in a form that is not saved yet (which permissions a new pairing code carries).
  'ad-flip': button => button.setAttribute('aria-checked', String(button.getAttribute('aria-checked') !== 'true')),
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
    const typed = await askSheet(`Delete "${name}"?`, {sub: 'Its bots, chats and members are removed for everyone and cannot be recovered. Type the workspace name to confirm.', submit: 'Delete workspace'});
    if (typed === null) return;
    await api('/api/workspaces/current', 'DELETE', {confirm: typed});
    enterWorkspace();
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
  // The new list is read off the agent's switches, with this one flipped; the switch moves once the server took it.
  'toggle-agent-permission': async button => {
    const id = button.dataset.id, permission = button.dataset.permission;
    const turnOn = button.getAttribute('aria-checked') !== 'true';
    const siblings = document.querySelectorAll(`[data-action="toggle-agent-permission"][data-id="${CSS.escape(id)}"]`);
    const next = [...siblings]
      .filter(b => (b.dataset.permission === permission ? turnOn : b.getAttribute('aria-checked') === 'true'))
      .map(b => b.dataset.permission);
    await api(`/api/agents/${id}`, 'PATCH', {permissions: next});
    button.setAttribute('aria-checked', String(turnOn));
  },
  'set-role': async (button, ctx) => {
    try {
      await api(`/api/users/${button.dataset.id}`, 'PATCH', {role: button.dataset.value});
    } catch (error) {
      // Put the pills back to the server's value before the host reports the error.
      await ctx.reload();
      throw error;
    }
    toast('Role updated.');
    await ctx.reload();
  },
  // Which "Add a model" form is open.
  'ai-add-kind': button => {
    addKind = button.dataset.kind;
    const card = button.closest('.cd');
    card.querySelectorAll('[data-action="ai-add-kind"]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
    card.querySelector('#cli-provider-form').hidden = addKind !== 'sub';
    card.querySelector('#ai-provider-form').hidden = addKind !== 'api';
  },
  // The rest of a provider's actions, under its dots: a sheet, as the bot options are on a phone.
  'ai-more': button => {
    const {id, name, kind, host} = button.dataset;
    const item = (action, title, sub, cls = '') => `<button type="button" class="rw${cls}" data-action="${action}" data-id="${esc(id)}"><span class="w">${esc(title)}<small>${esc(sub)}</small></span></button>`;
    const rows = (kind === 'api' ? item('ai-menu-refresh', 'Refresh models', 'Read the model list again with the saved key') + item('ai-menu-edit', 'Edit', 'Rename it, change the address or replace the key') : '')
      + item('ai-menu-delete', 'Delete', kind === 'api' ? 'Removes the provider and its saved key' : 'Removes this subscription', ' bad');
    openSheet(`<div class="cd">${rows}</div>`, {title: name, sub: host});
  },
  'ai-menu-refresh': (button, ctx) => { closeSheet(); return adminActions['ai-load-models'](button, ctx); },
  'ai-menu-edit': (button, ctx) => { closeSheet(); return adminActions['ai-edit-provider'](button, ctx); },
  'ai-menu-delete': (button, ctx) => { closeSheet(); return adminActions['ai-delete-provider'](button, ctx); },
  'ai-delete-provider': async (button, ctx) => {
    if (!await confirmSheet('Remove this provider? Its saved key is deleted too.', {confirm: 'Delete', danger: true})) return;
    await api(`/api/ai/providers/${button.dataset.id}`, 'DELETE');
    toast('Provider removed.');
    await sync(); await ctx.reload();
  },
  // A subscription is checked by the sign-in its agent last reported; this never sends a prompt.
  'ai-check-cli': async button => {
    const res = await api(`/api/ai/providers/${button.dataset.id}/test`, 'POST', {});
    toast(res.message || (res.ok ? 'Signed in.' : 'Not signed in.'), !res.ok);
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
  'ai-load-models': async (button, ctx, {quiet = false} = {}) => {
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
      if (!quiet) toast(message, true);
      if (button.dataset.id) await ctx.reload();
      return;
    }
    // A newer response names the chat-capable list and labels the ids; an older
    // one sends a single list, which the row still keeps in full.
    const models = (res.chatModels?.length ? res.chatModels : res.models) || [];
    rememberListing({id, models: res.models, chatModels: res.chatModels, allModels: res.allModels, labels: res.labels, protocol: res.protocol, modelsError: ''});
    fillDefaultPicker(id);
    if (!quiet) toast(models.length ? `${models.length} model(s) available — pick one above.` : 'The provider returned no model list.');
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
      detail: 'Bots, chats and memory are never touched.',
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
    toast(`Restored ${res.restored} rows.`);
    await sync();
    await ctx.reload();
  },
};

/** form submit handlers keyed by form id: (form, values, ctx). `values` = Object.fromEntries(new FormData(form)). */
export const adminForms = {
  ...connectForms,
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
    const permissions = [...form.querySelectorAll('[data-permission][aria-checked="true"]')].map(x => x.dataset.permission);
    lastPairing = await api('/api/agents/pair', 'POST', {label: values.label, permissions});
    await ctx.reload();
    toast('Pairing code created. It is shown once.');
  },
  'cli-provider-form': async (form, values, ctx) => {
    const draft = cliDraft({...values, model: chosenModel(values)});
    if (!draft.ok) throw new Error(draft.error);
    await api('/api/ai/providers', 'POST', draft.body);
    form.reset();
    toast('Subscription added. Check its sign-in below.');
    await sync(); await ctx.reload();
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
    await api('/api/ai', 'PATCH', {providerId: values.providerId, model: chosenModel(values), effort: values.effort || ''});
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
  'notif-email-form': async (form, values) => {
    await api('/api/notification-prefs', 'PATCH', {emailAddress: (values.emailAddress || '').trim()});
    toast('Email address saved.');
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
  'model-pick': control => showOtherBox(control),
  // A subscription's model names follow the engine picked above them.
  'cli-engine': control => refillModelSelect(control.form?.elements.namedItem('model'), modelChoices({provider: {kind: LOCAL_CLI_KIND, engine: control.value}, defaultLabel: CLI_DEFAULT})),
  'notif-webhook-pick': async control => {
    await api('/api/notification-prefs', 'PATCH', {webhookCredentialId: control.value});
    toast('Webhook address changed.');
  },
};
