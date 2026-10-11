import test from 'node:test';
import assert from 'node:assert/strict';
import {createRouter, reply, isReply, allows} from '../src/router.js';

test('a route matches its method and path and names its id segments', () => {
  const r = createRouter();
  r.add('POST', '/api/groups/:group/bots/:bot', 'member', () => {});
  const found = r.find('POST', '/api/groups/x-engage/bots/writer');
  assert.deepEqual(found.params, {group: 'x-engage', bot: 'writer'});
  assert.equal(found.route.access, 'member');
  assert.equal(r.find('GET', '/api/groups/x-engage/bots/writer'), null);
  assert.equal(r.find('POST', '/api/groups/x-engage/bots/writer/extra'), null);
  assert.equal(r.find('POST', '/api/groups/x-engage/bots/'), null);
  assert.equal(r.find('POST', '/api/groups/..%2F/bots/writer'), null, 'An id segment is letters, digits and dashes only.');
});

test('a route cannot be registered without a known access level, or twice', () => {
  const r = createRouter();
  assert.throws(() => r.add('GET', '/api/x', 'everyone', () => {}), /Unknown access/);
  assert.throws(() => r.add('GET', '/api/x', undefined, () => {}), /Unknown access/);
  r.add('GET', '/api/x', 'viewer', () => {});
  assert.throws(() => r.add('GET', '/api/x', 'admin', () => {}), /registered twice/);
});

test('roles are ordered viewer < member < admin < owner', () => {
  assert.equal(allows('viewer', 'viewer'), true);
  assert.equal(allows('viewer', 'member'), false);
  assert.equal(allows('member', 'admin'), false);
  assert.equal(allows('owner', 'admin'), true);
  assert.equal(allows('nobody', 'viewer'), false);
});

test('reply() marks a custom response and plain values are not replies', () => {
  assert.equal(isReply(reply(201, {ok: true})), true);
  assert.equal(isReply({status: 201, body: {}}), false);
  assert.equal(isReply(null), false);
});
