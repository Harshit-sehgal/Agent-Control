// Older connections: an app signed in to in the shared browser, from before every app was an MCP server. Nothing
// makes one any more (tests/mcp-genuine.test.js), but one already saved keeps working: bots are told to use it in the
// browser, and what they read there stays private to the run.
import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogView} from '../shared/app-catalog.js';
import {envelopeConnectors} from '../shared/connectors.js';
import {recordBrowserRequests} from '../shared/bot-browser.js';

const OLD_NOTION = {id: 'notion', kind: 'site', app: 'notion', name: 'Notion', host: 'www.notion.so', url: 'https://www.notion.so/', status: 'ready', statusMessage: '', actions: []};

test('an older browser sign-in is not counted as connected, so Connect offers the real server', () => {
  assert.equal(catalogView({connectors: [OLD_NOTION]}).connectedCount, 0);
});

test('bots are told to use a signed-in app through the browser, not as tools', () => {
  const made = OLD_NOTION;
  const [entry] = envelopeConnectors({connectors: [made]});
  assert.equal(entry.name, 'Notion');
  assert.equal(entry.site, 'https://www.notion.so/');
  assert.equal(entry.tools, undefined);
  assert.match(entry.how, /browser/);
});

test('pages read on a signed-in app are private: the run asks before opening a new site', () => {
  const s = {groups: [{id: 'home', bots: [{id: 'atlas', name: 'Atlas', settings: {lead: true}}]}], groupRuns: [{id: 'r1', status: 'running'}],
    browserRequests: [{id: 'n', status: 'done', runId: 'r1', chatKey: 'atlas', botId: 'atlas', url: 'https://www.notion.so/My-notes-1', result: {page: 'notes'}}],
    asks: [], grants: [], activity: [], tasks: [], events: [], connectors: [OLD_NOTION]};
  let n = 0;
  const out = recordBrowserRequests(s, {bot: {id: 'atlas', name: 'Atlas'}, groupId: 'home', chatKey: 'atlas', output: '```browser\n{"url":"https://example.com/?q=notes"}\n```', depth: 0, makeId: () => `id${++n}`, runId: 'r1'});
  assert.equal(out.asks.length, 1);
});
