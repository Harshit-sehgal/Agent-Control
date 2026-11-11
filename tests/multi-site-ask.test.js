/** One ask covers exactly what it shows. A browser request whose steps need the owner's say on more than
 * one (action, origin) pair raises one ask that names every pair; Allow approves exactly those pairs; and
 * an ask across more than one site never offers Always allow (a grant is for one site), on the card or
 * through the API. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as wf from '../shared/workflow.js';
import {answerAsk, setGrant} from '../shared/asks.js';
import {askCard} from '../shared/ui-asks.js';
import {recordBrowserRequests} from '../shared/bot-browser.js';
import {answerAskFlow} from '../src/ask-runs.js';

const NOW = '2026-11-11T10:00:00.000Z';
const A = 'https://a.example', B = 'https://b.example';
// These tests are about the ask card, so the owner's switch to ask even before a page or a read is on.
const state = () => wf.migrate({
  askBasics: true, settings: {}, runs: [], tasks: [], events: [], groupMessages: {}, groupRuns: [],
  groups: [{id: 'home', name: 'Home', bots: [{id: 'a', name: 'Atlas', instructions: 'lead'}, {id: 'b', name: 'Shopper', instructions: 'shop'}]}],
});
const shopper = s => s.groups[0].bots.find(b => b.id === 'b');
const block = body => `On it.\n\`\`\`browser\n${JSON.stringify(body)}\n\`\`\``;
const mk = (() => { let n = 0; return () => `ms-${++n}`; })();
// Send on a.example, then Send on b.example. Neither is Always allow.
const twoSends = {url: `${A}/inbox`, steps: [{op: 'click', selector: '#send'}, {op: 'navigate', url: `${B}/inbox`}, {op: 'click', selector: '#send'}]};
const record = (s, body = twoSends) => recordBrowserRequests(s, {bot: shopper(s), groupId: 'home', chatKey: 'b', makeId: mk, now: NOW, output: block(body)});
const risky = ask => (ask.covers || []).filter(c => c.action !== 'browser.use').map(c => `${c.action}@${c.scope}`);

test('one ask names every site it covers: Send on a.example and on b.example', () => {
  const s = state();
  const {asks: [card], records} = record(s);
  assert.equal(records.length, 1);
  assert.match(card.detail, /a\.example/, 'the card names a.example');
  assert.match(card.detail, /b\.example/, 'the card names b.example');
  assert.deepEqual(risky(card), [`send@${A}`, `send@${B}`], 'the ask lists both pairs');
});

test('Allow on an ask across sites approves exactly the pairs it lists, and no others', () => {
  const s = state();
  const {asks: [card], records: [request]} = record(s);
  answerAsk(s, card.id, 'allow', NOW);
  assert.deepEqual(request.approved, risky(card));
  assert.deepEqual(request.approved, [`send@${A}`, `send@${B}`]);
});

test('an ask across sites offers Decline and Allow only, never Always allow', () => {
  const s = state();
  const {asks: [card]} = record(s);
  const view = askCard(s, {askId: card.id, text: 'Shopper wants to send.'});
  assert.deepEqual(view.choices.map(c => c.id), ['allow', 'decline']);
});

test('Always allow on an ask across sites is refused with a 400 and stores no grant', async () => {
  const s = state();
  const {asks: [card]} = record(s);
  assert.throws(() => answerAsk(s, card.id, 'always', NOW), e => e.status === 400);
  const store = {update: async fn => fn(s), read: () => s};
  await assert.rejects(answerAskFlow(store, card.id, 'always'), e => e.status === 400);
  assert.equal(card.status, 'pending', 'the ask still waits for Decline or Allow');
  assert.deepEqual(s.grants || [], [], 'no grant for either site');
});

test('one site, two actions: the ask names both and still offers Always allow for that site', () => {
  const s = state();
  setGrant(s, 'b', 'browser.use', A, 'always', NOW, {log: false});
  const {asks: [card], records: [request]} = record(s, {url: `${A}/inbox`, steps: [{op: 'click', selector: '#delete'}, {op: 'click', selector: '#send'}]});
  assert.match(card.detail, /delete/);
  assert.match(card.detail, /send/);
  assert.deepEqual(askCard(s, {askId: card.id, text: ''}).choices.map(c => c.id), ['always', 'allow', 'decline']);
  answerAsk(s, card.id, 'always', NOW);
  assert.deepEqual(request.approved, [`delete@${A}`, `send@${A}`]);
  assert.deepEqual(s.grants.filter(g => g.choice === 'always' && g.action !== 'browser.use').map(g => `${g.action}@${g.scope}`).sort(), [`delete@${A}`, `send@${A}`]);
});

test('a page on a second site is named too: Send on b.example after opening a.example', () => {
  const s = state();
  setGrant(s, 'b', 'browser.use', B, 'always', NOW, {log: false});
  const {asks: [card]} = record(s, {url: `${A}/start`, steps: [{op: 'navigate', url: `${B}/inbox`}, {op: 'click', selector: '#send'}]});
  assert.match(card.detail, /a\.example/, 'opening a.example is part of what Allow approves');
  assert.match(card.detail, /b\.example/);
  assert.deepEqual(askCard(s, {askId: card.id, text: ''}).choices.map(c => c.id), ['allow', 'decline']);
});
