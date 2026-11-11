/** Accounts and administration over HTTP: the signed-in user's own account
 * and sessions, workspace users, paired local agents, the credential vault,
 * notifications, and backup and restore. */
import {activity, cleanText} from '../shared/core.js';
import * as agent from './agent.js';
import * as credentials from './credentials.js';
import * as backup from './backup.js';
import * as notifications from './notifications.js';
import {deleteProvider} from './ai-providers.js';
import {onAgentTaskResult} from './bot-browser.js';
import {resumeBrowserRun} from './coordination.js';
import {DEFAULT_WORKSPACE, ROLES, clearCookie} from './auth.js';
import {fail} from './http.js';
import {reply} from './router.js';

/** The rows a removed account owns in the *workspace* database, cleared in or
 * before the caller's own transaction. The account itself lives in the primary
 * database, so the two can never share a commit; every caller clears this side
 * first, which leaves (at worst) an account whose feed is already gone.
 *
 * A paired device belongs here too. It is a live HMAC credential with the
 * permissions it was granted and its `revoked_at` is written by no one else, so
 * leaving it behind let a removed person's laptop keep claiming work. */
function clearWorkspaceAccount(store, {userId, email}) {
  store.run('DELETE FROM notification_prefs WHERE user_id=?', userId);
  store.run('DELETE FROM notifications WHERE user_id=?', userId);
  if (!email) return;
  const stamp = new Date().toISOString();
  store.run("UPDATE agents SET status='revoked', revoked_at=?, secret_enc=NULL WHERE paired_by=? AND revoked_at IS NULL", stamp, email);
  store.run(`UPDATE agent_tasks SET status='failed', error=?, lease_until=NULL, updated_at=?, completed_at=?
    WHERE status IN ('queued','running') AND agent_id IN (SELECT id FROM agents WHERE paired_by=?)`,
  'The device belonged to an account that was removed.', stamp, stamp, email);
}

/** Task kinds only the server's own code may queue. */
const SERVER_ONLY_KINDS = ['mcp.call', 'model.run'];

