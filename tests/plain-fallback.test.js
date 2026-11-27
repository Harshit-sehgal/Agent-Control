import test from 'node:test';
import assert from 'node:assert/strict';
import {plainFallback} from '../agent/page-fetch.mjs';

/* When the browser's answer comes back turned away or nearly empty, the device may read the page again by a plain,
 * cookieless fetch. That is never right for a page read as a browser account: the plain read would show the page signed
 * out and pass it off as the account's. */

const A = '0a1b2c3d-0000-4000-8000-00000000000a';
const short = {text: 'Hi', finalUrl: 'https://crm.example.com/'};
const away = {title: 'Access Denied', text: 'no'};
const long = {title: 'Inbox', text: 'x'.repeat(400)};

test('a signed-in account page is never swapped for a cookieless plain read', () => {
  assert.equal(plainFallback({kind: 'browser.capture', payload: {url: 'https://crm.example.com/', botId: 'scout', account: A}}, short), false);
  assert.equal(plainFallback({kind: 'browser.capture', payload: {url: 'https://crm.example.com/', botId: 'scout', account: A}}, away), false, 'turned away too');
  assert.equal(plainFallback({kind: 'browser.capture', payload: {url: 'https://crm.example.com/', botId: 'scout'}}, short), true, 'no account: today\'s rule');
  assert.equal(plainFallback({kind: 'browser.capture', payload: {url: 'https://x.com/', botId: 'scout', steps: [{click: 1}]}}, short), false);
});

test('without an account the rule is today\'s: turned away, or under 300 characters', () => {
  const task = {kind: 'browser.capture', payload: {url: 'https://crm.example.com/'}};
  assert.equal(plainFallback(task, away), true);
  assert.equal(plainFallback(task, long), false);
  assert.equal(plainFallback(task, null), true, 'no answer at all');
  assert.equal(plainFallback({kind: 'browser.capture', payload: {url: 'https://crm.example.com/', steps: []}}, short), true, 'an empty step list is no steps');
  assert.equal(plainFallback({kind: 'browser.capture'}, short), true, 'a task with no payload');
});
