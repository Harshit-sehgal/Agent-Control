// Connect apps is one tap per app, like Gmail: an app with a web sign-in opens it in the shared browser (bots then use
// it there), an app that needs nothing connects at once, and only an app with no web sign-in asks for a token.
import test from 'node:test';
import assert from 'node:assert/strict';
import {APPS, appById, connectHow, catalogView} from '../shared/app-catalog.js';
import {envelopeConnectors, siteConnector} from '../shared/connectors.js';
import {recordBrowserRequests} from '../shared/bot-browser.js';

test('every app says how one tap connects it', () => {
  const how = id => connectHow(appById(id), {});
  assert.equal(how('time'), 'now', 'nothing to fill in');
  assert.equal(how('filesystem'), 'now', 'its one field has a default');
  for (const id of ['github', 'slack', 'figma']) assert.equal(how(id), 'site', id);
  for (const id of ['notion', 'linear', 'airtable', 'stripe']) assert.equal(how(id), 'oauth', id);
  assert.equal(how('git'), 'form', 'a repo folder has no sensible default');
  assert.equal(how('obsidian'), 'form', 'a vault on this computer has no web sign-in');
  assert.equal(connectHow(appById('google'), {}), 'gmail', 'no Google client: sign in to Gmail in the shared browser');
  assert.equal(connectHow(appById('google'), {googleClient: true}), 'google', 'a saved client keeps the real Google sign-in');
  for (const app of APPS.filter(a => connectHow(a, {}) === 'site')) assert.match(app.site, /^https:\/\/[^/]+\.[a-z]+\//, app.id);
});

test('a site connector is an app signed in through the browser, and the catalogue counts it as connected', () => {
  const made = siteConnector({connectors: []}, appById('notion'), {now: '2026-11-12T00:00:00.000Z'});
  assert.deepEqual([made.kind, made.app, made.name, made.host, made.status], ['site', 'notion', 'Notion', 'www.notion.so', 'ready']);
  const view = catalogView({connectors: [made]});
  assert.equal(view.connected.map(a => a.id).join(), 'notion');
  assert.throws(() => siteConnector({connectors: []}, appById('git')), /sign-in/);
});

test('bots are told to use a signed-in app through the browser, not as tools', () => {
  const made = siteConnector({connectors: []}, appById('notion'));
  const [entry] = envelopeConnectors({connectors: [made]});
  assert.equal(entry.name, 'Notion');
  assert.equal(entry.site, 'https://www.notion.so/');
  assert.equal(entry.tools, undefined);
  assert.match(entry.how, /browser/);
});

test('pages read on a signed-in app are private: the run asks before opening a new site', () => {
  const s = {groups: [{id: 'home', bots: [{id: 'atlas', name: 'Atlas', settings: {lead: true}}]}], groupRuns: [{id: 'r1', status: 'running'}],
    browserRequests: [{id: 'n', status: 'done', runId: 'r1', chatKey: 'atlas', botId: 'atlas', url: 'https://www.notion.so/My-notes-1', result: {page: 'notes'}}],
    asks: [], grants: [], activity: [], tasks: [], events: [], connectors: [siteConnector({connectors: []}, appById('notion'))]};
  let n = 0;
  const out = recordBrowserRequests(s, {bot: {id: 'atlas', name: 'Atlas'}, groupId: 'home', chatKey: 'atlas', output: '```browser\n{"url":"https://example.com/?q=notes"}\n```', depth: 0, makeId: () => `id${++n}`, runId: 'r1'});
  assert.equal(out.asks.length, 1);
});

test('the server adds a site connector once per app, and refresh leaves it ready', async () => {
  const {addSiteConnector, refreshConnector} = await import('../src/connectors.js');
  const state = {connectors: []};
  const store = {read: () => state, update: fn => Promise.resolve(fn(state))};
  const made = await addSiteConnector(store, {app: 'notion'});
  assert.equal(made.kind, 'site');
  assert.equal((await addSiteConnector(store, {app: 'notion'})).id, made.id, 'a second tap does not add a second Notion');
  assert.equal(state.connectors.length, 1);
  assert.equal((await refreshConnector(store, made.id)).status, 'ready');
  await assert.rejects(addSiteConnector(store, {app: 'nope'}), /not in the list/);
});

test('with no Google client, Connect Gmail is a sign-in at mail.google.com that never takes the Google id', () => {
  const made = siteConnector({connectors: []}, appById('google'));
  assert.equal(made.url, 'https://mail.google.com/');
  assert.notEqual(made.id, 'google', 'the real Google sign-in keeps its own id');
  assert.equal(catalogView({connectors: [made]}).connected.map(a => a.id).join(), 'google');
});
