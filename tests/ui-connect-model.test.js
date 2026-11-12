import test from 'node:test';
import assert from 'node:assert/strict';
import {
  googleReturn, withoutGoogleParams, statusOf, mcpRows, mcpDraft, cliDraft, agentCliRows, subscriptionLine, SIGN_IN_HINT,
  connectorLine, modelLimitLine, agentPermissionRows, agentWorkLine,
} from '../shared/ui-connect-model.js';

/* ---------- the redirect back from Google ---------- */

test('?google=connected is a success and anything else on the query is ignored', () => {
  assert.deepEqual(googleReturn('?google=connected'), {ok: true, text: 'Google is connected.'});
  assert.equal(googleReturn(''), null);
  assert.equal(googleReturn('?tab=1'), null);
  assert.equal(googleReturn('?google=whatever'), null);
});

test('?google=error says what the reason code means, never a code the person must decode', () => {
  const denied = googleReturn('?google=error&reason=denied');
  assert.equal(denied.ok, false);
  assert.match(denied.text, /cancel/i);
  const texts = new Set([denied.text]);
  for (const reason of ['state', 'code', 'no-refresh-token', 'setup', 'google']) {
    const out = googleReturn(`?google=error&reason=${reason}`);
    assert.equal(out.ok, false);
    assert.doesNotMatch(out.text, /no-refresh-token|reason=/);
    texts.add(out.text);
  }
  assert.equal(texts.size, 6, 'each reason has its own sentence');
  // An unknown reason still reads as a failure, and the raw text is not echoed.
  const odd = googleReturn('?google=error&reason=%3Cb%3Ex');
  assert.equal(odd.ok, false);
  assert.doesNotMatch(odd.text, /<b>/);
});

test('the Google parameters are removed from the address and the others are kept', () => {
  assert.equal(withoutGoogleParams('?google=connected'), '');
  assert.equal(withoutGoogleParams('?google=error&reason=denied'), '');
  assert.equal(withoutGoogleParams('?a=1&google=connected&b=2'), '?a=1&b=2');
  assert.equal(withoutGoogleParams('?a=1'), '?a=1');
  assert.equal(withoutGoogleParams(''), '');
});

/* ---------- MCP rows ---------- */

const mcp = (extra = {}) => ({id: 'notes', kind: 'mcp', name: 'Notes', account: 'notes.example.org', status: 'ready', statusMessage: '', transport: 'http', host: 'notes.example.org', agentServer: null,
  actions: [{name: 'search', write: false, description: 'Find notes'}, {name: 'add', write: true, description: 'Add one'}, {name: 'wipe', write: true, description: ''}], ...extra});

test('an MCP server row says where it runs and what its tools can do', () => {
  const [row] = mcpRows([mcp()]);
  assert.equal(row.id, 'notes');
  assert.equal(row.where, 'notes.example.org');
  assert.equal(row.detail, '3 tools, 2 can change things');
  assert.deepEqual(row.status, {label: 'Ready', tone: 'good'});
  assert.equal(row.message, '');
});

test('a stdio server runs on the agent, one tool reads singular, and a server with no tools says so', () => {
  const [a] = mcpRows([mcp({transport: 'stdio', host: null, agentServer: 'files', actions: [{name: 'ls', write: false}]})]);
  assert.equal(a.where, 'On your agent · files');
  assert.equal(a.detail, '1 tool, none change anything');
  const [b] = mcpRows([mcp({actions: []})]);
  assert.equal(b.detail, 'No tools yet');
});

test('a server in trouble carries its own words, and Google is not an MCP row', () => {
  const rows = mcpRows([{id: 'google', kind: 'google', name: 'Google', status: 'ready', actions: []}, mcp({status: 'error', statusMessage: 'It did not answer.'})]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].status, {label: 'Problem', tone: 'bad'});
  assert.equal(rows[0].message, 'It did not answer.');
  assert.deepEqual(statusOf('reconnect'), {label: 'Reconnect', tone: 'warn'});
  assert.deepEqual(statusOf('setup'), {label: 'Not signed in', tone: 'warn'});
  assert.deepEqual(statusOf('nonsense'), {label: 'Ready', tone: 'good'});
});

test('mcpRows tolerates a missing list', () => {
  assert.deepEqual(mcpRows(undefined), []);
});

/* ---------- the add forms ---------- */

