/** The Pages demo answers asks behind the same routes the server does.
 *
 * The offline engine has no bot that can ask, so the asks here are seeded into the browser-local
 * workspace. What is pinned is that the two engines agree on every decision an answer makes: what
 * each answer stores, which answers are refused (and with which status), what a grant may be, and
 * that an ask from an unattended run lapses after 24 hours.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {installWebLocks} from './web-locks.js';
import {initialState} from '../shared/core.js';
import * as wf from '../shared/workflow.js';
import {createAsk, grantFor, setGrant} from '../shared/asks.js';
import {SqliteStore} from '../src/sqlite-store.js';
import {answerAskFlow} from '../src/ask-runs.js';
import {coordinationState} from '../src/coordination.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let storage = {getItem: () => null, setItem: () => {}};
globalThis.window = globalThis.window || {};
Object.defineProperty(globalThis, 'localStorage', {configurable: true, get: () => storage, set: value => { storage = value; }});
installWebLocks();
await import(path.join(root, 'shared/local-api.js'));

const KEY = 'agent-control-ghpages-v1';
const NOW = new Date().toISOString();
const old = new Date(Date.now() - 30 * 3600000).toISOString();

/** The same asks, a parked run and one lapsed unattended ask, put into whichever workspace state is handed over. */
function seed(state) {
  wf.migrate(state);
  const ids = n => `ask-${n}`;
  const make = (n, extra) => createAsk(state, {botId: 'atlas', chatKey: 'atlas', makeId: () => ids(n), now: NOW, ...extra});
  make(1, {action: 'browser.use', target: 'https://docs.example.com/x', detail: 'read docs.example.com', runId: 'run-1'});
  make(2, {action: 'spend', target: 'https://shop.example.com/checkout', detail: 'pay', runId: null});
  make(3, {action: 'send', target: 'x', detail: 'send it', runId: null});
  make(4, {action: 'post', target: 'x', detail: 'post it', runId: 'run-gone'});
  make(5, {action: 'delete', target: 'x', detail: 'delete it', runId: null, unattended: true, now: old});
  state.groupRuns.push({id: 'run-1', groupId: 'home', chatKey: 'atlas', status: 'awaiting_ask', mode: 'pipeline', askIds: ['ask-1'], recipients: ['atlas'], input: 'look', trace: [], createdAt: NOW, checkpoint: {nextStep: 0, afterStep: 1, previous: null}});
  return state;
}

function pagesDriver() {
  const map = new Map([[KEY, JSON.stringify(seed(wf.migrate(initialState())))]]);
  storage = {getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value))};
  const request = globalThis.window.AGENT_LOCAL_API;
  const read = () => JSON.parse(map.get(KEY));
  return {
    answer: (id, answer) => request(`/api/asks/${id}`, 'POST', {answer}),
    grant: body => request('/api/grants', 'POST', body),
    state: async () => { await request('/api/state'); return read(); },
  };
}

async function serverDriver(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ac-ask-parity-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  await store.update(s => { seed(s); coordinationState(s); });
  return {
    // The 24-hour lapse is the server's sweep; the demo does it on its next call.
    answer: (id, answer) => answerAskFlow(store, id, answer, {executor: async () => 'Closing.'}),
    grant: body => store.update(s => setGrant(s, String(body.botId ?? ''), String(body.action ?? ''), body.scope ?? '', body.choice)),
    state: async () => store.read(),
    store,
  };
}

/** What a call decided: its ask, or the status it was refused with. */
const decided = async call => { try { const r = await call(); return {ok: true, status: r.ask.status, scope: r.ask.scope}; } catch (e) { return {ok: false, status: e.status}; } };

