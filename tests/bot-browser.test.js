import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as agent from '../src/agent.js';
import {SqliteStore} from '../src/sqlite-store.js';
import * as wf from '../shared/workflow.js';
import {createRun, createEnvelope} from '../shared/coordination.js';
import {coordinationState, runGroup, resumeBrowserRun} from '../src/coordination.js';
import {answerAskFlow} from '../src/ask-runs.js';
import {dispatchBrowserRequest, onAgentTaskResult, autoDispatch, continueBrowserWork, setBrowserResultHooks, beginTakeover, handBackTakeover} from '../src/bot-browser.js';
import {refusePostingAction} from '../agent/browser.mjs';
import {parseBrowserRequests, validateBrowserRequest, recordBrowserRequests, stripBrowserBlocks, denyBrowserRequest, browserResultText, capturePageText, requestOfMessage, pruneBrowserRequests, MAX_BROWSER_REQUESTS, MAX_BROWSER_DEPTH, MAX_ELEMENT_INDEX, BROWSER_PERMISSION} from '../shared/bot-browser.js';
import {addChatMessages} from '../shared/chats.js';
import {validateBotSettings} from '../shared/bot-settings.js';
import {ACTIONS} from '../shared/contracts.js';

const block = body => `Let me look.\n\`\`\`browser\n${JSON.stringify(body)}\n\`\`\`\nBack soon.`;
// These tests are about how a page travels (request, device, result, resume). A bot already holding the
// permission with "run without asking" goes straight to that; a bot that has to ask the owner first is
// covered by tests/ask-runs.test.js.
const browserBot = (extra = {}) => ({id: 'web', name: 'Web', instructions: 'Look things up.', type: 'custom', permissions: [BROWSER_PERMISSION], settings: {browserApproval: 'auto'}, ...extra});
const status = code => error => error.status === code;

test('browser blocks are parsed, bounded and kept away from posting on X', () => {
  assert.ok(ACTIONS.includes(BROWSER_PERMISSION));
  assert.deepEqual(validateBrowserRequest({url: 'https://example.com/a'}), {kind: 'browser.capture', url: 'https://example.com/a', steps: []});
  const act = validateBrowserRequest({url: 'https://example.com', steps: [{op: 'type', selector: '#q', text: 'hi'}, {op: 'click', selector: '#go'}, {op: 'read', selector: 'main'}]});
  assert.equal(act.kind, 'browser.action'); assert.equal(act.steps.length, 3);
  assert.throws(() => validateBrowserRequest({url: 'https://x.com/home', steps: [{op: 'click', selector: '[data-testid=tweetButton]'}]}), status(403));
  assert.throws(() => validateBrowserRequest({url: 'https://example.com', steps: [{op: 'navigate', url: 'https://mobile.twitter.com'}, {op: 'type', selector: 'textarea', text: 'x'}]}), status(403), 'A navigate onto X before interacting is refused too.');
  assert.equal(validateBrowserRequest({url: 'https://x.com/someone/status/1', steps: [{op: 'read', selector: 'article'}]}).kind, 'browser.action', 'Reading X is allowed.');
  const scrolled = validateBrowserRequest({url: 'https://x.com/home', steps: [{op: 'scroll', times: 9}]});
  assert.equal(scrolled.steps[0].times, 4, 'A scroll only moves the page, and only a few times.');
  assert.equal(scrolled.kind, 'browser.action');
  assert.throws(() => validateBrowserRequest({url: 'file:///etc/passwd'}), /public http/);
  assert.throws(() => validateBrowserRequest({url: 'https://example.com', steps: Array(26).fill({op: 'read', selector: 'p'})}), /at most 25/);
  assert.throws(() => validateBrowserRequest({url: 'https://example.com', steps: [{op: 'eval', selector: 'p'}]}), /op/);
  const many = [1, 2, 3].map(i => block({url: `https://example.com/${i}`})).join('\n') + '\n```browser\nnot json\n```';
  assert.equal(parseBrowserRequests(many).length, 2, 'At most two requests per reply.');
  assert.deepEqual(parseBrowserRequests('```browser\n{oops\n```'), [{ok: false, error: 'The browser block is not valid JSON.'}]);
  assert.equal(stripBrowserBlocks(block({url: 'https://example.com'})), 'Let me look.\n\nBack soon.');
  const unclosed = 'Checking.\n```browser\n{"url":"https://example.com/docs"}';
  assert.equal(parseBrowserRequests(unclosed)[0].request.url, 'https://example.com/docs', 'A reply ending on its block loses the closing fence in the AI client.');
  assert.equal(stripBrowserBlocks(unclosed), 'Checking.');
  assert.equal(capturePageText({actions: [{text: 'Hello'}]}), 'Hello');
  assert.equal(capturePageText({text: 'x'.repeat(2000)}, 1500).length, 1500);
  assert.equal(capturePageText({text: 'x'.repeat(2000)}).length, 2000);
});

test('a step can name an element by its index from the last result', () => {
  const at = (op, index, extra = {}) => ({op, index, ...extra});
  assert.deepEqual(validateBrowserRequest({url: 'https://example.com', steps: [at('click', 3), at('type', 4, {text: 'hi'})]}).steps, [{op: 'click', index: 3}, {op: 'type', index: 4, text: 'hi'}]);
  assert.deepEqual(validateBrowserRequest({url: 'https://example.com', steps: [{op: 'read', selector: 'main'}]}).steps, [{op: 'read', selector: 'main'}], 'A CSS selector still works.');
  // An index is only meaningful if it came from a result, so zero, a fraction,
  // a word and a value past the cap all need a selector instead.
  for (const bad of [0, -1, 2.5, MAX_ELEMENT_INDEX + 1, 'three']) {
    assert.throws(() => validateBrowserRequest({url: 'https://example.com', steps: [at('click', bad)]}), /index from the last result/, String(bad));
  }
  // An index is a click like any other, so X refuses it too.
  assert.throws(() => validateBrowserRequest({url: 'https://x.com/home', steps: [at('click', 2)]}), status(403));
  // The index survives validation; it is what the device (or the server) uses.
  assert.equal(validateBrowserRequest({url: 'https://example.com', steps: [at('click', 3)]}).steps[0].index, 3);
});

