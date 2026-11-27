/** Browser accounts over HTTP (shared/browser-accounts.js): a named sign-in whose cookies live on one paired computer.
 * The owner alone lists, adds, renames, moves and deletes them: a record decides which cookies a bot acts with.
 * Records live in kv `browser_accounts`; the sign-in state is what the account's computer last reported
 * (src/agent.js `readAccountReports`). A jar's cookies never reach the server. */
import crypto from 'node:crypto';
import {addAccount, updateAccount, removeAccount} from '../shared/browser-accounts.js';
import {readAccountReports} from './agent.js';
import {fail} from './http.js';
import {isSigninAsk} from '../shared/asks.js';
import {answerSigninFlow} from './ask-runs.js';
import {reply} from './router.js';

/** An account as the owner's page reads it: the record, and what its computer last reported of it (signed out when
 * nothing has been, as after a restore). The one place that state is filled in. */
const publicAccount = (store, record) => {
  const report = readAccountReports(store, record.deviceId).find(r => r.id === record.id);
  return {...record, state: report?.state || 'signed-out', lost: report?.lost === true, checkedAt: report?.checkedAt ?? null};
};

/** The computer must be paired in this workspace and not revoked. A body with no `deviceId` is not asked. */
function assertPaired(c, body) {
  const id = body?.deviceId;
  if (id === undefined || typeof id !== 'string') return; // a wrong type is the shape check's refusal, in cleanAccount
  if (!c.store.get('SELECT id FROM agents WHERE id=? AND workspace_id=? AND revoked_at IS NULL', id, c.actor.workspaceId)) fail('That computer is not paired. Choose one in Settings → Local agents.');
}

export function browserAccountRoutes(router) {
  router.add('GET', '/api/browser-accounts', 'owner', c => ({accounts: (c.store.read().browserAccounts || []).map(a => publicAccount(c.store, a))}));
  router.add('POST', '/api/browser-accounts', 'owner', async c => {
    const b = await c.body();
    assertPaired(c, b);
    return reply(201, publicAccount(c.store, await c.store.update(s => addAccount(s, b, {makeId: () => crypto.randomUUID()}))));
  });
  router.add('PATCH', '/api/browser-accounts/:id', 'owner', async c => {
    const b = await c.body();
    assertPaired(c, b);
    return publicAccount(c.store, await c.store.update(s => updateAccount(s, c.params.id, b)));
  });
  // A deleted account has no one left to sign in as it: its open card is closed like Not now, so its runs go on.
  router.add('DELETE', '/api/browser-accounts/:id', 'owner', async c => {
    const state = c.store.read(), card = (state.asks || []).find(a => a.id === state.signinPending?.[c.params.id] && isSigninAsk(a) && a.status === 'pending');
    await c.store.update(s => { removeAccount(s, c.params.id); return {ok: true}; });
    if (card) await answerSigninFlow(c.store, card.id, {signedIn: false, actor: c.actor.email});
    return {ok: true};
  });
}
