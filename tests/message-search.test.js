import test from 'node:test';
import assert from 'node:assert/strict';
import {fold, searchMessages, snippetHtml, MAX_RESULTS} from '../shared/message-search.js';

// Search looks through what was said in every bot chat and thread of the workspace the
// snapshot holds, not only names: newest first, every word must match, accents and case ignored.

const state = () => ({
  groups: [
    {id: 'home', name: 'Company', bots: [{id: 'atlas', name: 'Atlas', settings: {lead: true}}, {id: 'scout', name: 'Scout'}]},
    {id: 't1', name: 'Plan the launch', settings: {kind: 'thread'}, bots: []},
    {id: 'old', name: 'Old team', bots: []},
  ],
  chats: {
    atlas: [
      {id: 'a1', role: 'user', text: 'Book a table at the Café Rouge for Friday', at: '2026-11-10T09:00:00.000Z'},
      {id: 'a2', role: 'bot', text: 'Done: the **cafe** is booked.', at: '2026-11-10T09:01:00.000Z'},
      {id: 'a3', role: 'bot', text: 'fetched the cafe page', step: true, at: '2026-11-10T09:00:30.000Z'},
    ],
    scout: [{id: 's1', role: 'bot', text: 'Nothing about the launch yet.', at: '2026-11-11T09:00:00.000Z'}],
    'team-t1': [{id: 't1m', role: 'user', text: 'Launch on Friday, book the café', at: '2026-11-12T08:00:00.000Z'}],
    'team-old': [{id: 'o1', role: 'user', text: 'café', at: '2026-11-12T08:00:00.000Z'}],
    gone: [{id: 'g1', role: 'user', text: 'café', at: '2026-11-12T08:00:00.000Z'}],
  },
});

test('fold drops case and accents', () => {
  assert.equal(fold('Café ROUGE Ñandú'), 'cafe rouge nandu');
});

test('a word matches message text across bot chats and threads, newest first, accents ignored', () => {
  const hits = searchMessages(state(), 'cafe');
  assert.deepEqual(hits.map(h => h.messageId), ['t1m', 'a2', 'a1']);
  assert.deepEqual(hits[0], {kind: 'thread', id: 't1', chatKey: 'team-t1', name: 'Plan the launch', messageId: 't1m', role: 'user', at: '2026-11-12T08:00:00.000Z', text: 'Launch on Friday, book the café'});
  assert.equal(hits[1].kind, 'bot');
  assert.equal(hits[1].name, 'Atlas');
  assert.equal(hits[1].id, 'atlas');
});

test('every word must match, in any order and case', () => {
  assert.deepEqual(searchMessages(state(), 'FRIDAY café').map(h => h.messageId), ['t1m', 'a1']);
  assert.deepEqual(searchMessages(state(), 'friday launch').map(h => h.messageId), ['t1m']);
  assert.deepEqual(searchMessages(state(), 'friday nowhere'), []);
});

test('an empty query, working steps, and chats with no visible conversation find nothing', () => {
  assert.deepEqual(searchMessages(state(), '   '), []);
  assert.ok(!searchMessages(state(), 'fetched').length, 'a working step is not shown in the chat, so it is not found');
  assert.ok(!searchMessages(state(), 'cafe').some(h => h.chatKey === 'team-old' || h.chatKey === 'gone'));
});

test('results are capped', () => {
  const s = state();
  s.chats.scout = Array.from({length: 200}, (_, i) => ({id: `m${i}`, role: 'bot', text: `launch note ${i}`, at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()}));
  assert.equal(searchMessages(s, 'launch note').length, MAX_RESULTS);
  assert.equal(searchMessages(s, 'launch note', {limit: 5}).length, 5);
  assert.equal(searchMessages(s, 'launch note', {limit: 5})[0].messageId, 'm199');
});

test('a snippet escapes the text first, then marks every word, accents and all', () => {
  const html = snippetHtml('<b>Book</b> the Café & go', 'cafe book');
  assert.equal(html, '&lt;b&gt;<mark>Book</mark>&lt;/b&gt; the <mark>Café</mark> &amp; go');
  assert.ok(!snippetHtml('<script>x</script> cafe', 'script').includes('<script>'));
});

test('a long message is cut around its first match, with markdown read as plain words', () => {
  const text = `${'word '.repeat(60)}the **target** is here ${'tail '.repeat(60)}`;
  const html = snippetHtml(text, 'target');
  assert.ok(html.startsWith('…') && html.endsWith('…'));
  assert.ok(html.includes('<mark>target</mark>'));
  assert.ok(!html.includes('**'));
  assert.ok(html.length < 220);
});
