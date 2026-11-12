// The owner decides how far each bot goes. Send, post and delete take Always allow per site; a payment is asked
// every time unless the owner sets Always allow for one bot on one site (behind a confirmation in the UI); a
// payment Deny with no site still covers every site. Bots may click and type on X, and a Post there asks like
// a post anywhere else.
import test from 'node:test';
import assert from 'node:assert/strict';
import {setGrant, grantFor, verdict, askChoices, grantChoices, createAsk, answerAsk, sweepGrants} from '../shared/asks.js';
import {validateBrowserRequest, recordBrowserRequests} from '../shared/bot-browser.js';
import {askCard} from '../shared/ui-asks.js';

const NOW = '2026-11-12T00:00:00.000Z';
const state = () => ({groups: [{id: 'home', bots: [{id: 'b', name: 'Atlas', settings: {lead: true}}]}], grants: [], asks: [], activity: [], groupRuns: [], browserRequests: [], tasks: [], events: []});
const bot = {id: 'b', name: 'Atlas'};

test('a payment can be set to Always allow for one bot on one site', () => {
  const s = state();
  assert.deepEqual(askChoices('spend'), ['decline', 'allow', 'always']);
  assert.deepEqual(grantChoices('spend'), ['always', 'ask', 'deny']);
  assert.throws(() => setGrant(s, 'b', 'spend', '', 'always', NOW), /one site/, 'Always allow names the site');
  setGrant(s, 'b', 'spend', 'https://shop.example/checkout', 'always', NOW);
  assert.equal(grantFor(s, 'b', 'spend', 'https://shop.example'), 'always');
  assert.equal(verdict(s, bot, 'spend', 'https://shop.example/cart').verdict, 'allow');
  assert.equal(verdict(s, bot, 'spend', 'https://other.example/cart').verdict, 'ask', 'another site still asks');
});

test('with nothing set a payment asks, and a Deny with no site covers every site', () => {
  const s = state();
  assert.equal(verdict(s, bot, 'spend', 'https://shop.example/cart').verdict, 'ask');
  setGrant(s, 'b', 'spend', 'https://shop.example', 'always', NOW);
  setGrant(s, 'b', 'spend', '', 'deny', NOW);
  assert.equal(verdict(s, bot, 'spend', 'https://shop.example/cart').verdict, 'deny', 'Deny everywhere wins over one site');
});

test('answering a payment ask with Always allow stores the grant for that site', () => {
  const s = state();
  const ask = createAsk(s, {botId: 'b', chatKey: 'b', action: 'spend', target: 'https://shop.example/checkout', detail: 'pay on shop.example', now: NOW, makeId: () => 'a1'});
  answerAsk(s, ask.id, 'always', NOW);
  assert.equal(grantFor(s, 'b', 'spend', 'https://shop.example'), 'always');
  createAsk(s, {botId: 'b', chatKey: 'b', action: 'spend', target: 'https://b.example/pay', now: NOW, makeId: () => 'a2'});
  const card = askCard(s, {askId: 'a2', text: 'x'});
  assert.deepEqual(card.choices.map(c => c.id), ['allow', 'always', 'decline']);
  assert.match(card.confirmAlways || '', /without asking/, 'Always allow on a payment is confirmed first');
});

test('the load sweep keeps a site payment grant and drops one with no site', () => {
  const s = state();
  s.grants.push({botId: 'b', action: 'spend', scope: 'https://shop.example', choice: 'always', at: NOW}, {botId: 'b', action: 'spend', scope: '', choice: 'always', at: NOW});
  sweepGrants(s);
  assert.deepEqual(s.grants.map(g => g.scope), ['https://shop.example']);
});

test('bots may click and type on X, and a Post there asks', () => {
  const ok = validateBrowserRequest({url: 'https://x.com/home', steps: [{op: 'click', index: 2}, {op: 'type', index: 3, text: 'hello'}]});
  assert.equal(ok.kind, 'browser.action');
  const s = state();
  s.browserRequests.push({id: 'r0', status: 'done', botId: 'b', chatKey: 'b', url: 'https://x.com/home', result: {page: 'Controls: [3] button Post'}});
  const out = recordBrowserRequests(s, {bot, groupId: 'home', chatKey: 'b', output: '```browser\n{"url":"https://x.com/home","steps":[{"op":"click","index":3}]}\n```', makeId: () => 'id1', now: NOW});
  assert.equal(out.asks.length, 1);
  assert.equal(out.asks[0].action, 'post');
});
