/** The Connect apps catalogue: apps a bot can use through MCP, and how each one starts, so the owner picks an app
 * and fills in a token instead of typing a command. Pure data and functions (no DOM, no globals): Node tests import
 * it (tests/app-catalog.test.js) and Settings → Connectors (ui-connect.js) draws it.
 *
 * An app either runs on this computer (`run`: a command started without a shell, its tokens passed as env and kept
 * in the local agent's 0600 config) or is a web server (`web`: an address, and a token sent as one header). The
 * packages and addresses were checked against each vendor's own docs (2026-11-11). An app with an `oauth` address
 * signs in to its official MCP server in one tap instead; Gmail, Drive and Calendar are Google's own MCP servers.
 * Every app is a real MCP server: nothing here is "connected" by signing in to a website. */

export const CATEGORIES = ['Productivity', 'Communication', 'Design', 'Code', 'Data', 'Files', 'Web', 'Business'];

const token = (label, hint, where, extra = {}) => ({key: 'token', label, kind: 'secret', hint, where, ...extra});
const envToken = (env, label, hint, where) => ({key: env, label, kind: 'secret', hint, where, env: {[env]: '%s'}});
const bearer = (url, input) => ({url, header: 'Authorization', prefix: 'Bearer ', inputs: [input]});

/** Every app, recommended ones first in the order they are recommended. */
export const APPS = [
  {id: 'notion', name: 'Notion', category: 'Productivity', recommended: true, blurb: 'Search, read and edit pages and databases',
    run: {command: 'npx -y @notionhq/notion-mcp-server', inputs: [envToken('NOTION_TOKEN', 'Integration token', 'Create an internal integration, copy its token (ntn_…), then share your pages with it.', 'notion.so/profile/integrations')]}},
  {id: 'github', name: 'GitHub', category: 'Code', recommended: true, blurb: 'Read repos, manage issues and pull requests',
    web: bearer('https://api.githubcopilot.com/mcp/', token('Personal access token', 'Create a fine-grained token with access to the repos bots may use.', 'github.com/settings/personal-access-tokens/new'))},
  {id: 'slack', name: 'Slack', category: 'Communication', recommended: true, blurb: 'Read channels and threads, search messages',
    run: {command: 'npx -y slack-mcp-server@latest --transport stdio', inputs: [envToken('SLACK_MCP_XOXP_TOKEN', 'User token', 'Create a Slack app, install it to your workspace and copy its user token (xoxp-…).', 'api.slack.com/apps')]}},
  {id: 'gmail', name: 'Gmail', category: 'Communication', recommended: true, blurb: 'Search and read mail, draft replies, label and tidy'},
  {id: 'linear', name: 'Linear', category: 'Productivity', recommended: true, blurb: 'Read and update issues, projects and docs',
    web: bearer('https://mcp.linear.app/mcp', token('API key', 'In Linear, open Settings › Security & access › API keys and create one.', 'linear.app/settings/account/security'))},
  {id: 'filesystem', name: 'Filesystem', category: 'Files', recommended: true, blurb: 'Read, write and search files in folders you choose',
    run: {command: 'npx -y @modelcontextprotocol/server-filesystem {folder}', inputs: [{key: 'folder', label: 'Folder', kind: 'folder', default: '~/Documents', hint: 'Bots can only reach this folder and what is inside it.'}]}},
  {id: 'brave-search', name: 'Brave Search', category: 'Web', recommended: true, blurb: 'Search the web, news and places',
    run: {command: 'npx -y @brave/brave-search-mcp-server --transport stdio', inputs: [envToken('BRAVE_API_KEY', 'API key', 'Sign up for the Brave Search API (there is a free plan) and copy a key.', 'api-dashboard.search.brave.com')]}},

  {id: 'atlassian', name: 'Atlassian', category: 'Productivity', blurb: 'Search and edit Jira issues and Confluence pages',
    run: {command: 'uvx mcp-atlassian', inputs: [
      {key: 'site', label: 'Site address', kind: 'url', placeholder: 'https://your-site.atlassian.net', hint: 'The address you open Jira at.', env: {JIRA_URL: '%s', CONFLUENCE_URL: '%s/wiki'}},
      {key: 'email', label: 'Email', kind: 'email', placeholder: 'you@example.org', hint: 'The email you sign in to Atlassian with.', env: {JIRA_USERNAME: '%s', CONFLUENCE_USERNAME: '%s'}},
      {key: 'token', label: 'API token', kind: 'secret', hint: 'Create an API token. The same token works for Jira and Confluence.', where: 'id.atlassian.com/manage-profile/security/api-tokens', env: {JIRA_API_TOKEN: '%s', CONFLUENCE_API_TOKEN: '%s'}},
    ]}},
  {id: 'time', name: 'Time', category: 'Productivity', blurb: 'Current time and time zones', run: {command: 'uvx mcp-server-time', inputs: []}},
  {id: 'sequential-thinking', name: 'Sequential Thinking', category: 'Productivity', blurb: 'Work through hard problems step by step', run: {command: 'npx -y @modelcontextprotocol/server-sequential-thinking', inputs: []}},
  {id: 'obsidian', name: 'Obsidian', category: 'Productivity', blurb: 'Search and edit notes in your vault',
    run: {command: 'uvx mcp-obsidian', inputs: [envToken('OBSIDIAN_API_KEY', 'API key', 'Install the Local REST API plugin in Obsidian and copy the key from its settings.', 'Obsidian › Settings › Community plugins › Local REST API')]}},
  {id: 'todoist', name: 'Todoist', category: 'Productivity', blurb: 'Add, find and complete tasks',
    run: {command: 'npx -y -p @todoist/mcp todoist-mcp', inputs: [envToken('TODOIST_API_KEY', 'API token', 'Copy your API token from the Developer tab.', 'Todoist › Settings › Integrations › Developer')]}},

  {id: 'google-drive', name: 'Google Drive', category: 'Files', blurb: 'Find, read and create files'},
  {id: 'google-calendar', name: 'Google Calendar', category: 'Productivity', blurb: 'See your events, find a time, add and answer invites'},

  {id: 'figma', name: 'Figma', category: 'Design', blurb: 'Read design files, frames and components',
    run: {command: 'npx -y figma-developer-mcp --stdio', inputs: [envToken('FIGMA_API_KEY', 'Personal access token', 'Create a personal access token under Security.', 'Figma › Settings › Security')]}},

  {id: 'sentry', name: 'Sentry', category: 'Code', blurb: 'Look up errors, issues, traces and releases',
    run: {command: 'npx -y @sentry/mcp-server@latest', inputs: [envToken('SENTRY_AUTH_TOKEN', 'Auth token', 'Create a personal token.', 'Sentry › Settings › Personal Tokens')]}},
  {id: 'cloudflare', name: 'Cloudflare', category: 'Code', blurb: 'Manage Workers, DNS and account settings',
    web: bearer('https://mcp.cloudflare.com/mcp', token('API token', 'Create an API token with the permissions bots may use.', 'dash.cloudflare.com/profile/api-tokens'))},
  {id: 'git', name: 'Git', category: 'Code', blurb: 'Read history and diffs, branch and commit in a repo',
    run: {command: 'uvx mcp-server-git --repository {repo}', inputs: [{key: 'repo', label: 'Repository folder', kind: 'folder', placeholder: '~/code/my-project', hint: 'The folder that holds the repo (the one with .git in it).'}]}},
  {id: 'context7', name: 'Context7', category: 'Code', blurb: 'Current library docs and code samples', run: {command: 'npx -y @upstash/context7-mcp', inputs: []}},

  {id: 'supabase', name: 'Supabase', category: 'Data', blurb: 'Query tables, run SQL, manage projects',
    web: {url: 'https://mcp.supabase.com/mcp?read_only=true', header: 'Authorization', prefix: 'Bearer ', inputs: [
      token('Access token', 'Create a personal access token. Bots get read-only access.', 'supabase.com/dashboard/account/tokens'),
      {key: 'project_ref', label: 'Project ref (optional)', kind: 'query', optional: true, placeholder: 'abcdefghijklmnop', hint: 'Limit bots to one project. It is in the project\'s address.'},
    ]}},
  {id: 'memory', name: 'Memory', category: 'Data', blurb: 'Keep a lasting notebook of facts', run: {command: 'npx -y @modelcontextprotocol/server-memory', inputs: []}},
  {id: 'airtable', name: 'Airtable', category: 'Data', blurb: 'Read and update records in your bases',
    run: {command: 'npx -y airtable-mcp-server', inputs: [envToken('AIRTABLE_API_KEY', 'Personal access token', 'Create a token with access to the bases bots may use.', 'airtable.com/create/tokens')]}},

  {id: 'fetch', name: 'Fetch', category: 'Web', blurb: 'Fetch web pages as clean text', run: {command: 'uvx mcp-server-fetch', inputs: []}},
  {id: 'playwright', name: 'Playwright', category: 'Web', blurb: 'Drive a browser: open pages, click, fill forms', run: {command: 'npx @playwright/mcp@latest', inputs: []}},

  {id: 'stripe', name: 'Stripe', category: 'Business', blurb: 'Look up customers, payments and invoices',
    web: bearer('https://mcp.stripe.com', token('Agent API key', 'Create a key with the Agent badge. Plain secret keys are refused.', 'Stripe Dashboard › Developers › API keys'))},
  {id: 'zapier', name: 'Zapier', category: 'Business', blurb: 'Run actions across thousands of apps',
    web: bearer('https://mcp.zapier.com/api/v1/connect', token('Connection token', 'Create a server and copy its connection token.', 'mcp.zapier.com'))},
];