test('the numbered controls a result returned are what the next turn acts on', () => {
  const page = capturePageText({text: 'Body text', elements: [{index: 1, tag: 'input', text: 'Search'}, {index: 2, tag: 'button', text: 'Go'}, {index: 3, tag: 'a'}]});
  assert.match(page, /Body text/);
  assert.match(page, /Controls: \[1\] input Search · \[2\] button Go/);
  assert.equal(page.includes('[3]'), false, 'A control with no text is not worth a line.');
  assert.equal(capturePageText({actions: [{text: 'Read text'}], elements: [{index: 1, tag: 'a', text: 'Link'}]}), 'Read text\n\nControls: [1] a Link');
});

test('a trailing dot is still X or Twitter, so click and type stay refused', () => {
  const click = selector => [{op: 'click', selector}];
  for (const url of ['https://x.com./home', 'https://x.com%2e/home', 'https://x.com%2e%2e/home', 'https://twitter.com.', 'https://www.x.com.', 'https://mobile.twitter.com%2e/', 'https://x.com%E3%80%82/home', 'https://twitter.com%EF%BC%8E/']) {
    assert.throws(() => validateBrowserRequest({url, steps: click('[data-testid=tweetButton]')}), status(403), url);
  }
  assert.throws(() => validateBrowserRequest({url: 'https://example.com', steps: [{op: 'navigate', url: 'https://twitter.com%2e/compose'}, {op: 'type', selector: 'textarea', text: 'hi'}]}), status(403));
  const read = validateBrowserRequest({url: 'https://x.com./home', steps: [{op: 'scroll', times: 2}, {op: 'read', selector: 'main'}]});
  assert.equal(read.kind, 'browser.action', 'Reading the dotted host is still allowed.');
  assert.equal(validateBrowserRequest({url: 'https://example.com.', steps: click('#go')}).steps[0].op, 'click', 'A trailing dot on some other host is not X.');
  assert.equal(validateBrowserRequest({url: 'https://notx.com/home', steps: click('a')}).url, 'https://notx.com/home');
  assert.match(refusePostingAction('click', 'https://x.com/home'), /never click or type/);
  assert.match(refusePostingAction('type', 'https://x.com./compose'), /never click or type/);
  assert.match(refusePostingAction('click', 'https://mobile.twitter.com/'), /never click or type/);
  assert.equal(refusePostingAction('click', 'https://example.com/'), '');
  assert.equal(refusePostingAction('read', 'https://x.com/home'), '');
  assert.equal(refusePostingAction('scroll', 'https://twitter.com.'), '');
});

test('a reply becomes a request card for a bot already cleared, an ask for one that is not, and nothing for a Deny, within the depth limit', () => {
  const state = wf.migrate({candidates: [], groups: []});
  const out = recordBrowserRequests(state, {bot: browserBot(), groupId: 'g', chatKey: 'web', output: block({url: 'https://example.com'}), makeId: (() => { let n = 0; return () => `id-${++n}`; })()});
  assert.equal(out.text, 'Let me look.\n\nBack soon.');
  assert.equal(out.records.length, 1); assert.equal(state.browserRequests[0].status, 'pending');
  assert.equal(out.lines[0].kind, 'browser'); assert.equal(requestOfMessage(state, out.lines[0].id).id, out.records[0].id);
  // A bot with no permission never hears "I don't have permission": it asks, and the owner answers.
  const none = recordBrowserRequests(state, {bot: browserBot({permissions: [], settings: {}}), groupId: 'g', chatKey: 'web', output: block({url: 'https://example.com'})});
  assert.equal(none.records.length, 1); assert.equal(none.asks.length, 1); assert.equal(none.asks[0].action, 'browser.use');
  assert.equal(none.records[0].askId, none.asks[0].id); assert.deepEqual(none.lines, [], 'the ask is the card');
  // The permission list is read the way every other control block reads it: a malformed record whose
  // permissions is a bare string is not "Always allow" (a string's own `.includes` would have matched).
  const malformed = recordBrowserRequests(state, {bot: browserBot({permissions: BROWSER_PERMISSION}), groupId: 'g', chatKey: 'web', output: block({url: 'https://example.com'})});
  assert.equal(malformed.asks.length, 1);
  // An owner's Deny refuses outright, and says where to change it.
  state.grants = [{botId: 'web', action: 'browser.use', scope: 'https://denied.example.com', choice: 'deny', at: new Date().toISOString()}];
  state.groups = [{id: 'g', name: 'G', bots: [browserBot()]}];
  const denied = recordBrowserRequests(state, {bot: browserBot(), groupId: 'g', chatKey: 'web', output: block({url: 'https://denied.example.com/x'})});
  assert.equal(denied.records.length, 0); assert.match(denied.lines[0].text, /profile → Permissions/);
  state.grants = [];
  const deep = recordBrowserRequests(state, {bot: browserBot(), groupId: 'g', chatKey: 'web', output: block({url: 'https://example.com'}), depth: MAX_BROWSER_DEPTH});
  assert.equal(deep.records.length, 0); assert.match(deep.lines[0].text, /limit/);
  const refused = recordBrowserRequests(state, {bot: browserBot(), groupId: 'g', chatKey: 'web', output: block({url: 'https://x.com', steps: [{op: 'click', selector: 'button'}]})});
  assert.match(refused.lines[0].text, /refused: .*Posting stays yours/);
  assert.equal(recordBrowserRequests(state, {bot: browserBot(), groupId: 'g', chatKey: 'web', output: 'plain reply'}).text, 'plain reply');
  const again = recordBrowserRequests(state, {bot: browserBot(), groupId: 'g', chatKey: 'web', output: block({url: 'https://x.com/home/'}), skipUrls: ['https://x.com/home']});
  assert.equal(again.records.length, 0);
  assert.match(again.lines[0].text, /already has that page/);
  assert.equal(denyBrowserRequest(state, out.records[0].id).status, 'denied');
  assert.throws(() => denyBrowserRequest(state, out.records[0].id), status(409));
  state.browserRequests.unshift({id: 'page-go', runId: 'r-page', status: 'dispatched'});
  assert.equal(denyBrowserRequest(state, 'page-go').status, 'denied', 'A dispatched page that is holding a run can still be cancelled.');
  state.browserRequests.unshift({id: 'other-go', status: 'dispatched'});
  assert.equal(denyBrowserRequest(state, 'other-go').status, 'denied', 'A dispatched 1:1 page can still be cancelled.');
  assert.equal(validateBotSettings({browserApproval: 'auto'}).browserApproval, 'auto');
  assert.throws(() => validateBotSettings({browserApproval: 'always'}), /Browser approval/);
});

