/** Admin pages: notifications, team and access, local agents, data and security.
 * `adminPage(kind)` fetches and returns the body HTML; the handler tables are
 * wired by the host's delegated click, submit and change listeners. Handlers do
 * not catch errors, the host toasts them. */
import {esc, btn, row, box, field, note, empty, tag, fullDate} from './ui-kit.js';
import {store, api, sync} from './ui-store.js';
import {toast, confirmSheet, askSheet} from './ui-dialogs.js';
import {pushStatus, enablePush, disablePush} from './ui-push.js';

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
    sub: 'Credential vault, retention policy and encrypted backups.',
  },
};

/** The pairing code is shown once, so it lives only in memory until the page is left. */
let lastPairing = null;

const actionRow = (title, sub, buttons) => `<div class="row"><span class="row-main"><span class="row-title">${title}</span>${sub ? `<span class="row-sub">${sub}</span>` : ''}</span><span class="row-actions">${buttons}</span></div>`;

const textInput = (name, {type = 'text', value = '', ...rest} = {}) => {
  const extra = Object.entries(rest).map(([k, v]) => (v === true ? ` ${k}` : ` ${k}="${esc(v)}"`)).join('');
  return `<input class="input" name="${esc(name)}" type="${esc(type)}" value="${esc(value)}"${extra}>`;
};

const PUSH_HELP = {
  insecure: 'Push needs a secure address. Open this app over https, or on localhost.',
  unsupported: 'This browser cannot receive push here. On an iPhone or iPad, add this app to the Home Screen first, then open it from there.',
  blocked: 'Notifications are blocked for this site. Allow them in the browser settings, then reload.',
  off: 'Get reminders, failed tasks and alerts on this device, even when the app is closed.',
  on: 'This device gets reminders, failed tasks and alerts, even when the app is closed.',
};
function pushPanel(push) {
  const buttons = push.state === 'on' ? btn('Send a test', 'push-test', {small: true}) + btn('Turn off', 'push-off', {small: true})
    : push.state === 'off' ? btn('Turn on', 'push-on', {kind: 'primary', small: true}) : '';
  const others = push.devices - (push.state === 'on' ? 1 : 0);
  return box(actionRow(`Push on this device ${tag(push.state === 'on' ? 'on' : 'off', push.state === 'on' ? 'good' : '')}`,
    esc(PUSH_HELP[push.state]) + (others > 0 ? ` ${others} other device${others === 1 ? '' : 's'} of yours ${others === 1 ? 'is' : 'are'} subscribed.` : ''), buttons), 'Push');
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
    <label class="check-row"><input type="checkbox" name="email" ${prefs.email ? 'checked' : ''}><span>Email (relay; delivery is external)</span></label>
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
    const select = `<select class="input" data-action="set-role" data-id="${esc(user.id)}" aria-label="Role for ${esc(user.email)}">${roles.map(r => `<option value="${esc(r)}" ${r === user.role ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select>`;
    const remove = isMe ? '' : btn('Remove', 'remove-user', {kind: 'danger', id: user.id, small: true});
    return actionRow(
      `${esc(user.email)}${user.disabled ? ` ${tag('disabled', 'bad')}` : ''}${isMe ? ` ${tag('you', 'good')}` : ''}`,
      `Joined ${esc(fullDate(user.createdAt))}`,
      select + remove,
    );
  }).join('');
  const invite = `<form id="create-user-form">
    <div class="form-grid">
      ${field('Email', textInput('email', {type: 'email', required: true}))}
      ${field('Role', '<select class="input" name="role"><option value="viewer">viewer</option><option value="member" selected>member</option><option value="admin">admin</option></select>')}
    </div>
    ${field('Temporary password (min 12 chars)', textInput('password', {type: 'password', minlength: 12, required: true}))}
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
  return `<p>${btn('Create pairing code', 'new-pairing', {kind: 'primary', small: true})}</p>`
    + code
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

/** Fetches what the page needs and returns its body HTML (no page header). Throws on API error. */
export async function adminPage(kind) {
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
  'new-pairing': async (button, ctx) => {
    const label = await askSheet('Label for this device', {value: 'My device', submit: 'Create code'});
    if (label === null) return;
    lastPairing = await api('/api/agents/pair', 'POST', {label});
    await ctx.reload();
    toast('Pairing code created. It is shown once.');
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
