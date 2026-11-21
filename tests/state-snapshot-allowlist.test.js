/** The browser snapshot is an allowlist: a key nobody listed (a secret, a dedup record, a future kv blob) never
 * leaves the server, instead of having to be remembered in a deny-list. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {snapshotOf} from '../src/routes-workflow.js';

test('the snapshot carries the workspace data the UI reads', () => {
  const s = snapshotOf({groups: [{id: 'g'}], tasks: [], chats: {}, version: 3, handsOff: false});
  assert.deepEqual(['groups', 'tasks', 'chats', 'version', 'handsOff'].filter(k => k in s), ['groups', 'tasks', 'chats', 'version', 'handsOff']);
});

test('a key the snapshot does not list never leaves the server', () => {
  const s = snapshotOf({groups: [], triggers: [{secretId: 'x'}], heldSends: [{body: 'mail'}], activity: [], vaultIndex: 'secret', somethingNew: 1});
  for (const key of ['triggers', 'heldSends', 'activity', 'vaultIndex', 'somethingNew']) assert.equal(key in s, false, `${key} leaked`);
});
