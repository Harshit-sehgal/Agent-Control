/** An outside caller must not learn which trigger ids exist: an unknown trigger, a disabled one and a wrong
 * signature all get the same answer, and the same time-cost as a real signature check. */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {receiveEvent} from '../src/triggers.js';
import {eventGuard} from '../src/routes-events.js';
import {clientIpOf} from '../src/http.js';

const sign = (secret, raw) => `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
const fakeStore = doc => ({read: () => doc, update: async fn => fn(doc)});
const raw = '{"status":"failure"}';

test('an unknown trigger and a wrong signature get the same status and body', async () => {
  const store = fakeStore({triggers: [{id: 't1', name: 'x', secretId: 'sec', enabled: true}], schedulesPaused: false});
  const reveal = () => 'real-secret';
  const unknown = await receiveEvent(store, {triggerId: 'nope', raw, signature: sign('whatever', raw), reveal});
  const wrong = await receiveEvent(store, {triggerId: 't1', raw, signature: sign('whatever', raw), reveal});
  assert.deepEqual(unknown, wrong);
  assert.equal(unknown.status, 401);
});

test('a disabled trigger answers like an unknown one', async () => {
  const store = fakeStore({triggers: [{id: 't2', name: 'x', secretId: 'sec', enabled: false}], schedulesPaused: false});
  const disabled = await receiveEvent(store, {triggerId: 't2', raw, signature: sign('real-secret', raw), reveal: () => 'real-secret'});
  const unknown = await receiveEvent(store, {triggerId: 'nope', raw, signature: sign('real-secret', raw), reveal: () => 'real-secret'});
  assert.deepEqual(disabled, unknown);
});

test('a client that keeps getting refused is blocked for the window; valid events are never counted', () => {
  let now = 0;
  const guard = eventGuard({max: 3, windowMs: 1000, now: () => now});
  assert.equal(guard.blocked('t1|1.2.3.4'), false);
  for (let i = 0; i < 3; i++) guard.refused('t1|1.2.3.4');
  assert.equal(guard.blocked('t1|1.2.3.4'), true, 'three refusals in the window block the client');
  assert.equal(guard.blocked('t1|5.6.7.8'), false, 'another client has its own budget');
  assert.equal(guard.blocked('t2|1.2.3.4'), false, 'another trigger has its own budget');
  now = 1500;
  assert.equal(guard.blocked('t1|1.2.3.4'), false, 'a new window starts after the old one ends');
});

test('the client address is the proxy-supplied one only when TRUST_PROXY is set', () => {
  const req = {headers: {'x-forwarded-for': 'attacker-fake, 203.0.113.9'}, socket: {remoteAddress: '127.0.0.1'}};
  const before = process.env.TRUST_PROXY;
  try {
    delete process.env.TRUST_PROXY;
    assert.equal(clientIpOf(req), '127.0.0.1');
    process.env.TRUST_PROXY = '1';
    assert.equal(clientIpOf(req), '203.0.113.9', 'the rightmost entry is the one the proxy appended');
  } finally {
    if (before === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = before;
  }
});
