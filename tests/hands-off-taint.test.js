/** Hands-off covers sends only for a run that has read nothing from outside. Once a run has read external
 * content (a connector result, a browser page, an outside event), a send asks even with Hands-off on: injected
 * text in an email can ask the bot to send, and that must not go out unasked.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {verdict, decide} from '../shared/asks.js';

const bot = {id: 'atlas', name: 'Atlas'};
const handsOff = () => ({handsOff: true, askBasics: false, grants: [], asks: []});

test('Hands-off still covers a send from a run that read nothing outside', () => {
  assert.equal(verdict(handsOff(), bot, 'send', 'mail.example').verdict, 'allow');
});

test('Hands-off does not cover a send once the run has read external content', () => {
  assert.equal(verdict(handsOff(), bot, 'send', 'mail.example', {tainted: true}).verdict, 'ask');
});

test('Hands-off does not cover a connector write once the run has read external content', () => {
  assert.equal(verdict(handsOff(), bot, 'connector.gmail.write', 'bob@example.org', {tainted: true}).verdict, 'ask');
});

test('a private read is also taint, even when the read connector is the one sending', () => {
  assert.equal(verdict(handsOff(), bot, 'send', 'mail.example', {readPrivate: true}).verdict, 'ask');
});

test('decide carries the taint from its guard to every need', () => {
  const needs = [{action: 'send', target: 'mail.example', detail: 'send mail'}];
  assert.notEqual(decide(handsOff(), bot, needs, {tainted: true}).verdict, 'allow');
  assert.equal(decide(handsOff(), bot, needs, {}).verdict, 'allow');
});