// The app's official MCP server, signed in to in one tap (checked against each server's own sign-in metadata,
// November 2026); the bots use its tools as the owner. Most let an app register itself. Google, Slack and GitHub do
// not, so they sign in with the client the person running this server made once with them (CLIENTS, read from .env
// by src/mcp-oauth.js); until it is there, GitHub and Slack take a token and Google waits for it. Figma, Asana and
// HubSpot allow neither yet, so they keep a token.
const OAUTH = {
  gmail: 'https://gmailmcp.googleapis.com/mcp/v1', 'google-drive': 'https://drivemcp.googleapis.com/mcp/v1', 'google-calendar': 'https://calendarmcp.googleapis.com/mcp/v1',
  github: 'https://api.githubcopilot.com/mcp/', slack: 'https://mcp.slack.com/mcp',
  notion: 'https://mcp.notion.com/mcp', linear: 'https://mcp.linear.app/mcp', atlassian: 'https://mcp.atlassian.com/v1/mcp',
  sentry: 'https://mcp.sentry.dev/mcp', cloudflare: 'https://mcp.cloudflare.com/mcp',
  supabase: 'https://mcp.supabase.com/mcp', stripe: 'https://mcp.stripe.com', zapier: 'https://mcp.zapier.com/api/v1/connect',
  todoist: 'https://ai.todoist.net/mcp', airtable: 'https://mcp.airtable.com/mcp',
};
for (const app of APPS) if (OAUTH[app.id]) app.oauth = OAUTH[app.id];
const G = 'https://www.googleapis.com/auth/';
// The client each one signs in with, and what it asks for (each server lists more than a bot needs; Google's are its
// MCP servers' own scopes).
const CLIENTS = {
  gmail: ['google', [`${G}gmail.modify`]], 'google-drive': ['google', [`${G}drive`]], 'google-calendar': ['google', [`${G}calendar`]],
  github: ['github', ['repo', 'read:org', 'read:user']], slack: ['slack'],
};
for (const app of APPS) if (CLIENTS[app.id]) Object.assign(app, {client: CLIENTS[app.id][0]}, CLIENTS[app.id][1] ? {scopes: CLIENTS[app.id][1]} : {});

