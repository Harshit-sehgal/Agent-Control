import test from 'node:test';
import assert from 'node:assert/strict';
import {connect, ownRefusal, startBrowserSession} from '../agent/browser.mjs';
import {fakeCdp} from './fake-cdp.js';

/** A WebSocket that records what is sent and lets a test answer in any order. */
class FakeSocket {
  constructor() {
    this.sent = [];
    FakeSocket.last = this;
    queueMicrotask(() => this.onopen?.());
  }
  send(text) { this.sent.push(JSON.parse(text)); }
  reply(message) { this.onmessage({data: JSON.stringify(message)}); }
  close() { this.onclose?.(); }
}

test('replies are matched by id and each command names its session', async t => {
  const real = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket;
  t.after(() => { globalThis.WebSocket = real; });
  const cdp = await connect('ws://fake');
  const socket = FakeSocket.last;
  const a = cdp.send('Runtime.evaluate', {expression: '1'}, 'S1'), b = cdp.send('Runtime.evaluate', {expression: '2'}, 'S2');
  const [fa, fb] = socket.sent;
  assert.deepEqual([fa.sessionId, fb.sessionId], ['S1', 'S2']);
  socket.reply({id: fb.id, result: {value: 'two'}});
  socket.reply({id: fa.id, result: {value: 'one'}});
  assert.deepEqual([await a, await b], [{value: 'one'}, {value: 'two'}]);
});

test('two captures in different tabs interleave on one connection and each gets its own page', async () => {
  const ALLOW = ['a.example', 'b.example'];
  const fake = fakeCdp({pages: {'https://a.example/': {title: 'A', text: 'page a'}, 'https://b.example/': {title: 'B', text: 'page b'}}});
  const live = await startBrowserSession({connection: fake.connection});
  const [ta, tb] = [await live.newTab({allow: ALLOW}), await live.newTab({allow: ALLOW})];
  let releaseA; const heldA = new Promise(r => { releaseA = r; });
  // A hook that returns undefined falls through to the scripted answer.
  fake.hook('Page.navigate', async (params, sessionId) => { if (sessionId === ta.sessionId) await heldA; });
  const pa = live.capture('https://a.example/', {allow: ALLOW, tab: ta, settleMs: 0});
  const pb = await live.capture('https://b.example/', {allow: ALLOW, tab: tb, settleMs: 0});
  releaseA(); const ra = await pa;
  assert.deepEqual([ra.title, ra.text, pb.title, pb.text], ['A', 'page a', 'B', 'page b']);
  const order = fake.calls.map(c => c.sessionId);
  assert.ok(order.indexOf(tb.sessionId) < order.lastIndexOf(ta.sessionId), 'B\'s commands ran between A\'s');
});

test('a page that would not open names only a refusal for its own host', () => {
  const refused = ['old.example:443: x', 'a.example:443: Refusing to reach a.example: it is on a private or local network.', 'b.example:443: Refusing to reach b.example: it is on a private or local network.'];
  assert.match(ownRefusal(refused, 1, 'https://a.example/login'), /^a\.example:443: /);
  assert.equal(ownRefusal(refused, 1, 'https://c.example/'), '');
  assert.equal(ownRefusal(refused, 3, 'https://a.example/'), '', 'only refusals since this page began');
  assert.equal(ownRefusal(['ba.example:443: x'], 0, 'https://a.example/'), '', 'a host that only ends with the name is another host');
  assert.equal(ownRefusal(refused, 0, 'not a url'), '', 'an address that does not parse names no host');
});
