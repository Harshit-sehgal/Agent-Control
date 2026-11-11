import test from 'node:test';
import assert from 'node:assert/strict';
import {APPS, CATEGORIES, appById, catalogView, filterApps, connectRequest, monogram} from '../shared/app-catalog.js';

const SERVER_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const names = view => view.sections.map(s => [s.title, s.apps.map(a => a.id)]);

/* ---------- the list itself ---------- */

test('every app has a valid server id, a known category and exactly one way to start', () => {
  const ids = new Set();
  for (const app of APPS) {
    assert.match(app.id, SERVER_NAME, app.id);
    assert.ok(!ids.has(app.id), `duplicate ${app.id}`); ids.add(app.id);
    assert.ok(CATEGORIES.includes(app.category), `${app.id}: ${app.category}`);
    assert.ok(app.name && app.blurb, app.id);
    const ways = [app.run, app.web, app.google].filter(Boolean).length;
    assert.equal(ways, 1, app.id);
    for (const input of app.run?.inputs || app.web?.inputs || []) {
      assert.ok(input.label, `${app.id} input label`);
      if (input.env) for (const key of Object.keys(input.env)) assert.match(key, ENV_NAME, `${app.id} ${key}`);
      if (input.kind === 'secret') assert.ok(input.hint && input.where, `${app.id} ${input.label} needs a hint and where`);
    }
  }
});

test('the list carries the vetted packages and addresses, and none of the ones left out', () => {
  assert.equal(appById('notion').run.command, 'npx -y @notionhq/notion-mcp-server');
  assert.equal(appById('slack').run.command, 'npx -y slack-mcp-server@latest --transport stdio');
  assert.equal(appById('github').web.url, 'https://api.githubcopilot.com/mcp/');
  assert.equal(appById('linear').web.url, 'https://mcp.linear.app/mcp');
  assert.equal(appById('todoist').run.command, 'npx -y -p @todoist/mcp todoist-mcp');
  for (const gone of ['postgres', 'sqlite', 'vercel', 'hubspot', 'asana']) assert.equal(appById(gone), null, gone);
  assert.equal(APPS.length, 24);
});

test('a monogram is the initials of a two-word name, else the first letter', () => {
  assert.equal(monogram({name: 'Notion'}), 'N');
  assert.equal(monogram({name: 'Brave Search'}), 'BS');
  assert.equal(monogram({name: 'Google · Gmail and Drive'}), 'G');
});

/* ---------- what the page shows ---------- */

test('with nothing connected, All shows Recommended first and then every category', () => {
  const view = catalogView({connectors: []});
  assert.equal(view.connectedCount, 0);
  assert.deepEqual(view.connected, []);
  assert.equal(view.sections[0].title, 'Recommended');
  assert.deepEqual(view.sections[0].apps.map(a => a.id), ['notion', 'github', 'slack', 'linear', 'filesystem', 'brave-search']);
  assert.deepEqual(view.sections.slice(1).map(s => s.title), CATEGORIES.filter(c => APPS.some(a => a.category === c)));
  assert.deepEqual(view.chips.map(c => c.label), ['All', ...CATEGORIES]);
  assert.equal(view.chips.find(c => c.selected).label, 'All');
});

test('an app is connected by its server name on this computer or by its web host', () => {
  const view = catalogView({connectors: [
    {id: 'notion', kind: 'mcp', name: 'Notion', agentServer: 'notion', host: null},
    {id: 'gh', kind: 'mcp', name: 'Code', agentServer: null, host: 'api.githubcopilot.com'},
    {id: 'other', kind: 'mcp', name: 'Other', agentServer: null, host: 'notes.example.org'},
  ]});
  assert.equal(view.connectedCount, 2);
  assert.deepEqual(view.connected.map(a => a.id), ['notion', 'github']);
  const rec = view.sections[0].apps;
  assert.equal(rec.find(a => a.id === 'notion').connected, true);
  assert.equal(rec.find(a => a.id === 'github').connected, true);
  assert.equal(rec.find(a => a.id === 'slack').connected, false);
});

test('Google counts as connected when its card says so', () => {
  assert.equal(catalogView({connectors: [], google: {configured: true, connected: true}}).connectedCount, 1);
  assert.equal(catalogView({connectors: [], google: {configured: true, connected: false}}).connectedCount, 0);
});

test('a missing or odd response is an empty, unconnected catalogue', () => {
  for (const res of [null, undefined, {}, {connectors: 'x'}]) assert.equal(catalogView(res).connectedCount, 0);
});

test('a query matches name, blurb or category, ignoring case, and drops Recommended', () => {
  assert.deepEqual(filterApps(APPS, {query: 'NOTION'}).map(a => a.id), ['notion']);
  assert.ok(filterApps(APPS, {query: 'pull requests'}).some(a => a.id === 'github'));
  assert.ok(filterApps(APPS, {query: 'design'}).every(a => a.category === 'Design' || /design/i.test(a.name + a.blurb)));
  const view = catalogView({connectors: []}, {query: 'notion'});
  assert.deepEqual(names(view), [['Productivity', ['notion']]]);
  assert.deepEqual(catalogView({connectors: []}, {query: 'zzzz'}).sections, []);
});

