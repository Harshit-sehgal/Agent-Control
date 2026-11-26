// Connected apps are used through their own tools (MCP or Google's API), as the owner. The browser is for what no
// connector does, like scrolling X: a page on a connected app's own site goes back to the bot once, told to use the tools.
import test from 'node:test';
import assert from 'node:assert/strict';
import {APPS, appById, appForHost, connectHow} from '../shared/app-catalog.js';
import {recordBrowserRequests} from '../shared/bot-browser.js';
import {CONNECTOR_TOOL_HINT} from '../shared/connectors.js';

const state = connectors => ({groups: [{id: 'home', bots: [{id: 'atlas', name: 'Atlas', settings: {lead: true}}]}], groupRuns: [{id: 'r1', status: 'running'}],
  browserRequests: [], asks: [], grants: [], activity: [], tasks: [], events: [], connectors});
const ask = (s, url) => { let n = 0; return recordBrowserRequests(s, {bot: {id: 'atlas', name: 'Atlas'}, groupId: 'home', chatKey: 'atlas', output: '```browser\n' + JSON.stringify({url}) + '\n```', makeId: () => `id${++n}`, runId: 'r1'}); };
const notionMcp = {id: 'notion', kind: 'mcp', app: 'notion', name: 'Notion', status: 'ready', actions: [{name: 'search', write: false}]};

test('every app knows the sites that are its own', () => {
  assert.equal(appForHost('www.notion.so')?.id, 'notion');
  assert.equal(appForHost('acme.atlassian.net')?.id, 'atlassian');
  assert.equal(appForHost('mail.google.com')?.id, 'gmail');
  assert.equal(appForHost('x.com'), null);
  assert.equal(appForHost('notnotion.so'), null, 'a look-alike domain is not the app');
});

test('apps whose official server signs in by itself connect in one tap, straight to the account', () => {
  for (const id of ['notion', 'linear', 'atlassian', 'sentry', 'cloudflare', 'supabase', 'stripe', 'zapier', 'todoist', 'airtable']) {
    assert.equal(connectHow(appById(id), {}), 'oauth', id);
    assert.match(appById(id).oauth, /^https:\/\//, id);
  }
  assert.equal(connectHow(appById('github'), {}), 'form', 'GitHub does not let an app register itself: a token, or the server\'s client');
  assert.equal(connectHow(appById('figma'), {}), 'form', 'Figma refuses apps it has not approved');
  assert.ok(APPS.filter(a => a.oauth).length >= 10);
});

test('a page on a connected app goes back to the bot, told to use the connector', () => {
  const s = state([notionMcp]);
  const out = ask(s, 'https://www.notion.so/My-page-123');
  assert.equal(out.records.length, 0, 'nothing is opened');
  assert.match(out.invalid[0], /Notion is connected/);
  assert.match(out.invalid[0], /"use":"notion"/);
  // Asked again in the same task (its tools could not do it), the page opens.
  assert.equal(ask(s, 'https://www.notion.so/My-page-123').records.length, 1);
});

test('the browser still opens what no connector covers, and an app that is not connected', () => {
  assert.equal(ask(state([notionMcp]), 'https://x.com/home').records.length, 1, 'scrolling X is the browser');
  assert.equal(ask(state([]), 'https://www.notion.so/x').records.length, 1, 'Notion is not connected');
  assert.equal(ask(state([{...notionMcp, status: 'error'}]), 'https://www.notion.so/x').records.length, 1, 'a broken connector is no help');
  assert.equal(ask(state([{id: 'notion-site', kind: 'site', app: 'notion', host: 'www.notion.so', status: 'ready'}]), 'https://www.notion.so/x').records.length, 1, 'signed in through the browser is the browser');
});

test('Gmail in the browser goes back to the bot only when Gmail is connected', () => {
  const gmail = {id: 'gmail', kind: 'mcp', app: 'gmail', name: 'Gmail', status: 'ready', actions: [{name: 'search_threads', write: false}]};
  assert.match(ask(state([gmail]), 'https://mail.google.com/mail/u/0/#inbox').invalid[0], /"use":"gmail"/);
  assert.equal(ask(state([{...gmail, status: 'reconnect'}]), 'https://mail.google.com/mail/u/0/').records.length, 1);
  // An older Google connection still covers Gmail and Drive.
  const old = {id: 'google', kind: 'google', name: 'Google', status: 'ready', actions: [{name: 'gmail.search', write: false}]};
  assert.match(ask(state([old]), 'https://drive.google.com/drive/my-drive').invalid[0], /"use":"google"/);
});

test('bots are told connectors come first and the browser is for the rest', () => {
  assert.match(CONNECTOR_TOOL_HINT, /first/i);
  assert.match(CONNECTOR_TOOL_HINT, /browser/i);
});

test('the page says how a direct sign-in ended, by the app\'s name, and tidies the address', async () => {
  const {googleReturn, withoutGoogleParams} = await import('../shared/ui-connect-model.js');
  assert.deepEqual(googleReturn('?connect=connected&app=notion'), {ok: true, text: 'Notion is connected. Bots use it on your account directly.'});
  assert.match(googleReturn('?connect=error&app=linear&reason=denied').text, /^Linear: The sign-in was cancelled/);
  assert.match(googleReturn('?connect=error&app=x&reason=<b>').text, /could not finish/, 'an unknown reason is never echoed');
  assert.equal(withoutGoogleParams('?connect=connected&app=notion&tab=1'), '?tab=1');
  const {catalogView} = await import('../shared/app-catalog.js');
  assert.equal(catalogView({connectors: [{id: 'notion', kind: 'mcp', app: 'notion', name: 'Notion'}]}).connected.map(a => a.id).join(), 'notion');
});
