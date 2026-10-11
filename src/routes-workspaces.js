/** Workspaces over HTTP: the ones the signed-in account belongs to, switching
 * between them, and creating, renaming or deleting one. Every other route
 * works on the session's current workspace only. */
import {activity} from '../shared/core.js';
import {fail} from './http.js';
import {reply} from './router.js';

export function workspaceRoutes(router, {auth, workspaces}) {
  const mine = actor => auth.listWorkspaces(actor.userId).map(w => ({...w, current: w.id === actor.workspaceId}));

  router.add('GET', '/api/workspaces', 'viewer', c => ({workspaces: mine(c.actor), canCreate: auth.roleOf(c.actor.userId) === 'owner'}));
  router.add('POST', '/api/workspaces/switch', 'viewer', async c => {
    const b = await c.body();
    return auth.switchWorkspace(c.actor, b.id);
  });
  // The role asked for here is the one in the current workspace; the real rule
  // (an owner of the first workspace) is checked by auth.createWorkspace.
  router.add('POST', '/api/workspaces', 'viewer', async c => {
    const b = await c.body();
    const created = auth.createWorkspace(c.actor, b.name);
    const store = await workspaces.create(created.id);
    await store.update(s => activity(s, 'workspace', `Created the workspace "${created.name}".`));
    return reply(201, created);
  });
  router.add('PATCH', '/api/workspaces/current', 'owner', async c => {
    const b = await c.body();
    const result = auth.renameWorkspace(c.actor, b.name);
    await c.store.update(s => activity(s, 'workspace', `Renamed the workspace to "${result.name}".`));
    return result;
  });
  // Deleting removes the workspace's database. The typed name is the check
  // that the owner means this workspace and not the one in another tab.
  router.add('DELETE', '/api/workspaces/current', 'owner', async c => {
    const b = await c.body();
    const current = mine(c.actor).find(w => w.current);
    if (String(b.confirm || '').trim() !== current.name) fail('Type the workspace name exactly to delete it.', 400);
    auth.deleteWorkspace(c.actor);
    await workspaces.remove(c.actor.workspaceId);
    return {ok: true};
  });
}