// The sites that are the app's own: a page there is the app, so a bot with the app connected uses its tools instead.
const DOMAINS = {
  notion: ['notion.so', 'notion.com'], github: ['github.com'], slack: ['slack.com'], linear: ['linear.app'], atlassian: ['atlassian.net', 'atlassian.com'],
  todoist: ['todoist.com'], figma: ['figma.com'], sentry: ['sentry.io'], cloudflare: ['dash.cloudflare.com'], supabase: ['supabase.com'],
  airtable: ['airtable.com'], stripe: ['dashboard.stripe.com'], zapier: ['zapier.com'], gmail: ['mail.google.com'], 'google-drive': ['drive.google.com', 'docs.google.com'], 'google-calendar': ['calendar.google.com'],
};
/** The app a web host belongs to, or null. A subdomain counts (acme.atlassian.net); a look-alike does not. */
export function appForHost(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  for (const [id, domains] of Object.entries(DOMAINS)) if (domains.some(d => h === d || h.endsWith(`.${d}`))) return APPS.find(a => a.id === id) || null;
  return null;
}

const BY_ID = new Map(APPS.map(a => [a.id, a]));
/** The app with this id, or null. */
export const appById = id => BY_ID.get(id) || null;

/** The inputs the owner fills in for an app (none for one that only signs in). */
export const appInputs = app => app?.run?.inputs || app?.web?.inputs || [];