test('the envelope tells every bot about the browser tool, because asking the owner is how a bot gets a page', () => {
  const group = {id: 'g', name: 'G', bots: [browserBot(), {id: 'plain', name: 'Plain', instructions: 'x', type: 'custom'}]};
  const run = createRun({group, message: '@Web @Plain go', makeId: () => 'r'});
  assert.match(createEnvelope({run, bot: group.bots[0]}).tools.browser, /browser/);
  assert.match(createEnvelope({run, bot: group.bots[1]}).tools.browser, /browser/);
  assert.match(browserResultText({botName: 'Web', url: 'https://example.com'}, {title: 'Example', finalUrl: 'https://example.com/', actions: [{op: 'read', ok: true, text: 'Hello'}]}), /Browser result for Web: Example · https:\/\/example\.com\/\n\nHello/);
});

async function harness() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-browser-'));
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  store.run("INSERT INTO workspaces (id,name,created_at) VALUES ('default','Primary workspace',?)", new Date().toISOString());
  agent.attachVault(store, path.join(dir, 'state.json'));
  return {dir, store};
}

test('a bot browses through the paired local agent and continues from the result', async () => {
  const {dir, store} = await harness();
  try {
    // This bot has no grant, so its page waits for the owner's answer (an ask) before it reaches the device.
    await store.update(s => { wf.migrate(s); coordinationState(s); s.groups = [{id: 'lab', name: 'Lab', bots: [browserBot({permissions: [], settings: {}})]}]; s.groupRuns.push(createRun({group: s.groups[0], message: 'Find the docs', makeId: () => 'run-1', chatKey: 'web'})); });
    await runGroup(store, 'run-1', async () => block({url: 'https://example.com/docs', steps: [{op: 'read', selector: 'main'}]}));
    let s = store.read();
    const request = s.browserRequests[0];
    assert.equal(request.status, 'pending', 'Ask is the default: nothing reaches the device unapproved.');
    assert.equal(s.groupRuns[0].status, 'awaiting_ask');
    assert.deepEqual(s.chats.web.map(m => m.kind || m.role), ['bot', 'ask']);
    assert.equal(s.chats.web[0].text, 'Let me look.\n\nBack soon.', 'The chat shows the reply without the raw block.');
    await assert.rejects(dispatchBrowserRequest(store, request.id), error => error.status === 409 && /No paired local agent holds the browser\.action/.test(error.message));
    assert.equal(store.read().browserRequests[0].status, 'pending', 'Without an agent the request stays pending.');

    const {code} = agent.createPairing(store, 'default', {});
    const device = agent.redeemPairing(store, {code, name: 'Laptop', permissions: ['browser.action']});
    await answerAskFlow(store, request.askId, 'allow', {actor: 'owner@localhost'});
    const sent = store.read().browserRequests[0];
    assert.equal(sent.status, 'dispatched'); assert.equal(sent.approvedBy, 'owner@localhost');
    await assert.rejects(dispatchBrowserRequest(store, request.id), status(409), 'A request is sent once.');
    const [task] = agent.claimAgentTasks(store, device.agentId);
    assert.equal(task.kind, 'browser.action');
    assert.deepEqual(JSON.parse(task.payload), {url: 'https://example.com/docs', steps: [{op: 'read', selector: 'main'}], botId: 'web'});

    const longPage = `Install with npm.\n${'Keep this paragraph for the next draft. '.repeat(60)}`;
    agent.completeAgentTask(store, device.agentId, task.id, {status: 'done', result: {title: 'Docs', finalUrl: 'https://example.com/docs', actions: [{op: 'read', ok: true, text: longPage}]}});
    assert.equal(store.read().groupRuns[0].status, 'awaiting_browser');
    const continued = [];
    const done = await onAgentTaskResult(store, task.id, {
      continueRun: async () => continued.push('new-run'),
      resumeBrowser: (s, req, opts) => resumeBrowserRun(s, req, {...opts, executor: async (bot, raw) => { continued.push(JSON.parse(raw)); return 'Used the docs.'; }}),
    });
    assert.equal(done.status, 'done');
    for (let i = 0; i < 40 && store.read().groupRuns[0].status !== 'completed'; i++) await new Promise(r => setTimeout(r, 20));
    s = store.read();
    assert.match(s.chats.web.find(m => /Install with npm/.test(m.text)).text, /Browser result for Web: Docs/);
    assert.equal(continued.includes('new-run'), false, 'The same run continues; a second queue must not start.');
    const env = continued.find(e => e && e.page);
    assert.ok(env && env.page.includes('Keep this paragraph') && env.page.length > 1500, 'The next turn gets the captured page, not the short chat line.');
    assert.equal(s.groupRuns[0].status, 'completed');
    assert.match(s.groupRuns[0].trace.at(-1).output, /Used the docs/);
    assert.equal(await onAgentTaskResult(store, task.id, {continueRun: async () => continued.push('again')}), null, 'A result is applied once.');
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('a request runs on this server when no device is paired, and continues like a device result', async () => {
  const {dir, store} = await harness();
  const until = async (check, note) => {
    for (let i = 0; i < 100; i++) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw new Error(`timed out waiting for ${note}`);
  };
  try {
    const now = new Date().toISOString();
    const pending = id => ({id, botId: 'web', botName: 'Web', groupId: 'lab', chatKey: 'web', url: 'https://example.com/docs', steps: [], kind: 'browser.capture', depth: 0, status: 'pending', agentTaskIds: [], result: null, error: null, createdAt: now, updatedAt: now});
    await store.update(s => {
      wf.migrate(s); coordinationState(s);
      s.groups = [{id: 'lab', name: 'Lab', bots: [browserBot()]}];
      s.browserRequests = [pending('here')];
    });
    const ran = [];
    let broken = false;
    const runtime = {
      mode: 'auto',
      available: () => true,
      run: async request => {
        if (broken) throw new Error('The page did not finish loading within 25s.');
        ran.push(request);
        return {title: 'Docs', finalUrl: 'https://example.com/docs', text: 'Install with npm and restart the service once.'};
      },
      close: async () => {},
    };
    const continued = [];
    setBrowserResultHooks({continueRun: async (s, spec) => { continued.push(spec); }});
    const sent = await dispatchBrowserRequest(store, 'here', {actor: 'owner@localhost', runtime});
    assert.equal(sent.status, 'dispatched');
    assert.equal(sent.via, 'server', 'The card says where the page is being opened.');
    assert.deepEqual(sent.agentTaskIds, [], 'No device is asked to open the page.');
    const done = await until(() => { const r = store.read().browserRequests.find(x => x.id === 'here'); return r.status === 'dispatched' ? null : r; }, 'the server to read the page');
    assert.equal(done.status, 'done');
    assert.deepEqual(ran, [{url: 'https://example.com/docs', steps: []}]);
    assert.equal(done.result.title, 'Docs');
    assert.match(done.result.page, /Install with npm/);
    assert.match(store.read().chats.web.find(m => m.kind === 'browser-result').text, /Browser result for Web: Docs/);
    await until(() => continued.length, 'the bot to continue from the page');
    assert.equal(continued[0].directBotId, 'web');
    assert.match(continued[0].page, /Install with npm/);

    // A browser failure is reported the same way a device failure is, and is
    // never handed back as a page.
    broken = true;
    await store.update(s => { s.browserRequests.unshift(pending('here-2')); });
    await dispatchBrowserRequest(store, 'here-2', {runtime});
    const failed = await until(() => { const r = store.read().browserRequests.find(x => x.id === 'here-2'); return r.status === 'dispatched' ? null : r; }, 'the failure to be reported');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.result, null);
    assert.match(failed.error, /did not finish loading/);
    assert.match(store.read().chats.web.find(m => m.kind === 'browser-result' && /failed/.test(m.text)).text, /Web's browser request failed: The page did not finish loading/);
    assert.equal(continued.length, 1, 'A failed page does not start a model turn.');
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('a failed enqueue puts the claimed request back to pending', async () => {
  const {dir, store} = await harness();
  try {
    const {code} = agent.createPairing(store, 'default', {});
    const device = agent.redeemPairing(store, {code, name: 'Laptop', permissions: ['browser.capture']});
    const now = new Date().toISOString();
    await store.update(s => {
      wf.migrate(s);
      s.groups = [{id: 'lab', name: 'Lab', bots: [browserBot()]}];
      s.browserRequests = [{id: 'fr', botId: 'web', botName: 'Web', groupId: 'lab', chatKey: 'web', url: 'https://example.com/', steps: [], kind: 'browser.capture', depth: 0, status: 'pending', agentTaskIds: [], result: null, error: null, createdAt: now, updatedAt: now}];
    });
    const orig = store.run.bind(store);
    store.run = (sql, ...params) => {
      if (String(sql).includes('INSERT INTO agent_tasks')) throw Object.assign(new Error('The agent database is busy.'), {status: 503});
      return orig(sql, ...params);
    };
    await assert.rejects(dispatchBrowserRequest(store, 'fr'), error => error.status === 503 && /busy/.test(error.message));
    const left = store.read().browserRequests.find(r => r.id === 'fr');
    assert.equal(left.status, 'pending');
    assert.equal(left.approvedBy, undefined);
    assert.equal(agent.claimAgentTasks(store, device.agentId).length, 0);
    store.run = orig;
    const sent = await dispatchBrowserRequest(store, 'fr');
    assert.equal(sent.status, 'dispatched');
    assert.equal(agent.claimAgentTasks(store, device.agentId).length, 1);
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('auto-approval with no agent stays pending and is reported, and a denial is not described as waiting', async () => {
  const {dir, store} = await harness();
  try {
    const now = new Date().toISOString();
    const request = (id, status) => ({id, botId: 'web', botName: 'Web', groupId: 'lab', chatKey: 'web', url: 'https://example.com/', steps: [], kind: 'browser.capture', depth: 0, status, agentTaskIds: [], result: null, error: null, createdAt: now, updatedAt: now});
    await store.update(s => {
      wf.migrate(s);
      s.groups = [{id: 'lab', name: 'Lab', bots: [browserBot()]}];
      s.browserRequests = [request('pending-one', 'pending')];
    });
    await autoDispatch(store, store.read().browserRequests);
    assert.equal(store.read().browserRequests[0].status, 'pending');
    assert.match(store.read().chats.web.at(-1).text, /browser request is waiting: No paired local agent/);
    await store.update(s => { s.browserRequests = [request('denied-one', 'denied')]; s.chats.web = []; });
    await autoDispatch(store, store.read().browserRequests);
    assert.equal(store.read().browserRequests[0].status, 'denied');
    assert.equal(store.read().chats.web.length, 0);
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('a bot set to run without asking sends its request at once, and a failure is reported', async () => {
  const {dir, store} = await harness();
  try {
    const {code} = agent.createPairing(store, 'default', {});
    const device = agent.redeemPairing(store, {code, name: 'Laptop', permissions: ['browser.capture']});
    await store.update(s => { wf.migrate(s); coordinationState(s); s.groups = [{id: 'lab', name: 'Lab', bots: [browserBot({settings: {browserApproval: 'auto'}})]}]; s.groupRuns.push(createRun({group: s.groups[0], message: 'Read it', makeId: () => 'run-2', chatKey: 'team-lab'})); });
    await runGroup(store, 'run-2', async () => block({url: 'https://example.com'}));
    assert.equal(store.read().browserRequests[0].status, 'dispatched');
    const [task] = agent.claimAgentTasks(store, device.agentId);
    assert.equal(task.kind, 'browser.capture');
    for (let i = 0; i < 3; i++) {
      agent.completeAgentTask(store, device.agentId, task.id, {status: 'failed', error: 'example.com is not in AGENT_BROWSER_ALLOWLIST.'});
      if (i < 2) { assert.equal(await onAgentTaskResult(store, task.id), null, 'A retrying task posts nothing yet.'); agent.claimAgentTasks(store, device.agentId); }
    }
    const failed = await onAgentTaskResult(store, task.id, {continueRun: async () => assert.fail('A failure is not handed back as a page.'), resumeBrowser: (s, req, opts) => resumeBrowserRun(s, req, {...opts, executor: async () => assert.fail('A failure is not handed back as a page.')})});
    assert.equal(failed.status, 'failed');
    assert.match(store.read().chats['team-lab'].at(-1).text, /browser request failed: example\.com is not in AGENT_BROWSER_ALLOWLIST/);
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('the next bot waits until the page is back, then that same bot continues', async () => {
  const {dir, store} = await harness();
  try {
    const writer = browserBot({id: 'writer', name: 'Writer', type: 'writing'});
    const reviewer = {id: 'reviewer', name: 'Reviewer', instructions: 'Check.', type: 'review'};
    await store.update(s => {
      wf.migrate(s); coordinationState(s);
      s.groups = [{id: 'lab', name: 'Lab', bots: [writer, reviewer]}];
      s.groupRuns.push(createRun({group: s.groups[0], message: '@Writer @Reviewer draft from the docs', makeId: () => 'run-p', chatKey: 'team-lab'}));
    });
    const seen = [];
    await runGroup(store, 'run-p', async bot => { seen.push(bot.id); return bot.id === 'writer' ? block({url: 'https://example.com/docs', steps: [{op: 'read', selector: 'main'}]}) : 'Looks good.'; });
    assert.deepEqual(seen, ['writer']);
    assert.equal(store.read().groupRuns[0].status, 'awaiting_browser');
    const {code} = agent.createPairing(store, 'default', {});
    const device = agent.redeemPairing(store, {code, name: 'Laptop', permissions: ['browser.action']});
    await dispatchBrowserRequest(store, store.read().browserRequests[0].id);
    const [task] = agent.claimAgentTasks(store, device.agentId);
    agent.completeAgentTask(store, device.agentId, task.id, {status: 'done', result: {title: 'Docs', text: 'Install with npm and then restart the service once.'}});
    await onAgentTaskResult(store, task.id, {continueRun: async () => assert.fail('Must not start a second run.'), resumeBrowser: (s, req, opts) => resumeBrowserRun(s, req, {...opts, executor: async bot => { seen.push(bot.id); return bot.id === 'writer' ? 'Here is a draft from the docs you can edit.' : 'Looks good.'; }})});
    for (let i = 0; i < 40 && store.read().groupRuns[0].status !== 'completed'; i++) await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(seen, ['writer', 'writer', 'reviewer']);
    assert.equal(store.read().groupRuns[0].status, 'completed');
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('a long reply still files both browser fences', async () => {
  const {dir, store} = await harness();
  try {
    await store.update(s => {
      wf.migrate(s); coordinationState(s);
      s.groups = [{id: 'lab', name: 'Lab', bots: [browserBot()]}];
      s.groupRuns.push(createRun({group: s.groups[0], message: 'Look both up', makeId: () => 'run-long', chatKey: 'team-lab'}));
    });
    const pad = `Note.\n${'x'.repeat(4000)}`;
    await runGroup(store, 'run-long', async () => `${pad}\n${block({url: 'https://example.com/a'})}\n${block({url: 'https://example.com/b'})}`);
    assert.equal(store.read().browserRequests.filter(r => r.runId === 'run-long').length, 2);
    assert.equal(store.read().groupRuns[0].status, 'awaiting_browser');
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('the second page of one reply is waited for before the bot continues', async () => {
  const {dir, store} = await harness();
  try {
    await store.update(s => {
      wf.migrate(s); coordinationState(s);
      s.groups = [{id: 'lab', name: 'Lab', bots: [browserBot()]}];
      s.groupRuns.push(createRun({group: s.groups[0], message: 'Look both up', makeId: () => 'run-two', chatKey: 'team-lab'}));
    });
    const seen = [];
    await runGroup(store, 'run-two', async () => `${block({url: 'https://example.com/a'})}\n${block({url: 'https://example.com/b'})}`);
    const [first, second] = store.read().browserRequests.filter(r => r.runId === 'run-two');
    const pageA = 'Alpha page is long enough to count as captured article text here.';
    const pageB = 'Beta page is long enough to count as captured article text here.';
    await store.update(s => { s.browserRequests.find(r => r.id === first.id).status = 'done'; });
    await resumeBrowserRun(store, first, {ok: true, text: pageA, executor: async () => { seen.push('early'); return 'too soon'; }});
    assert.equal(store.read().groupRuns[0].status, 'awaiting_browser');
    assert.match(store.read().groupRuns[0].browserPage, /Alpha page/);
    assert.deepEqual(seen, []);
    await store.update(s => { s.browserRequests.find(r => r.id === second.id).status = 'done'; });
    await resumeBrowserRun(store, second, {ok: true, text: pageB, executor: async (bot, input) => {
      seen.push('go');
      assert.match(input, /Alpha page/);
      assert.match(input, /Beta page/);
      return 'Used both pages.';
    }});
    for (let i = 0; i < 40 && store.read().groupRuns[0].status !== 'completed'; i++) await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(seen, ['go']);
    assert.equal(store.read().groupRuns[0].status, 'completed');
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('a duplicate result delivery neither double-appends nor restarts the run', async () => {
  const {dir, store} = await harness();
  try {
    await store.update(s => {
      wf.migrate(s); coordinationState(s);
      s.groups = [{id: 'lab', name: 'Lab', bots: [browserBot()]}];
      s.groupRuns.push(createRun({group: s.groups[0], message: 'Look it up', makeId: () => 'run-dup', chatKey: 'team-lab'}));
    });
    await runGroup(store, 'run-dup', async () => block({url: 'https://example.com/a'}));
    const [req] = store.read().browserRequests.filter(r => r.runId === 'run-dup');
    const page = 'A page long enough to count as captured article text here now.';
    const went = [];
    await resumeBrowserRun(store, req, {ok: true, text: page, executor: async () => { went.push('run'); return 'Done.'; }});
    const first = store.read().groupRuns[0].browserPage;
    assert.match(store.read().groupRuns[0].status, /^(queued|running)$/, 'A single request resumes without waiting on siblings.');
    // Simulate the retried POST: the agent reports the result a second time.
    await resumeBrowserRun(store, req, {ok: true, text: page, executor: async () => { went.push('again'); return 'Done again.'; }});
    assert.equal(store.read().groupRuns[0].browserPage, first, 'The page is not appended twice.');
    for (let i = 0; i < 40 && store.read().groupRuns[0].status !== 'completed'; i++) await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(went, ['run']);
    assert.equal(store.read().groupRuns[0].browserConsumed?.length, 1);
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('denying a page still pauses at a checkpoint before the next bot', async () => {
  const {dir, store} = await harness();
  try {
    const writer = {id: 'writer', name: 'Writer', instructions: 'Write.', type: 'custom'};
    await store.update(s => {
      wf.migrate(s); coordinationState(s);
      s.groups = [{id: 'lab', name: 'Lab', settings: {checkpoints: true}, bots: [browserBot(), writer]}];
      s.groupRuns.push(createRun({group: s.groups[0], message: '@Web @Writer go', makeId: () => 'run-ck', chatKey: 'team-lab'}));
    });
    const seen = [];
    await runGroup(store, 'run-ck', async bot => {
      seen.push(bot.id);
      if (bot.id === 'web') return block({url: 'https://example.com/docs'});
      return 'Draft.';
    });
    const req = store.read().browserRequests.find(r => r.runId === 'run-ck');
    await resumeBrowserRun(store, req, {ok: false, executor: async bot => { seen.push(bot.id); return 'should not run'; }});
    assert.equal(store.read().groupRuns[0].status, 'awaiting_checkpoint');
    assert.deepEqual(seen, ['web']);
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('a one-to-one browse result does not wait on the follow-up model call', async () => {
  const {dir, store} = await harness();
  try {
    await store.update(s => {
      wf.migrate(s); coordinationState(s);
      s.groups = [{id: 'lab', name: 'Lab', bots: [browserBot()]}];
      recordBrowserRequests(s, {bot: browserBot(), groupId: 'lab', chatKey: 'web', output: block({url: 'https://example.com/docs', steps: [{op: 'read', selector: 'main'}]})});
    });
    const {code} = agent.createPairing(store, 'default', {});
    const device = agent.redeemPairing(store, {code, name: 'Laptop', permissions: ['browser.action']});
    await dispatchBrowserRequest(store, store.read().browserRequests[0].id);
    const [task] = agent.claimAgentTasks(store, device.agentId);
    agent.completeAgentTask(store, device.agentId, task.id, {status: 'done', result: {title: 'Docs', text: 'Install with npm.'}});
    let spec = null, resolveHang;
    const hang = new Promise(r => { resolveHang = r; });
    await Promise.race([
      onAgentTaskResult(store, task.id, {continueRun: async (s, body) => { spec = body; await hang; }}),
      new Promise((_, reject) => setTimeout(() => reject(new Error('held the agent POST')), 500)),
    ]);
    assert.equal(spec?.directBotId, 'web');
    assert.match(spec.page, /Install with npm/);
    assert.equal(spec.message.includes('Install with npm'), false, 'Page text is data, not part of the task message.');
    resolveHang();
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('a one-to-one reply with two pages waits for both before continuing', async () => {
  const {dir, store} = await harness();
  try {
    await store.update(s => {
      wf.migrate(s); coordinationState(s);
      s.groups = [{id: 'lab', name: 'Lab', bots: [browserBot()]}];
      recordBrowserRequests(s, {bot: browserBot(), groupId: 'lab', chatKey: 'web', output: `${block({url: 'https://example.com/a', steps: [{op: 'read', selector: 'main'}]})}\n${block({url: 'https://example.com/b', steps: [{op: 'read', selector: 'main'}]})}`});
    });
    const {code} = agent.createPairing(store, 'default', {});
    const device = agent.redeemPairing(store, {code, name: 'Laptop', permissions: ['browser.action']});
    const ids = store.read().browserRequests.filter(r => r.chatKey === 'web' && r.status === 'pending').map(r => r.id);
    assert.equal(ids.length, 2);
    for (const id of ids) await dispatchBrowserRequest(store, id);
    const claimed = agent.claimAgentTasks(store, device.agentId);
    assert.equal(claimed.length, 2);
    const started = [];
    agent.completeAgentTask(store, device.agentId, claimed[0].id, {status: 'done', result: {title: 'A', text: 'Alpha page is long enough to count as captured article text here.'}});
    await onAgentTaskResult(store, claimed[0].id, {continueRun: async (s, spec) => started.push(spec)});
    assert.equal(started.length, 0, 'The first page waits for the second.');
    agent.completeAgentTask(store, device.agentId, claimed[1].id, {status: 'done', result: {title: 'B', text: 'Beta page is long enough to count as captured article text here.'}});
    await onAgentTaskResult(store, claimed[1].id, {continueRun: async (s, spec) => started.push(spec)});
    assert.equal(started.length, 1);
    assert.match(started[0].page, /Alpha page/);
    assert.match(started[0].page, /Beta page/);
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('a one-to-one browse continues that bot, not a group run', async () => {
  const bot = [], group = [];
  await continueBrowserWork(null, {directBotId: 'web', message: 'Here is the page.', page: 'Docs text.', browserDepth: 1, groupId: 'lab'}, {
    runBot: async (s, spec) => bot.push(spec),
    runGroup: async (s, spec) => group.push(spec),
  });
  assert.deepEqual(bot, [{botId: 'web', input: 'Here is the page.', page: 'Docs text.', browserDepth: 1}]);
  assert.equal(group.length, 0);
  await continueBrowserWork(null, {groupId: 'lab', message: 'go'}, {
    runBot: async (s, spec) => bot.push(spec),
    runGroup: async (s, spec) => group.push(spec),
  });
  assert.equal(group.length, 1);
});

test('a person takes over the page, and handing it back resumes the bot from it', async () => {
  const {dir, store} = await harness();
  try {
    const now = new Date().toISOString();
    await store.update(s => {
      wf.migrate(s); coordinationState(s);
      s.groups = [{id: 'lab', name: 'Lab', bots: [browserBot()]}];
      s.browserRequests = [{id: 'takeover-req', botId: 'web', botName: 'Web', groupId: 'lab', chatKey: 'web', url: 'https://x.com/home', steps: [], kind: 'browser.capture', depth: 0, status: 'pending', agentTaskIds: [], result: null, error: null, createdAt: now, updatedAt: now}];
    });
    const opened = [];
    let sessionOpen = false;
    const runtime = {
      mode: 'auto',
      available: () => true,
      beginLive: async ({url, requestId, openedBy}) => {
        // One person at a time, as the real runtime enforces.
        if (sessionOpen) throw Object.assign(new Error('A takeover is already open. Finish or close it first — one page at a time.'), {status: 409});
        sessionOpen = true;
        opened.push({url, requestId, openedBy});
        return {id: 'takeover-1', url, title: 'Home', text: 'Sign in to X', elements: [{index: 1, tag: 'button', text: 'Sign in'}], elementCount: 1, blockedRequests: 0, image: 'data:image/jpeg;base64,AAAA'};
      },
      endLive: async id => { sessionOpen = false; assert.equal(id, 'takeover-1'); return {requestId: 'takeover-req', page: {url: 'https://x.com/home', title: 'Home', text: 'Ada posted about rockets and the next launch window.', elements: [], elementCount: 0, blockedRequests: 0}}; },
    };
    const view = await beginTakeover(store, 'takeover-req', {actor: 'owner@localhost', runtime});
    assert.equal(view.id, 'takeover-1');
    assert.equal(view.requestId, 'takeover-req');
    assert.deepEqual(opened, [{url: 'https://x.com/home', requestId: 'takeover-req', openedBy: 'owner@localhost'}]);
    const held = store.read().browserRequests.find(r => r.id === 'takeover-req');
    assert.equal(held.status, 'pending', 'The request still waits on a person while they hold the page, so a takeover that times out leaves nothing stuck.');
    // Only one takeover at a time.
    await assert.rejects(beginTakeover(store, 'takeover-req', {runtime}), status(409));

    const continued = [];
    setBrowserResultHooks({continueRun: async (s, spec) => { continued.push(spec); }});
    const handed = await handBackTakeover(store, 'takeover-1', {runtime});
    assert.equal(handed.handedBack, true);
    const done = store.read().browserRequests.find(r => r.id === 'takeover-req');
    assert.equal(done.status, 'done');
    assert.equal(done.result.title, 'Home');
    assert.match(done.result.page, /Ada posted about rockets/, 'The bot is handed the page the person reached.');
    assert.match(store.read().chats.web.find(m => m.kind === 'browser-result').text, /Browser result for Web/);
    assert.equal(continued.length, 1, 'The bot continues from the page the person signed in for.');
    assert.match(continued[0].page, /Ada posted about rockets/);
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('a takeover is refused where there is no browser, and a finished request cannot be taken over', async () => {
  const {dir, store} = await harness();
  try {
    const now = new Date().toISOString();
    await store.update(s => {
      wf.migrate(s);
      s.browserRequests = [{id: 'r1', botId: 'web', botName: 'Web', groupId: 'lab', chatKey: 'web', url: 'https://example.com/', steps: [], kind: 'browser.capture', depth: 0, status: 'pending', agentTaskIds: [], result: null, error: null, createdAt: now, updatedAt: now}];
    });
    // A device-only install has no browser here to take over.
    await assert.rejects(beginTakeover(store, 'r1', {runtime: {mode: 'agent', available: () => false, beginLive: async () => assert.fail('must not open')}}), status(409));
    await assert.rejects(beginTakeover(store, 'missing', {runtime: {mode: 'auto', available: () => true, beginLive: async () => assert.fail('must not open')}}), status(404));
    await store.update(s => { s.browserRequests[0].status = 'done'; });
    await assert.rejects(beginTakeover(store, 'r1', {runtime: {mode: 'auto', available: () => true, beginLive: async () => assert.fail('must not open')}}), status(409));
    // Handing back a request that finished meanwhile does not resurrect it.
    const result = await handBackTakeover(store, 'takeover-9', {runtime: {endLive: async () => ({requestId: 'r1', page: {url: 'https://example.com/'}})}});
    assert.equal(result.handedBack, false);
    assert.equal(store.read().browserRequests.find(r => r.id === 'r1').status, 'done');
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('browser requests survive a restart of the SQLite store', async () => {
  const {dir, store} = await harness();
  try {
    await store.update(s => { wf.migrate(s); recordBrowserRequests(s, {bot: browserBot(), groupId: 'x-engage', chatKey: 'writer', output: block({url: 'https://example.com'})}); });
    const again = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
    assert.equal(again.read().browserRequests[0].url, 'https://example.com/');
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('pruning page history never drops a request that is still open', () => {
  const open = r => ['pending', 'dispatched'].includes(r.status);
  // Finished history overflows the cap while a run is still waiting on a page.
  const state = {browserRequests: [
    ...Array.from({length: 30}, (_, n) => ({id: `done-${n}`, status: 'done'})),
    ...Array.from({length: MAX_BROWSER_REQUESTS - 10}, (_, n) => ({id: `open-${n}`, status: n % 2 ? 'dispatched' : 'pending'})),
    ...Array.from({length: 20}, (_, n) => ({id: `denied-${n}`, status: 'denied'})),
  ]};
  assert.ok(state.browserRequests.length > MAX_BROWSER_REQUESTS);
  const kept = pruneBrowserRequests(state);
  assert.equal(kept.length, MAX_BROWSER_REQUESTS, 'Finished history is bounded by the cap.');
  const waiting = kept.filter(open);
  assert.equal(waiting.length, MAX_BROWSER_REQUESTS - 10, 'Every open request survives, whatever the overflow.');
  assert.ok(waiting.every(r => r.id.startsWith('open-')), 'Only the open requests fill that part of the list.');
  assert.equal(kept.filter(r => !open(r)).length, 10, 'Finished requests fill whatever room is left.');
  // Open requests alone may exceed the cap: a waiting page is never discarded.
  const held = {browserRequests: Array.from({length: MAX_BROWSER_REQUESTS + 5}, (_, n) => ({id: `hold-${n}`, status: 'pending'}))};
  const all = pruneBrowserRequests(held);
  assert.equal(all.length, MAX_BROWSER_REQUESTS + 5);
  assert.ok(all.every(open));
  // Nothing to do under the cap, and a missing collection is created.
  assert.deepEqual(pruneBrowserRequests({browserRequests: [{id: 'one', status: 'denied'}]}).map(r => r.id), ['one']);
  assert.deepEqual(pruneBrowserRequests({}), []);
});

test('a document write that fails after the task row was inserted fails the task too', async () => {
  const {dir, store} = await harness();
  try {
    const {code} = agent.createPairing(store, 'default', {});
    const device = agent.redeemPairing(store, {code, name: 'Laptop', permissions: ['browser.capture']});
    const now = new Date().toISOString();
    await store.update(s => {
      wf.migrate(s);
      s.groups = [{id: 'lab', name: 'Lab', bots: [browserBot()]}];
      s.browserRequests = [{id: 'fr-commit', botId: 'web', botName: 'Web', groupId: 'lab', chatKey: 'web', url: 'https://example.com/', steps: [], kind: 'browser.capture', depth: 0, status: 'pending', agentTaskIds: [], result: null, error: null, createdAt: now, updatedAt: now}];
    });
    const orig = store.update.bind(store);
    let calls = 0;
    store.update = async fn => {
      calls += 1;
      // The claim commits. The next write runs the callback - so the agent task
      // INSERT really lands, it is a `store.run` of its own - and then fails, as a
      // paused workspace or a full disk does.
      if (calls === 2) {
        fn(structuredClone(store.read()));
        throw Object.assign(new Error('The state file could not be written.'), {status: 503});
      }
      return orig(fn);
    };
    await assert.rejects(dispatchBrowserRequest(store, 'fr-commit'), error => error.status === 503);
    store.update = orig;
    const left = store.read().browserRequests.find(r => r.id === 'fr-commit');
    assert.equal(left.status, 'pending', 'the request goes back for a person to approve again');
    const orphan = store.get("SELECT status FROM agent_tasks WHERE idempotency_key='browser:fr-commit'");
    // The row is dropped (it never reached a device) or failed (a device already
    // held it). Queued is the one outcome that is wrong: a page would open.
    assert.ok(!orphan || orphan.status !== 'queued', `the committed task row must not stay claimable, got ${orphan?.status}`);
    assert.equal(agent.claimAgentTasks(store, device.agentId).length, 0, 'the device is never asked to open a page for a request that is pending again');
    const sent = await dispatchBrowserRequest(store, 'fr-commit');
    assert.equal(sent.status, 'dispatched');
    assert.equal(agent.claimAgentTasks(store, device.agentId).length, 1, 'approving again works, because the dead task is out of the way');
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('click and type on x.com are still refused', () => {
  for (const url of ['https://x.com/home', 'https://x.com./home']) {
    assert.throws(() => validateBrowserRequest({url, steps: [{op: 'click', index: 1}]}), status(403), url);
    assert.throws(() => validateBrowserRequest({url, steps: [{op: 'type', index: 1, text: 'hi'}]}), status(403), url);
  }
});