test('an HTTP MCP server needs a name and an http(s) address and may carry headers', () => {
  const ok = mcpDraft({name: ' Notes ', via: 'http', url: 'https://notes.example.org/mcp', headers: 'Authorization: Bearer abc\nX-Team: red'});
  assert.deepEqual(ok, {ok: true, body: {kind: 'mcp', name: 'Notes', url: 'https://notes.example.org/mcp', headers: {Authorization: 'Bearer abc', 'X-Team': 'red'}}});
  assert.equal(mcpDraft({name: '', via: 'http', url: 'https://x.example'}).ok, false);
  assert.match(mcpDraft({name: 'n', via: 'http', url: 'ftp://x'}).error, /http/);
  assert.match(mcpDraft({name: 'n', via: 'http', url: ''}).error, /address/i);
  assert.match(mcpDraft({name: 'n', via: 'http', url: 'https://x.example', headers: 'no colon here'}).error, /header/i);
});

test('a stdio server is a name on the agent, with no address and no headers', () => {
  assert.deepEqual(mcpDraft({name: 'Files', via: 'agent', agentServer: 'files', url: 'https://ignored.example', headers: 'X: y'}), {ok: true, body: {kind: 'mcp', name: 'Files', agentServer: 'files'}});
  assert.match(mcpDraft({name: 'Files', via: 'agent', agentServer: 'two words'}).error, /letters/i);
  assert.match(mcpDraft({name: 'Files', via: 'agent', agentServer: ''}).error, /name/i);
});

test('a subscription is a name, an engine and an optional model, and there is no key field', () => {
  assert.deepEqual(cliDraft({label: 'My Claude', engine: 'claude', model: ''}), {ok: true, body: {kind: 'local-cli', label: 'My Claude', engine: 'claude', model: ''}});
  assert.deepEqual(cliDraft({label: '', engine: 'codex', model: ' gpt-5 '}).body, {kind: 'local-cli', label: 'My ChatGPT', engine: 'codex', model: 'gpt-5'});
  assert.match(cliDraft({label: 'x', engine: 'gemini'}).error, /engine/i);
  assert.match(cliDraft({label: 'x', engine: 'claude', model: '--bad'}).error, /model/i);
  const body = cliDraft({label: 'x', engine: 'claude', model: '', apiKey: 'sk-secret'}).body;
  assert.equal('apiKey' in body, false);
  assert.doesNotMatch(JSON.stringify(body), /sk-secret/);
});

/* ---------- sign-in status of each paired agent ---------- */

const agent = (extra = {}) => ({id: 'a1', name: 'Laptop', status: 'online', cli: {claude: 'signed-in', codex: 'signed-out', checkedAt: '2026-11-11T10:00:00Z'}, ...extra});

test('each paired agent lists claude and codex as signed in, signed out or missing', () => {
  const [row] = agentCliRows([agent({cli: {claude: 'signed-in', codex: 'missing'}})]);
  assert.equal(row.name, 'Laptop');
  assert.deepEqual(row.engines.map(e => [e.id, e.status, e.word, e.tone]), [['claude', 'signed-in', 'Signed in', 'good'], ['codex', 'missing', 'Not installed', 'bad']]);
  assert.equal(SIGN_IN_HINT, 'Run `claude` (or `codex`) in a terminal on that machine to sign in.');
});

test('signed out earns the hint, an unreported or null cli reads as not reported, a revoked agent is left out', () => {
  const rows = agentCliRows([agent({cli: {claude: 'signed-out', codex: 'signed-in'}}), agent({id: 'a2', name: 'Server', cli: null}), agent({id: 'a3', status: 'revoked', cli: null})]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].hint, SIGN_IN_HINT);
  assert.equal(rows[1].hint, '');
  assert.deepEqual(rows[1].engines.map(e => e.status), ['unknown', 'unknown']);
  assert.equal(rows[1].engines[0].word, 'Not reported yet');
  assert.equal(rows[0].engines[1].tone, 'good');
});

test('an offline agent still shows what it last said, marked as not running now', () => {
  const [row] = agentCliRows([agent({status: 'stale'})]);
  assert.equal(row.online, false);
  assert.equal(agentCliRows([agent()])[0].online, true);
});

test('no agents at all says to pair one', () => {
  assert.deepEqual(agentCliRows([]), []);
  assert.deepEqual(agentCliRows(undefined), []);
});