/** What one tap on Connect does: `oauth` (the app's own sign-in), `now` (nothing to fill in, or only defaults),
 * `form` (its token or folder) or `setup` (an app that signs in only with the server's own client, which `clients`
 * from `GET /api/connectors` says is not there yet). */
export function connectHow(app, {clients = {}} = {}) {
  if (!app) return 'form';
  if (app.oauth && (!app.client || clients?.[app.client] === true)) return 'oauth';
  if (!app.run && !app.web) return 'setup';
  return appInputs(app).every(i => i.optional || i.default) ? 'now' : 'form';
}

/** What a tap on an app that waits for the server's sign-in client says: who adds what, once. No value is in it. */
export function clientSetupLine(app) {
  const env = String(app?.client || '').toUpperCase();
  return `${app?.name || 'That app'} signs in with this server's own ${app?.client === 'google' ? 'Google' : app?.name || ''} client, which is not set up yet. Whoever runs the server adds ${env}_CLIENT_ID and ${env}_CLIENT_SECRET to .env once (docs/DEPLOYMENT.md) and restarts it; then Connect is one tap.`;
}

/** Initials of a two-word name, else its first letter. Text after a `·` is a description, not the name. */
export function monogram(app) {
  const words = String(app?.name ?? '').split('·')[0].trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0][0]).toUpperCase();
}

// A steady tint per app from the ten-tint palette (`.t0`…`.t9`), by its place in the list. The order walks the most
// distinct hues first (t2/t8 and t0/t6 are near twins), so neighbouring tiles differ.
const HUES = [0, 1, 2, 5, 4, 3, 7, 9, 6, 8];
const tintOf = id => HUES[Math.max(0, APPS.findIndex(a => a.id === id)) % HUES.length];

const hostOf = url => { try { return new URL(url).host.toLowerCase(); } catch { return ''; } };

/** Whether an app is already among the connectors: by its server name on this computer, or by its web host. */
function isConnected(app, connectors) {
  if (connectors.some(c => c?.kind === 'mcp' && c.app === app.id)) return true;
  const host = app.web ? hostOf(app.web.url) : '';
  return connectors.some(c => c?.kind === 'mcp' && ((app.run && c.agentServer === app.id) || (host && String(c.host || '').toLowerCase() === host)));
}

/** The apps a query and a category keep. The query matches name, blurb or category, ignoring case. */
export function filterApps(apps, {query = '', category = 'All'} = {}) {
  const q = String(query ?? '').trim().toLowerCase();
  return apps.filter(a => (category === 'All' || a.category === category)
    && (!q || `${a.name} ${a.blurb} ${a.category}`.toLowerCase().includes(q)));
}

/** What the catalogue shows for `GET /api/connectors` and the current filters: the connected summary, the chips, and
 * the sections (Recommended, then one per category; only matching categories when filtered). */
