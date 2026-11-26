/** Browser accounts over HTTP (shared/browser-accounts.js): a named sign-in whose cookies live on one paired computer.
 * The owner alone lists, adds, renames, moves and deletes them: a record decides which cookies a bot acts with.
 * Records live in kv `browser_accounts`; the sign-in state is reported by the computer and filled in by a later task,
 * so every account reads signed out here. A jar's cookies never reach the server. */
import crypto from 'node:crypto';
import {addAccount, updateAccount, removeAccount} from '../shared/browser-accounts.js';
import {fail} from './http.js';
import {reply} from './router.js';

/** An account as the owner's page reads it: the record, and the state nothing has reported yet. */
const publicAccount = record => ({...record, state: 'signed-out', lost: false, checkedAt: null});

/** The computer must be paired in this workspace and not revoked. A body with no `deviceId` is not asked. */
function assertPaired(c, body) {
  const id = body?.deviceId;
  if (id === undefined || typeof id !== 'string') return; // a wrong type is the shape check's refusal, in cleanAccount
  if (!c.store.get('SELECT id FROM agents WHERE id=? AND workspace_id=? AND revoked_at IS NULL', id, c.actor.workspaceId)) fail('That computer is not paired. Choose one in Settings → Local agents.');
}

export function browserAccountRoutes(router) {
  router.add('GET', '/api/browser-accounts', 'owner', c => ({accounts: (c.store.read().browserAccounts || []).map(publicAccount)}));
  router.add('POST', '/api/browser-accounts', 'owner', async c => {
    const b = await c.body();
    assertPaired(c, b);
    return reply(201, publicAccount(await c.store.update(s => addAccount(s, b, {makeId: () => crypto.randomUUID()}))));
  });
  router.add('PATCH', '/api/browser-accounts/:id', 'owner', async c => {
    const b = await c.body();
    assertPaired(c, b);
    return publicAccount(await c.store.update(s => updateAccount(s, c.params.id, b)));
  });
  router.add('DELETE', '/api/browser-accounts/:id', 'owner', c => c.store.update(s => { removeAccount(s, c.params.id); return {ok: true}; }));
}