export function accountRoutes(router, {auth, workspaces}) {
  // The signed-in user's own account and sessions.
  router.add('GET', '/api/me', 'viewer', c => ({email: c.actor.email, role: c.actor.role}));
  router.add('POST', '/api/auth/password', 'viewer', async c => { const b = await c.body(); auth.changePassword(c.actor.userId, b.currentPassword, b.newPassword, c.actor.sessionId); return {ok: true}; });
  router.add('GET', '/api/sessions', 'viewer', c => ({sessions: auth.listSessions(c.actor.userId).map(s => ({...s, current: s.id === c.actor.sessionId}))}));
  router.add('POST', '/api/sessions/revoke-all', 'viewer', c => { auth.revokeAll(c.actor.userId, c.actor.sessionId); return {ok: true}; });
  router.add('DELETE', '/api/sessions/:id', 'viewer', c => { if (!auth.revokeSession(c.actor.userId, c.params.id)) fail('Session not found.', 404); return {ok: true}; });
  router.add('DELETE', '/api/account', 'viewer', async c => {
    const b = await c.body();
    // The password and the last-owner check run before a single row here is
    // touched: a typo must not cost the caller their paired devices.
    const me = auth.assertCanDeleteAccount(c.actor.userId, b.password);
    // `selfDeleteAccount` removes the account and every membership it had, so
    // the rows that go with it are in *every* workspace's database, not only
    // the one this request happened to be sent from. The search path opens
    // every workspace a member belongs to, so all of them are here.
    for (const {store} of workspaces.all()) {
      store.transaction(() => clearWorkspaceAccount(store, {userId: c.actor.userId, email: me.email}));
    }
    auth.selfDeleteAccount(c.actor.userId, b.password);
    return reply(200, {ok: true}, {'Set-Cookie': clearCookie()});
  });

  // Workspace users.
  router.add('GET', '/api/users', 'admin', c => ({users: auth.listUsers(c.actor.workspaceId), roles: ROLES}));
  router.add('POST', '/api/users', 'admin', async c => { const b = await c.body(); return reply(201, auth.createUser(c.actor, b)); });
  router.add('PATCH', '/api/users/:id', 'admin', async c => { const b = await c.body(); return auth.updateUser(c.actor, c.params.id, b); });
  router.add('DELETE', '/api/users/:id', 'admin', c => {
    // This workspace's rows live in its own database; the account, its
    // memberships and its sessions live in the primary one, so the two can
    // never share a commit. Order is the whole point here: the workspace rows
    // go FIRST and the account LAST. Interrupted after the first step, what is
    // left is an account with no old notifications - harmless, and a retry
    // finishes it. The other order left rows and preferences that no account
    // could ever match again: they kept holding the MAX_IN_APP cap slots and
    // showed a feed for a person who no longer exists.
    //
    // Every guard (role, self-removal, membership) runs before the first write,
    // through the same function `auth.deleteUser` uses below: a 404 or 409 that
    // lands after this step would have removed the person's notifications while
    // telling the admin the removal did not happen.
    const target = auth.assertCanRemoveUser(c.actor, c.params.id);
    c.store.transaction(() => clearWorkspaceAccount(c.store, {userId: c.params.id, email: target.email}));
    return auth.deleteUser(c.actor, c.params.id);
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
    // A connector call and a model run are the server's own work: they carry what an ask cleared and spend the
    // owner's plan, so only the server's code queues them (src/mcp-client.js, src/cli-model.js), never this route.
    if (SERVER_ONLY_KINDS.includes(kind)) fail(`${kind} tasks are queued only by the server itself, never through this route.`, 400);
    // `enqueueAgentTask` validates a browser payload itself (MAX_STEPS, a public
    // http(s) url, and never a click or type on X), so the scheduler's own path
    // cannot skip the rule this route used to be the only one to apply.
    const {task, duplicate} = agent.enqueueAgentTask(c.store, c.params.id, {kind, payload: b.payload || {}, idempotencyKey: b.idempotencyKey || null, createdBy: c.actor.email, permission: agent.permissionForKind(kind)});
    if (!duplicate) await c.store.update(s => activity(s, 'agent', `Queued ${kind} for a local agent.`, {taskId: task.id}));
    return reply(duplicate ? 200 : 201, {...task, payload: JSON.parse(task.payload), duplicate});
  });
  router.add('PATCH', '/api/agents/:id', 'admin', async c => {
    const b = await c.body(), id = c.params.id;
    // A name and its permission list are one grant, not two. As separate
    // commits a crash between them could leave an agent renamed with its old
    // scope (or a new scope under the old name), which an operator reads as the
    // agent they just approved. One transaction makes the pair land together or
    // not at all - including a refused permission list, which now also rolls
    // back the rename instead of keeping it.
    // The rename is an UPDATE with no rows for an unknown id, so a PATCH that
    // carried only a name answered 200 and logged "Updated local agent
    // permissions." for an agent that does not exist.
    if (!c.store.get('SELECT id FROM agents WHERE id=?', id)) fail('Agent not found.', 404);
    const result = c.store.transaction(() => {
      if (b.name !== undefined) c.store.run('UPDATE agents SET name=? WHERE id=?', cleanText(b.name, 120) || 'Local agent', id);
      return b.permissions !== undefined ? agent.setAgentPermissions(c.store, id, b.permissions) : {ok: true};
    });
    await c.store.update(s => activity(s, 'agent', 'Updated local agent permissions.', {agentId: id}));
    return result;
  });
  router.add('DELETE', '/api/agents/:id', 'admin', async c => {
    const browserTasks = c.store.all(
      "SELECT id FROM agent_tasks WHERE agent_id=? AND kind IN ('browser.capture','browser.action') AND status IN ('queued','running')",
      c.params.id,
    ).map(task => task.id);
    const result = agent.revokeAgent(c.store, c.params.id);
    await c.store.update(s => activity(s, 'agent', 'Revoked a local agent. Its in-flight tasks were failed, not dropped silently.', {agentId: c.params.id}));
    for (const id of browserTasks) {
      try { await onAgentTaskResult(c.store, id, {resumeBrowser: resumeBrowserRun}); }
      catch (error) { console.error('Browser revocation:', error.message); }
    }
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
    const provider = c.store.read().ai?.providers?.find(p => p.credentialId === c.params.id);
    const result = provider
      ? await deleteProvider(c.store, c.actor.workspaceId, provider.id)
      : credentials.deleteCredential(c.store, c.actor.workspaceId, c.params.id);
    await c.store.update(s => activity(s, 'credential', 'Deleted a credential.', {credentialId: c.params.id}));
    return result;
  });

  // Notifications: feed, read state, and per-user channel preferences.
  router.add('GET', '/api/notifications', 'viewer', c => ({notifications: notifications.listNotifications(c.store, c.actor.userId), unread: notifications.unreadCount(c.store, c.actor.userId)}));
  router.add('POST', '/api/notifications/read', 'viewer', async c => {
    const b = await c.body();
    // Ids are bound into SQL, and a non-scalar binding is a TypeError with no
    // status: a body-shape mistake answered 500 and was logged as a server fault.
    const list = Array.isArray(b?.ids) ? b.ids : [b?.ids];
    return notifications.markRead(c.store, c.actor.userId, list.filter(id => typeof id === 'string' && id.trim()).slice(0, 200));
  });
  router.add('GET', '/api/notification-prefs', 'viewer', c => notifications.getPreferences(c.store, c.actor.userId));
  router.add('PATCH', '/api/notification-prefs', 'member', async c => { const b = await c.body(); return notifications.updatePreferences(c.store, c.actor.userId, b); });

  // Backup: export and restore. Credentials, agent secrets and password hashes
  // never travel. Owner only. Restore replaces the current workspace database,
  // so either one in an admin's hands is a way up.
  router.add('GET', '/api/admin/backup', 'owner', c => backup.exportBackup(c.store));
  // Restore replaces this workspace's database, so it runs outside the work
  // tracker: the tracker is what the restore waits for (`tracksWork: false`).
  router.add('POST', '/api/admin/restore', 'owner', async c => {
    // A backup document can be far larger than a normal request; allow up to 32 MB.
    const b = await c.body(32 * 1024 * 1024);
    const discarding = Array.isArray(b?.discardWorkspaces) ? b.discardWorkspaces.map(String) : [];
    // A primary restore reconciles every workspace on disk against the restored
    // rows, so a backup written before a workspace existed would delete that
    // workspace's database. Refuse here, before anything is written, so both
    // the live database and the newer workspace files stay untouched.
    if (c.actor.workspaceId === DEFAULT_WORKSPACE) {
      const restored = new Set((Array.isArray(b?.tables?.workspaces) ? b.tables.workspaces : []).map(w => String(w?.id)));
      // Both the restored account rows and the stores currently open: `sync()`
      // reconciles the open set, so a workspace that only exists on disk here
      // must be refused before it too, not after the import has already
      // rewritten the account rows.
      const current = new Set([...auth.workspaceIds(), ...workspaces.all().map(w => w.id)]);
      const refused = [...current].filter(id => !restored.has(id) && !discarding.includes(id));
      if (refused.length) fail(`This backup was written before workspace ${refused.join(', ')} existed. Restoring it would delete that workspace and its data: export it first, or send its id in discardWorkspaces to confirm.`, 409);
    }
    const restore = async store => {
      const result = backup.importBackup(store, b, {force: Boolean(b.force), primaryWorkspace: c.actor.workspaceId === DEFAULT_WORKSPACE});
      // A backup of the first workspace carries the list of workspaces.
      const {created = []} = (await workspaces.sync({discard: discarding})) || {};
      // A backup document carries one workspace's data plus the account rows.
      // Any workspace it names but did not carry has just been started empty,
      // and a 200 that does not say so reads as "everything came back".
      const missing = created.length ? ` ${created.length === 1 ? 'One workspace it names had' : `${created.length} workspaces it names had`} no data in the file and ${created.length === 1 ? 'was' : 'were'} started empty: ${created.join(', ')}.` : '';
      await store.update(s => activity(s, 'backup', `Restored a backup into this installation (${result.restored} rows).${missing}`));
      // A primary restore deletes every session (see backup.importBackup), so
      // the caller's cookie is dead the moment this returns: say so instead of
      // answering 200 as if they were still signed in.
      const answered = c.actor.workspaceId === DEFAULT_WORKSPACE ? {...result, signedOut: true} : result;
      return created.length ? {...answered, startedEmpty: created} : answered;
    };
    // A primary restore replaces global memberships and sessions, so fence
    // work in every workspace while those account records are being replaced.
    return c.actor.workspaceId === DEFAULT_WORKSPACE
      ? workspaces.withAllPaused(restore)
      : workspaces.withPaused(c.actor.workspaceId, restore);
  }, {tracksWork: false});
}