export function catalogView(res, {query = '', category = 'All'} = {}) {
  const connectors = Array.isArray(res?.connectors) ? res.connectors : [];
  const chosen = CATEGORIES.includes(category) ? category : 'All';
  const rows = APPS.map(a => ({...a, mono: monogram(a), tint: tintOf(a.id), connected: isConnected(a, connectors), inputs: appInputs(a)}));
  const connected = rows.filter(a => a.connected);
  const filtering = Boolean(String(query ?? '').trim()) || chosen !== 'All';
  const kept = filterApps(rows, {query, category: chosen});
  const sections = [];
  if (!filtering) sections.push({id: 'recommended', title: 'Recommended', apps: rows.filter(a => a.recommended)});
  for (const cat of CATEGORIES) {
    const apps = kept.filter(a => a.category === cat);
    if (apps.length) sections.push({id: cat.toLowerCase(), title: cat, apps});
  }
  return {
    connected, connectedCount: connected.length, sections,
    chips: ['All', ...CATEGORIES].map(label => ({label, selected: label === chosen})),
  };
}

/* ---------- what Connect sends ---------- */

const fail = error => ({ok: false, error});

/** One input's value, checked, or `{error}`. */
function readInput(input, raw) {
  const value = String(raw ?? '').trim() || String(input.default ?? '');
  if (!value) return input.optional ? {value: ''} : {error: `Fill in ${input.label}.`};
  if (/[\r\n]/.test(value)) return {error: `Give ${input.label} on one line.`};
  if (value.length > 4000) return {error: `${input.label} is too long.`};
  switch (input.kind) {
    case 'secret': return /\s/.test(value) ? {error: `${input.label} has a space in it. Paste it again.`} : {value};
    case 'url': return /^https:\/\/[^\s/"']+/i.test(value) ? {value: value.replace(/\/+$/, '')} : {error: `${input.label} must start with https://.`};
    case 'email': return /^[^\s@]+@[^\s@]+$/.test(value) ? {value} : {error: `${input.label} does not look like an email.`};
    case 'query': return /^[a-z0-9]{1,40}$/.test(value) ? {value} : {error: `${input.label} uses lowercase letters and digits only.`};
    case 'folder':
      if (!/^(\/|~$|~\/)/.test(value)) return {error: `${input.label} must be a full path, like ~/Documents.`};
      if (/["']/.test(value)) return {error: `${input.label} cannot have quotes in it.`};
      return {value: /\s/.test(value) ? `"${value}"` : value};
    default: return {value};
  }
}

/** What Connect sends for an app and the values typed in its sheet:
 * on this computer `{ok, local: {name, command, env?}, body}` (POST /api/agents/local/mcp, then POST /api/connectors);
 * on the web `{ok, body: {kind: 'mcp', name, url, headers}}`; or `{ok: false, error}` naming the field to fix. */
export function connectRequest(app, values = {}) {
  if (!app || !(app.run || app.web)) return fail(`${app?.name || 'That app'} connects with its own sign-in, not a token.`);
  const read = {};
  for (const input of appInputs(app)) {
    const got = readInput(input, values?.[input.key]);
    if (got.error) return fail(got.error);
    read[input.key] = got.value;
  }
  if (app.web) {
    const {url, header, prefix = '', inputs} = app.web;
    let address = url;
    for (const input of inputs) if (input.kind === 'query' && read[input.key]) address += `${address.includes('?') ? '&' : '?'}${input.key}=${read[input.key]}`;
    const secret = inputs.find(i => i.kind === 'secret');
    const headers = secret && read[secret.key] ? {[header]: prefix + read[secret.key]} : null;
    return {ok: true, body: {kind: 'mcp', name: app.name, url: address, ...(headers ? {headers} : {})}};
  }
  const command = app.run.command.replace(/\{(\w+)\}/g, (_, key) => read[key] ?? '');
  const env = {};
  for (const input of app.run.inputs) {
    if (!input.env || !read[input.key]) continue;
    for (const [name, template] of Object.entries(input.env)) env[name] = template.split('%s').join(read[input.key]);
  }
  const local = {name: app.id, command, ...(Object.keys(env).length ? {env} : {})};
  return {ok: true, local, body: {kind: 'mcp', name: app.name, agentServer: app.id}};
}