test('both engines make the same decision for every answer, and refuse the same ones', async t => {
  const drivers = {pages: pagesDriver(), server: await serverDriver(t)};
  const script = async d => {
    const out = {};
    out.allowOnce = await decided(() => d.answer('ask-1', 'allow'));
    out.again = await decided(() => d.answer('ask-1', 'decline'));
    out.alwaysPayment = await decided(() => d.answer('ask-2', 'always'));
    out.allowPayment = await decided(() => d.answer('ask-2', 'allow'));
    out.always = await decided(() => d.answer('ask-3', 'always'));
    out.decline = await decided(() => d.answer('ask-4', 'decline'));
    out.nonsense = await decided(() => d.answer('ask-5', 'maybe'));
    out.missing = await decided(() => d.answer('nope', 'allow'));
    const s = await d.state();
    out.grants = s.grants.map(g => `${g.botId}|${g.action}|${g.scope}|${g.choice}`).sort();
    out.asks = Object.fromEntries(s.asks.map(a => [a.id, `${a.status}/${a.scope}`]));
    return out;
  };
  const pages = await script(drivers.pages);
  const server = await script(drivers.server);
  // ask-5 was an unattended ask from 30 hours ago. The server's hourly sweep has not run in this test, the
  // demo lapses on its next call, so only compare it where both have had the chance.
  delete pages.asks['ask-5']; delete server.asks['ask-5'];
  assert.deepEqual(pages, server);
  assert.deepEqual(pages.allowOnce, {ok: true, status: 'allowed', scope: 'once'});
  assert.equal(pages.again.status, 409);
  assert.equal(pages.alwaysPayment.status, 400);
  assert.equal(pages.missing.status, 404);
  assert.deepEqual(pages.grants, ['atlas|send||always']);
});

test('both engines refuse the same grants', async t => {
  const drivers = {pages: pagesDriver(), server: await serverDriver(t)};
  const cases = [
    {botId: 'atlas', action: 'spend', choice: 'always'},
    {botId: 'atlas', action: 'publish.post', choice: 'always'},
    {botId: 'atlas', action: 'bot.ask', choice: 'deny'},
    {botId: 'atlas', action: 'send', choice: 'sometimes'},
    {botId: 'atlas', action: 'browser.use', choice: 'always'},
    {botId: 'nobody', action: 'send', choice: 'ask'},
    {botId: 'atlas', action: 'spend', choice: 'deny'},
    {botId: 'atlas', action: 'browser.use', scope: 'https://Docs.example.com/page', choice: 'always'},
  ];
  for (const body of cases) {
    const results = {};
    for (const [name, d] of Object.entries(drivers)) {
      try { const g = await d.grant(body); results[name] = {ok: true, choice: g.choice, scope: g.scope}; } catch (e) { results[name] = {ok: false, status: e.status}; }
    }
    assert.deepEqual(results.pages, results.server, JSON.stringify(body));
  }
  const s = await drivers.pages.state();
  assert.equal(grantFor(s, 'atlas', 'browser.use', 'https://docs.example.com'), 'always');
  assert.equal(grantFor(s, 'atlas', 'spend', ''), 'deny');
});

test('the demo ends a run parked on an ask when the answer comes, saying what happened', async () => {
  const pages = pagesDriver();
  const declined = await pages.answer('ask-1', 'decline');
  assert.equal(declined.resumed, true);
  const s = await pages.state();
  const run = s.groupRuns.find(r => r.id === 'run-1');
  assert.equal(run.status, 'cancelled');
  assert.match(s.chats.atlas.at(-1).text, /The owner declined: read docs\.example\.com/);
});

test('in the demo an ask from an unattended run lapses on the next call, and an answer after that is refused', async () => {
  const pages = pagesDriver();
  const s = await pages.state();
  assert.equal(s.asks.find(a => a.id === 'ask-5').status, 'declined');
  assert.equal(s.asks.find(a => a.id === 'ask-5').expired, true);
  await assert.rejects(pages.answer('ask-5', 'allow'), e => e.status === 409);
  assert.equal(s.asks.find(a => a.id === 'ask-3').status, 'pending', 'an ask with no expiry waits');
});
