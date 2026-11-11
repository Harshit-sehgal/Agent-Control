// A bot that searches the same words in another order, or with a plural, is
// not finding anything new: the run counts it as a page it already has.
import test from 'node:test';
import assert from 'node:assert/strict';
import {sameSearch, recordBrowserRequests} from '../shared/bot-browser.js';

const bing = q => `https://www.bing.com/search?q=${encodeURIComponent(q).replace(/%20/g, '+')}`;

test('the same words in another order, case or plural are the same search', () => {
  assert.ok(sameSearch(bing('PowerPod frontend intern careers Bangalore'), bing('PowerPod careers frontend intern Bangalore')));
  assert.ok(sameSearch(bing('Sqiki frontend internship'), bing('sqiki frontend internships')));
  assert.ok(sameSearch(bing('weather delhi'), 'https://duckduckgo.com/?q=delhi+weather'));
});

test('a different question is a different search', () => {
  assert.ok(!sameSearch(bing('Sqiki frontend internship'), bing('Sqiki frontend internship stipend')));
  assert.ok(!sameSearch(bing('weather delhi'), 'https://example.com/weather/delhi'));
  assert.ok(!sameSearch('https://example.com/a', 'https://example.com/a'));
});

test('a reworded repeat search is not opened again', () => {
  const state = {browserRequests: [], chats: {}};
  const output = '```browser\n' + JSON.stringify({url: bing('PowerPod careers frontend intern Bangalore')}) + '\n```';
  const r = recordBrowserRequests(state, {bot: {id: 'b', name: 'Atlas'}, groupId: 'home', chatKey: 'atlas', output, skipUrls: [bing('PowerPod frontend intern careers Bangalore')], makeId: () => 'x'});
  assert.equal(r.records.length, 0);
  assert.equal(r.repeated, 1);
});

test('a site that refused the browser twice in a run is not opened a third time', () => {
  const denied = n => ({id: `d${n}`, runId: 'r1', chatKey: 'atlas', status: 'done', url: `https://www.sony.co.in/p${n}`, result: {title: 'Access Denied', finalUrl: `https://www.sony.co.in/p${n}`, page: 'Access Denied'}});
  const state = {browserRequests: [denied(1), denied(2)], chats: {}, groupRuns: [{id: 'r1'}]};
  const output = '```browser\n' + JSON.stringify({url: 'https://www.sony.co.in/p3'}) + '\n```';
  const r = recordBrowserRequests(state, {bot: {id: 'b', name: 'Atlas'}, groupId: 'home', chatKey: 'atlas', output, runId: 'r1', makeId: () => 'x'});
  assert.equal(r.records.length, 0);
  assert.deepEqual(r.refused, ['www.sony.co.in']);
  assert.match(r.lines.map(l => l.text).join(' '), /www\.sony\.co\.in refused this browser twice/);
});

test('one refusal is not enough to give up on a site', () => {
  const state = {browserRequests: [{id: 'd1', runId: 'r1', chatKey: 'atlas', status: 'done', url: 'https://www.sony.co.in/p1', result: {title: 'Access Denied', page: 'Access Denied'}}], chats: {}, groupRuns: [{id: 'r1'}]};
  const output = '```browser\n' + JSON.stringify({url: 'https://www.sony.co.in/p3'}) + '\n```';
  const r = recordBrowserRequests(state, {bot: {id: 'b', name: 'Atlas'}, groupId: 'home', chatKey: 'atlas', output, runId: 'r1', makeId: () => 'x'});
  assert.equal(r.records.length, 1);
});
