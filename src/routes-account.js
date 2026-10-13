/** Accounts and administration over HTTP: the signed-in user's own account
 * and sessions, workspace users, paired local agents, the credential vault,
 * notifications, and backup and restore. */
import {activity, cleanText} from '../shared/core.js';
import * as agent from './agent.js';
import * as credentials from './credentials.js';
import * as backup from './backup.js';
import * as notifications from './notifications.js';
import {ROLES, clearCookie} from './auth.js';
import {fail} from './http.js';
import {reply} from './router.js';

export function accountRoutes(router, {auth, workspaces}) {
  // The signed-in user's own account and sessions.
  router.add('GET', '/api/me', 'viewer', c => ({email: c.actor.email, role: c.actor.role}));
  router.add('POST', '/api/auth/password', 'viewer', async c => { const b = await c.body(); auth.changePassword(c.actor.userId, b.currentPassword, b.newPassword, c.actor.sessionId); return {ok: true}; });
  router.add('GET', '/api/sessions', 'viewer', c => ({sessions: auth.listSessions(c.actor.userId).map(s => ({...s, current: s.id === c.actor.sessionId}))}));
  router.add('POST', '/api/sessions/revoke-all', 'viewer', c => { auth.revokeAll(c.actor.userId, c.actor.sessionId); return {ok: true}; });
  router.add('DELETE', '/api/sessions/:id', 'viewer', c => { if (!auth.revokeSession(c.actor.userId, c.params.id)) fail('Session not found.', 404); return {ok: true}; });
  router.add('DELETE', '/api/account', 'viewer', async c => {
    const b = await c.body();
    auth.selfDeleteAccount(c.actor.userId, b.password);
    return reply(200, {ok: true}, {'Set-Cookie': clearCookie()});
  });

  // Workspace users.
  router.add('GET', '/api/users', 'admin', c => ({users: auth.listUsers(c.actor.workspaceId), roles: ROLES}));
  router.add('POST', '/api/users', 'admin', async c => { const b = await c.body(); return reply(201, auth.createUser(c.actor, b)); });
  router.add('PATCH', '/api/users/:id', 'admin', async c => { const b = await c.body(); return auth.updateUser(c.actor, c.params.id, b); });
  router.add('DELETE', '/api/users/:id', 'admin', c => {
    const result = auth.deleteUser(c.actor, c.params.id);
    // What this workspace kept for them goes with the membership.
    c.store.run('DELETE FROM notification_prefs WHERE user_id=?', c.params.id);
    c.store.run('DELETE FROM notifications WHERE user_id=?', c.params.id);
    return result;
  });

  // Paired local agents.
  router.add('GET', '/api/agents', 'viewer', c => ({agents: agent.listAgents(c.store, c.actor.workspaceId), actions: agent.AGENT_ACTIONS}));
  router.add('POST', '/api/agents/pair', 'admin', async c => {
    const b = await c.body();
    const pairing = agent.createPairing(c.store, c.actor.workspaceId, {label: b.label, createdBy: c.actor.email, permissions: b.permissions});
    await c.store.update(s => activity(s, 'agent', 'Created a local-agent pairing code.', {expiresAt: pairing.expiresAt}));
    return reply(201, pairing);
  });
  router.add('POST', '/api/agents/:id/tasks', 'member', async c => {
    const b = await c.body(), kind = String(b.kind || '');
    const {task, duplicate} = agent.enqueueAgentTask(c.store, c.params.id, {kind, payload: b.payload || {}, idempotencyKey: b.idempotencyKey || null, createdBy: c.actor.email, permission: agent.permissionForKind(kind)});
    if (!duplicate) await c.store.update(s => activity(s, 'agent', `Queued ${kind} for a local agent.`, {taskId: task.id}));
    return reply(duplicate ? 200 : 201, {...task, payload: JSON.parse(task.payload), duplicate});
  });
  router.add('PATCH', '/api/agents/:id', 'admin', async c => {
    const b = await c.body(), id = c.params.id;
    if (b.name !== undefined) c.store.run('UPDATE agents SET name=? WHERE id=?', cleanText(b.name, 120) || 'Local agent', id);
    const result = b.permissions !== undefined ? agent.setAgentPermissions(c.store, id, b.permissions) : {ok: true};
    await c.store.update(s => activity(s, 'agent', 'Updated local agent permissions.', {agentId: id}));
    return result;
  });
  router.add('DELETE', '/api/agents/:id', 'admin', async c => {
    const result = agent.revokeAgent(c.store, c.params.id);
    await c.store.update(s => activity(s, 'agent', 'Revoked a local agent. Its in-flight tasks were failed, not dropped silently.', {agentId: c.params.id}));
    return result;
  });

  // Credential vault: encrypted at rest, revealed only by admins.
  router.add('GET', '/api/credentials', 'viewer', c => ({credentials: credentials.listCredentials(c.store, c.actor.workspaceId)}));
  router.add('POST', '/api/credentials', 'admin', async c => {
    const b = await c.body();
    const result = credentials.addCredential(c.store, c.actor.workspaceId, {...b, createdBy: c.actor.email});
    await c.store.update(s => activity(s, 'credential', `Stored credential "${String(b.name || '').slice(0, 60)}".`, {credentialId: result.id}));
    return reply(201, result);
  });
  // The reveal returns plaintext and is written to the audit log.
  router.add('POST', '/api/credentials/:id/reveal', 'admin', async c => {
    const item = credentials.revealCredential(c.store, c.actor.workspaceId, c.params.id);
    await c.store.update(s => activity(s, 'credential', `Revealed credential "${String(item.name).slice(0, 60)}".`, {credentialId: item.id}));
    return item;
  });
  router.add('DELETE', '/api/credentials/:id', 'admin', async c => {
    const result = credentials.deleteCredential(c.store, c.actor.workspaceId, c.params.id);
    await c.store.update(s => activity(s, 'credential', 'Deleted a credential.', {credentialId: c.params.id}));
    return result;
  });

  // Notifications: feed, read state, and per-user channel preferences.
  router.add('GET', '/api/notifications', 'viewer', c => ({notifications: notifications.listNotifications(c.store, c.actor.userId), unread: notifications.unreadCount(c.store, c.actor.userId)}));
  router.add('POST', '/api/notifications/read', 'member', async c => {
    const b = await c.body();
    return notifications.markRead(c.store, c.actor.userId, Array.isArray(b?.ids) ? b.ids : [b?.ids].filter(Boolean));
  });
  router.add('GET', '/api/notification-prefs', 'viewer', c => notifications.getPreferences(c.store, c.actor.userId));
  router.add('PATCH', '/api/notification-prefs', 'member', async c => { const b = await c.body(); return notifications.updatePreferences(c.store, c.actor.userId, b); });

  // Backup: export and restore. Credentials and sessions never travel. Owner
  // only: a backup carries every account's password hash, and a restore
  // replaces accounts and roles, so either one in an admin's hands is a way up.
  router.add('GET', '/api/admin/backup', 'owner', c => backup.exportBackup(c.store));
  router.add('POST', '/api/admin/restore', 'owner', async c => {
    // A backup document can be far larger than a normal request; allow up to 32 MB.
    const b = await c.body(32 * 1024 * 1024);
    const result = backup.importBackup(c.store, b, {force: Boolean(b.force)});
    // A backup of the first workspace carries the list of workspaces.
    await workspaces.sync();
    await c.store.update(s => activity(s, 'backup', `Restored a backup into this installation (${result.restored} rows).`));
    return result;
  });
}