test('a subscription row says its engine, its model and where it is signed in', () => {
  const provider = {id: 'p1', kind: 'local-cli', label: 'My Claude', engine: 'claude', model: ''};
  assert.equal(subscriptionLine(provider, [agent()]), 'Claude subscription · default model · signed in on Laptop');
  assert.equal(subscriptionLine({...provider, engine: 'codex', model: 'gpt-5'}, [agent()]), 'ChatGPT subscription · gpt-5 · signed out on Laptop');
  assert.equal(subscriptionLine(provider, []), 'Claude subscription · default model · no paired agent yet');
  assert.match(subscriptionLine(provider, [agent({cli: null})]), /not reported yet/);
  assert.match(subscriptionLine(provider, [agent({cli: {claude: 'missing', codex: 'missing'}})]), /not installed on Laptop/);
  // One signed-in machine is enough, even when another is signed out.
  assert.match(subscriptionLine(provider, [agent({id: 'b', name: 'Old', cli: {claude: 'signed-out'}}), agent()]), /signed in on Laptop/);
});

/* ---------- chat lines ---------- */

const state = (extra = {}) => ({
  connectors: [{id: 'google', kind: 'google', name: 'Google', account: 'me@example.org'}, {id: 'notes', kind: 'mcp', name: 'Notes', account: 'notes.example.org'}],
  ai: {providers: [{id: 'p1', label: 'My Claude'}, {id: 'p2', label: 'OpenAI'}], bots: {}}, ...extra});
const NOW = Date.parse('2026-11-11T10:00:10Z');

test('a connector line says what happened and on which account', () => {
  const line = connectorLine({kind: 'connector', connectorId: 'google', text: 'Atlas used Google: gmail.search.'}, {state: state(), items: [], now: NOW});
  assert.deepEqual(line, {tone: 'ok', text: 'Atlas used Google: gmail.search.', account: 'me@example.org', undo: null});
});

test('a connector-error line is an error and a missing connector has no account', () => {
  const line = connectorLine({kind: 'connector-error', connectorId: 'gone', text: 'Atlas could not use Gone: x.'}, {state: state(), items: [], now: NOW});
  assert.equal(line.tone, 'error');
  assert.equal(line.account, '');
  assert.equal(connectorLine({kind: 'connector', text: 't'}, {state: state(), items: [], now: NOW}).account, '');
});

const held = (extra = {}) => ({id: 'connector-c1', kind: 'connector', connectorId: 'google', text: 'Atlas is sending an email to bob@example.org.', activityId: 'act-1', undoUntil: '2026-11-11T10:00:30Z', ...extra});

test('a held send is open for Undo until its window ends', () => {
  const open = connectorLine(held(), {state: state(), items: [], now: NOW});
  assert.deepEqual(open.undo, {activityId: 'act-1', until: Date.parse('2026-11-11T10:00:30Z'), open: true});
  const over = connectorLine(held(), {state: state(), items: [], now: Date.parse('2026-11-11T10:00:30Z')});
  assert.equal(over.undo.open, false);
  assert.equal(connectorLine(held({undoUntil: 'garbage'}), {state: state(), items: [], now: NOW}).undo.open, false);
});

test('once the owner undid it (or it went out) the line is settled, even inside the window', () => {
  const later = [{kind: 'message', message: {id: 'send-act-1', kind: 'connector', text: 'You undid it.'}}];
  assert.equal(connectorLine(held(), {state: state(), items: later, now: NOW}).undo.open, false);
  assert.equal(connectorLine(held(), {state: state(), items: [{kind: 'message', message: {id: 'send-other', kind: 'connector'}}], now: NOW}).undo.open, true);
});

const limit = (extra = {}) => ({id: 'r1-model-limit', kind: 'model-limit', text: 'Atlas could not answer: My Claude has reached its usage limit.', runId: 'r1', botId: 'atlas', switchTo: 'p2', ...extra});

test('a model-limit line offers Switch to the provider the server named', () => {
  assert.deepEqual(modelLimitLine(limit(), {state: state()}), {text: limit().text, botId: 'atlas', switchTo: {id: 'p2', label: 'OpenAI'}, open: true});
});

test('the Switch button goes away once the bot already uses that provider, or when there is nothing to switch to', () => {
  const done = state({ai: {providers: [{id: 'p2', label: 'OpenAI'}], bots: {atlas: {providerId: 'p2', model: null}}}});
  assert.equal(modelLimitLine(limit(), {state: done}).open, false);
  assert.equal(modelLimitLine(limit({switchTo: undefined}), {state: state()}).switchTo, null);
  assert.equal(modelLimitLine(limit({switchTo: undefined}), {state: state()}).open, false);
  assert.equal(modelLimitLine(limit({switchTo: 'gone'}), {state: state()}).open, false);
  assert.equal(modelLimitLine(limit({botId: undefined}), {state: state()}).open, false);
});

