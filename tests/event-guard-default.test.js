/** The event route's refusal limit, as AGENTS.md and docs/OPERATIONS.md state it: an address that collects 20
 * refusals in a minute for one trigger is blocked for the rest of that minute, and the window then reopens. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {eventGuard} from '../src/routes-events.js';

test('the default guard blocks an address on its 20th refusal in a minute, not before', () => {
  let now = 0;
  const guard = eventGuard({now: () => now});
  const key = 'ws/trigger|203.0.113.7';
  for (let i = 0; i < 19; i += 1) guard.refused(key);
  assert.equal(guard.blocked(key), false, '19 refusals still leave the address open');
  guard.refused(key);
  assert.equal(guard.blocked(key), true, 'the 20th refusal blocks it');
  now = 59999;
  assert.equal(guard.blocked(key), true, 'blocked for the rest of the minute');
  now = 60000;
  assert.equal(guard.blocked(key), false, 'a new minute starts clean');
});

test('the limit is per trigger and address', () => {
  const guard = eventGuard({now: () => 0});
  for (let i = 0; i < 20; i += 1) guard.refused('ws/a|203.0.113.7');
  assert.equal(guard.blocked('ws/a|203.0.113.7'), true);
  assert.equal(guard.blocked('ws/b|203.0.113.7'), false, 'another trigger from the same address is open');
  assert.equal(guard.blocked('ws/a|198.51.100.2'), false, 'the same trigger from another address is open');
});
