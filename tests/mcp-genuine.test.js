// Every app in Connect apps is a real MCP connector: Gmail, Drive and Calendar are Google's own MCP servers, signed in
// to with the server's Google client from .env (no form in the app); GitHub and Slack sign in the same way when the
// server has their client, and keep a token otherwise. Nothing is "connected" by signing in to a website any more.
import test from 'node:test';
import assert from 'node:assert/strict';
import {APPS, appById, appForHost, connectHow, catalogView, connectRequest} from '../shared/app-catalog.js';
import {resolveSetup} from '../shared/setup.js';

const GOOGLE = {gmail: 'https://gmailmcp.googleapis.com/mcp/v1', 'google-drive': 'https://drivemcp.googleapis.com/mcp/v1', 'google-calendar': 'https://calendarmcp.googleapis.com/mcp/v1'};

test('Gmail, Drive and Calendar are Google\'s official MCP servers, signed in with the Google client', () => {
  for (const [id, url] of Object.entries(GOOGLE)) {
    const app = appById(id);
    assert.ok(app, id);
    assert.equal(app.oauth, url, id);
    assert.equal(app.client, 'google', id);
    assert.ok(app.scopes.length && app.scopes.every(s => s.startsWith('https://www.googleapis.com/auth/')), id);
    assert.equal(connectHow(app, {}), 'setup', `${id}: no client on the server yet`);
    assert.equal(connectHow(app, {clients: {google: true}}), 'oauth', `${id}: one tap to Google's sign-in`);
    assert.equal(connectRequest(app, {}).ok, false, 'there is no token way for Google');
  }
  assert.equal(appById('google'), null, 'no stand-in Google entry');
});

test('GitHub and Slack sign in with the server\'s client, and keep their token otherwise', () => {
  for (const id of ['github', 'slack']) {
    assert.equal(appById(id).client, id);
    assert.match(appById(id).oauth, /^https:\/\//);
    assert.equal(connectHow(appById(id), {}), 'form', `${id}: its token`);
    assert.equal(connectHow(appById(id), {clients: {[id]: true}}), 'oauth', `${id}: one tap`);
  }
  assert.equal(connectHow(appById('notion'), {}), 'oauth', 'self-registering apps need no client');
});

test('no app connects by signing in to its website', () => {
  for (const app of APPS) {
    assert.equal(app.site, undefined, app.id);
    assert.notEqual(connectHow(app, {}), 'site', app.id);
    assert.ok(app.oauth || app.run || app.web, `${app.id} has a real MCP server`);
  }
});

test('Google\'s own sites belong to each Google app', () => {
  assert.equal(appForHost('mail.google.com')?.id, 'gmail');
  assert.equal(appForHost('drive.google.com')?.id, 'google-drive');
  assert.equal(appForHost('docs.google.com')?.id, 'google-drive');
  assert.equal(appForHost('calendar.google.com')?.id, 'google-calendar');
  const view = catalogView({connectors: [{kind: 'mcp', app: 'gmail', id: 'gmail', name: 'Gmail'}]});
  assert.deepEqual(view.connected.map(a => a.id), ['gmail']);
});

test('a bot asked for Gmail, Drive or Calendar offers a Connect card for that MCP app', () => {
  const s = {groups: [{id: 'home', bots: [{id: 'atlas', name: 'Atlas', settings: {lead: true}}]}], connectors: []};
  const card = request => resolveSetup(s, request).card;
  assert.deepEqual(card({action: 'open', page: 'gmail'}), {action: 'connect', app: 'gmail', text: 'Connect Gmail'});
  assert.equal(card({action: 'open', page: 'google'}).app, 'gmail');
  assert.equal(card({action: 'open', page: 'drive'}).app, 'google-drive');
  assert.equal(card({action: 'open', page: 'calendar'}).app, 'google-calendar');
  assert.equal(card({action: 'connect', app: 'google'}).app, 'gmail');
  assert.equal(card({action: 'connect', app: 'Google Calendar'}).app, 'google-calendar');
});