test('a settled held send drops the promise that it can still be undone', () => {
  const over = connectorLine(held({text: 'Atlas is sending an email to bob@example.org. You can undo it until it goes out.'}), {state: state(), items: [], now: Date.parse('2026-11-11T10:01:00Z')});
  assert.equal(over.text, 'Atlas is sending an email to bob@example.org.');
  const open = connectorLine(held({text: 'Atlas is sending an email to bob@example.org. You can undo it until it goes out.'}), {state: state(), items: [], now: NOW});
  assert.match(open.text, /You can undo it/);
});

test('a subscription is judged by the agents that are running: an offline machine does not make it look signed in', () => {
  const provider = {id: 'p1', kind: 'local-cli', label: 'My ChatGPT', engine: 'codex', model: ''};
  const online = agent({cli: {claude: 'signed-in', codex: 'signed-out'}}), asleep = agent({id: 'b', name: 'Old', status: 'stale', cli: {codex: 'signed-in'}});
  assert.match(subscriptionLine(provider, [asleep, online]), /signed out on Laptop/);
  // With none running, what the sleeping one last said is all there is.
  assert.match(subscriptionLine(provider, [asleep]), /signed in on Old/);
});

/* ---------- a paired computer on the Local agents page ---------- */

test('each action the server offers is a switch with a plain name, on only when granted', () => {
  const rows = agentPermissionRows(['http.check', 'model.run', 'odd.kind'], ['model.run']);
  assert.deepEqual(rows.map(r => [r.id, r.on]), [['http.check', false], ['model.run', true], ['odd.kind', false]]);
  assert.equal(rows[1].label, 'Run your Claude or ChatGPT plan');
  // An action this page has no words for still shows, under its own id, rather than vanishing.
  assert.equal(rows[2].label, 'odd.kind');
  assert.deepEqual(agentPermissionRows(undefined, undefined), []);
  assert.equal(agentPermissionRows(['model.run'], null)[0].on, false);
});

test('a computer says Idle, or what is waiting', () => {
  assert.equal(agentWorkLine({queued: 0, running: 0, failed: 0}), 'Idle');
  assert.equal(agentWorkLine(undefined), 'Idle');
  assert.equal(agentWorkLine({queued: 2, running: 0, failed: 1}), '2 queued · 1 failed');
  assert.equal(agentWorkLine({queued: -3, running: 'x', failed: 0}), 'Idle');
});

test('a command for this computer starts the server there first, under a name made from the connector\'s', async () => {
  const {mcpDraft} = await import('../shared/ui-connect-model.js');
  const made = mcpDraft({name: 'My Notes', via: 'agent', command: 'npx -y notes-mcp ~/notes'});
  assert.deepEqual(made, {ok: true, body: {kind: 'mcp', name: 'My Notes', agentServer: 'my-notes'}, local: {name: 'my-notes', command: 'npx -y notes-mcp ~/notes'}});
  // A named server the agent already runs needs no command; a name given with a command is used as is.
  assert.equal(mcpDraft({name: 'Files', via: 'agent', agentServer: 'files'}).local, undefined);
  assert.equal(mcpDraft({name: 'Files', via: 'agent', agentServer: 'fs', command: 'fs-mcp'}).local.name, 'fs');
  assert.match(mcpDraft({name: 'Files', via: 'agent', agentServer: 'Big_Name', command: 'x'}).error, /lowercase/);
});

test('cliChoice picks a signed-in engine on an online device, reusing a provider already added', async () => {
  const {cliChoice} = await import('../shared/ui-connect-model.js');
  const on = cli => [{id: 'a', status: 'online', cli}];
  assert.deepEqual(cliChoice(on({claude: 'signed-in', codex: 'signed-in'}), []), {engine: 'claude', label: 'My Claude', providerId: null});
  assert.deepEqual(cliChoice(on({claude: 'signed-out', codex: 'signed-in'}), []), {engine: 'codex', label: 'My ChatGPT', providerId: null});
  assert.deepEqual(cliChoice(on({claude: 'signed-in'}), [{id: 'p9', kind: 'local-cli', engine: 'claude'}]), {engine: 'claude', label: 'My Claude', providerId: 'p9'});
  assert.match(cliChoice(on({claude: 'signed-out'}), []).error, /claude/);
  assert.match(cliChoice([{id: 'a', status: 'offline', cli: {claude: 'signed-in'}}], []).error, /not online/);
  assert.match(cliChoice([], []).error, /No computer/);
});
