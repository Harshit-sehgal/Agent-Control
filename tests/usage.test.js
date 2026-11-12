import test from 'node:test';
import assert from 'node:assert/strict';
import {costOf, priceFor, addUsage, recordDay, monthByBot, usageWords, parsePrices, cleanPrices, pricesText, USAGE_DAYS, emptyUsage} from '../shared/usage.js';

test('cost is null without a price: tokens are counted, money is never guessed', () => {
  assert.equal(costOf({input: 1000, output: 500}, null), null);
  assert.equal(priceFor({}, 'gpt-x'), null);
  assert.equal(priceFor({'gpt-x': {input: 2}}, 'gpt-x'), null, 'half a price is no price');
});

test('cost math: input and cache writes at the input rate, cache reads at the cached rate when given, output at its rate', () => {
  const price = {input: 3, output: 15};
  assert.equal(costOf({input: 1e6, output: 1e6}, price), 18);
  // Cache writes and reads fall back to the input price: the only rate the owner gave.
  assert.equal(costOf({input: 0, cacheWrite: 1e6, cacheRead: 1e6, output: 0}, price), 6);
  assert.equal(costOf({cacheRead: 1e6}, {...price, cached: 0.3}), 0.3);
});

test('a total keeps tokens, cost, unpriced and subscription calls apart', () => {
  let t = addUsage(null, {input: 100, output: 10, cost: 0.5});
  t = addUsage(t, {input: 50, output: 5});
  t = addUsage(t, {input: 7, output: 1, subscription: true});
  assert.deepEqual({...t, cost: Number(t.cost.toFixed(2))}, {input: 157, output: 16, cacheRead: 0, cacheWrite: 0, calls: 3, cost: 0.5, unpriced: 1, subscription: 1});
});

test('usage words name tokens, cost when priced, and say a subscription is included', () => {
  assert.equal(usageWords(emptyUsage()), '');
  assert.equal(usageWords(addUsage(null, {input: 12000, cacheRead: 3000, output: 800, cost: 0.042})), '15k tokens in (3.0k cached) · 800 out · ≈ $0.04');
  assert.equal(usageWords(addUsage(null, {input: 1200, output: 80})), '1.2k tokens in · 80 out', 'no price, no money');
  assert.equal(usageWords(addUsage(null, {subscription: true})), 'included in subscription');
  const mixed = addUsage(addUsage(null, {input: 10, output: 1, cost: 0.001}), {input: 10, output: 1});
  assert.match(usageWords(mixed), /<\$0\.01 \+ 1 call with no price/);
});

test('per-day per-bot totals are bounded and this month reads by bot', () => {
  const state = {};
  recordDay(state, {botId: 'a', input: 100, output: 10, cost: 0.01}, '2026-11-02T10:00:00Z');
  recordDay(state, {botId: 'a', input: 100, output: 10}, '2026-11-03T10:00:00Z');
  recordDay(state, {botId: 'b', input: 5, output: 5}, '2026-11-03T11:00:00Z');
  recordDay(state, {botId: 'b', input: 999, output: 999}, '2026-10-30T11:00:00Z');
  const month = monthByBot(state, new Map([['a', 'Atlas'], ['b', 'Scout']]), new Date('2026-11-12T00:00:00Z'));
  assert.equal(month.month, '2026-11');
  assert.deepEqual(month.rows.map(r => [r.name, r.tokens, r.calls]), [['Atlas', 220, 2], ['Scout', 10, 1]]);
  assert.equal(month.total.tokens, 230);
  for (let d = 0; d < USAGE_DAYS + 10; d++) recordDay(state, {botId: 'a', input: 1}, new Date(Date.UTC(2027, 0, 1) + d * 864e5).toISOString());
  assert.equal(Object.keys(state.usage.days).length, USAGE_DAYS);
});

test('prices parse from lines, round-trip, and the server refuses a broken one', () => {
  const {prices, invalid} = parsePrices('gpt-4.1: 2 / 8\nclaude-sonnet-5-5 = 2 / 10 / 0.1\nnonsense');
  assert.deepEqual(prices, {'gpt-4.1': {input: 2, output: 8}, 'claude-sonnet-5-5': {input: 2, output: 10, cached: 0.1}});
  assert.deepEqual(invalid, ['nonsense']);
  assert.deepEqual(parsePrices(pricesText(prices)).prices, prices);
  assert.deepEqual(cleanPrices(prices), prices);
  assert.deepEqual(cleanPrices(null), {});
  assert.throws(() => cleanPrices({m: {input: 'x', output: 1}}), /input and an output price/);
  assert.throws(() => cleanPrices({m: {input: -1, output: 1}}), /input and an output price/);
});
