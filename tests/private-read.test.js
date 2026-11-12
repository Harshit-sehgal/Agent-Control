// A run that read private data (a connector result, or the owner's signed-in mail or files in the browser) must
// not open a new site without asking: an address is enough to carry what was read off to that site.
import test from 'node:test';
import assert from 'node:assert/strict';
import {recordBrowserRequests} from '../shared/bot-browser.js';
import {resolveSetup} from '../shared/setup.js';

const state = () => ({groups: [{id: 'home', bots: [{id: 'atlas', name: 'Atlas', settings: {lead: true}}]}], groupRuns: [{id: 'r1', status: 'running'}], browserRequests: [], asks: [], grants: [], activity: [], tasks: [], events: []});
const record = (s, url) => { let n = 0; return recordBrowserRequests(s, {bot: {id: 'atlas', name: 'Atlas'}, groupId: 'home', chatKey: 'atlas', output: `\`\`\`browser\n${JSON.stringify({url})}\n\`\`\``, depth: 0, makeId: () => `id${++n}`, runId: 'r1'}); };

test('a run that read the owner\'s Gmail in the browser asks before opening another site', () => {
  const s = state();
  s.browserRequests.push({id: 'g', status: 'done', runId: 'r1', chatKey: 'atlas', botId: 'atlas', url: 'https://mail.google.com/mail/u/0/', result: {finalUrl: 'https://mail.google.com/mail/u/0/#inbox', page: 'Inbox'}});
  assert.equal(record(s, 'https://example.com/?q=secret').asks.length, 1, 'a new site asks');
  assert.equal(record(s, 'https://mail.google.com/mail/u/0/#inbox/abc').asks.length, 0, 'more of the same inbox does not');
});

test('a chain with no run id that read the owner\'s Gmail still asks before opening another site', () => {
  // Fail closed: a 1:1 browse continued with no run record (an old request) is guarded by its own chat's reads.
  const s = state();
  s.browserRequests.push({id: 'g', status: 'done', chatKey: 'atlas', botId: 'atlas', url: 'https://mail.google.com/mail/u/0/', result: {finalUrl: 'https://mail.google.com/mail/u/0/#inbox', page: 'Inbox'}});
  const bare = url => { let n = 0; return recordBrowserRequests(s, {bot: {id: 'atlas', name: 'Atlas'}, groupId: 'home', chatKey: 'atlas', output: `\`\`\`browser\n${JSON.stringify({url})}\n\`\`\``, depth: 1, makeId: () => `b${++n}`}); };
  const out = bare('https://evil.example/?d=x');
  assert.equal(out.asks.length, 1, 'a new site asks');
  assert.equal(out.records[0].askId, out.asks[0].id, 'the page waits on that ask, so it is not dispatched');
  assert.equal(bare('https://mail.google.com/mail/u/0/#inbox/abc').asks.length, 0, 'more of the same inbox does not');
  // Another chat's reads, or a run's, are not this chain's.
  const other = state();
  other.browserRequests.push({id: 'g', status: 'done', chatKey: 'scout', botId: 'scout', url: 'https://mail.google.com/', result: {finalUrl: 'https://mail.google.com/'}},
    {id: 'h', status: 'done', runId: 'r1', chatKey: 'atlas', botId: 'atlas', url: 'https://mail.google.com/', result: {finalUrl: 'https://mail.google.com/'}});
  let n = 0;
  assert.equal(recordBrowserRequests(other, {bot: {id: 'atlas', name: 'Atlas'}, groupId: 'home', chatKey: 'atlas', output: '```browser\n{"url":"https://example.com/"}\n```', makeId: () => `c${++n}`}).asks.length, 0);
});

test('a run without private reads opens a public page without asking', () => {
  const out = record(state(), 'https://example.com/');
  assert.equal(out.records.length, 1);
  assert.equal(out.asks.length, 0);
  assert.equal(record(state(), 'https://mail.google.com/').asks.length, 0, 'reading Gmail itself is basic access');
});

test('a connector read keeps the run guarded after its result is consumed', () => {
  const s = state();
  s.groupRuns[0].readPrivate = true;
  const out = record(s, 'https://example.com/?q=secret');
  assert.equal(out.asks.length, 1);
});

test('with no Google client saved, Connect Gmail offers a Sign in card for Gmail in the shared browser', () => {
  const s = state();
  for (const page of ['gmail', 'google']) {
    const made = resolveSetup(s, {action: 'open', page});
    assert.equal(made.card.action, 'signin');
    assert.equal(made.card.url, 'https://mail.google.com/');
  }
  assert.equal(resolveSetup(s, {action: 'open', page: 'drive'}).card.url, 'https://drive.google.com/');
  s.connectors = [{id: 'google', kind: 'google', clientCredentialId: 'c1', status: 'setup'}];
  assert.equal(resolveSetup(s, {action: 'open', page: 'gmail'}).card.app, 'google', 'a saved client keeps the real Google sign-in');
});