test('a category shows only that category, with the chip selected', () => {
  const view = catalogView({connectors: []}, {category: 'Design'});
  assert.deepEqual(names(view), [['Design', ['figma']]]);
  assert.equal(view.chips.find(c => c.selected).label, 'Design');
  // An unknown category falls back to All.
  assert.equal(catalogView({connectors: []}, {category: 'Nope'}).sections[0].title, 'Recommended');
});

test('each row carries a monogram and a tint from the ten-tint palette', () => {
  for (const app of catalogView({connectors: []}).sections.flatMap(s => s.apps)) {
    assert.ok(app.mono.length >= 1 && app.mono.length <= 2);
    assert.ok(Number.isInteger(app.tint) && app.tint >= 0 && app.tint < 10);
  }
});

/* ---------- what Connect sends ---------- */

test('an app with no inputs starts on this computer under its own id', () => {
  const memory = appById('memory');
  assert.deepEqual(connectRequest(memory, {}), {ok: true, local: {name: 'memory', command: 'npx -y @modelcontextprotocol/server-memory'}, body: {kind: 'mcp', name: 'Memory', agentServer: 'memory'}});
});

test('a token goes in as env, trimmed, and a missing one names the field', () => {
  const notion = appById('notion');
  const done = connectRequest(notion, {NOTION_TOKEN: '  ntn_abc  '});
  assert.equal(done.ok, true);
  assert.deepEqual(done.local, {name: 'notion', command: 'npx -y @notionhq/notion-mcp-server', env: {NOTION_TOKEN: 'ntn_abc'}});
  const missing = connectRequest(notion, {});
  assert.equal(missing.ok, false);
  assert.match(missing.error, new RegExp(notion.run.inputs[0].label, 'i'));
});

test('a token on two lines is refused', () => {
  const out = connectRequest(appById('notion'), {NOTION_TOKEN: 'a\nb'});
  assert.equal(out.ok, false);
});

test('Filesystem defaults to ~/Documents and quotes a folder with spaces', () => {
  const fs = appById('filesystem');
  assert.equal(connectRequest(fs, {}).local.command, 'npx -y @modelcontextprotocol/server-filesystem ~/Documents');
  assert.equal(connectRequest(fs, {folder: '~/My Notes'}).local.command, 'npx -y @modelcontextprotocol/server-filesystem "~/My Notes"');
  assert.equal(connectRequest(fs, {folder: 'notes'}).ok, false, 'a relative folder is refused');
  assert.equal(connectRequest(fs, {folder: '/tmp/a"b'}).ok, false, 'a quote cannot break the command');
});

test('Git asks for the repository folder', () => {
  const git = appById('git');
  assert.equal(connectRequest(git, {}).ok, false);
  assert.equal(connectRequest(git, {repo: '/home/me/code/app'}).local.command, 'uvx mcp-server-git --repository /home/me/code/app');
});

test('a web app sends its address and the token as a header, never a command', () => {
  const linear = appById('linear');
  assert.deepEqual(connectRequest(linear, {token: 'lin_api_1'}), {ok: true, body: {kind: 'mcp', name: 'Linear', url: 'https://mcp.linear.app/mcp', headers: {Authorization: 'Bearer lin_api_1'}}});
  assert.equal(connectRequest(linear, {}).ok, false);
});

test('Supabase adds an optional project ref to its address, and checks it', () => {
  const supabase = appById('supabase');
  assert.equal(connectRequest(supabase, {token: 'sbp_1'}).body.url, 'https://mcp.supabase.com/mcp?read_only=true');
  assert.equal(connectRequest(supabase, {token: 'sbp_1', project_ref: 'abcd1234'}).body.url, 'https://mcp.supabase.com/mcp?read_only=true&project_ref=abcd1234');
  assert.equal(connectRequest(supabase, {token: 'sbp_1', project_ref: 'a&b=c'}).ok, false);
});

test('Atlassian turns one site, email and token into the Jira and Confluence settings', () => {
  const out = connectRequest(appById('atlassian'), {site: 'https://acme.atlassian.net/', email: 'me@acme.org', token: 'tok'});
  assert.equal(out.ok, true);
  assert.deepEqual(out.local.env, {
    JIRA_URL: 'https://acme.atlassian.net', CONFLUENCE_URL: 'https://acme.atlassian.net/wiki',
    JIRA_USERNAME: 'me@acme.org', CONFLUENCE_USERNAME: 'me@acme.org',
    JIRA_API_TOKEN: 'tok', CONFLUENCE_API_TOKEN: 'tok',
  });
  assert.equal(connectRequest(appById('atlassian'), {site: 'acme', email: 'me@acme.org', token: 'tok'}).ok, false);
});

test('Google is not connected through a request', () => {
  assert.equal(connectRequest(appById('google'), {}).ok, false);
  assert.equal(connectRequest(null, {}).ok, false);
});
