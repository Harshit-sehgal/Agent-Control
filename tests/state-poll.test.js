/** What a poll costs: the workspace snapshot and the static files.
 *
 * The UI polls `GET /api/state` every few seconds, and it used to receive the
 * whole workspace each time, captured pages included, uncompressed, even when
 * nothing had changed. Static files were read from disk on every request with
 * `no-store`. These tests drive the real dispatcher in-process and pin the
 * cheaper answers: an ETag and a 304, gzip for large bodies, a snapshot without
 * the server-only page text, and revalidated static files that keep their
 * security headers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {createApp} from '../src/app.js';
import {openStore} from '../src/sqlite-store.js';
import {slimRequest, slimRun} from '../src/routes-workflow.js';

function recorder() {
  return {
    status: null, headers: null, body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; return this; },
    end(body) { if (body !== undefined) this.body = body; },
  };
}
const request = (pathname, headers = {}) => ({method: 'GET', url: pathname, headers: {host: '127.0.0.1:4173', cookie: 'agent_session=abc', ...headers}});

async function seam() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-poll-'));
  const store = await openStore(path.join(dir, 'state.json'));
  const app = createApp({
    store,
    auth: {session: () => ({email: 'o@example.test', role: 'owner', userId: 'u1', workspaceId: 'w1'}), listWorkspaces: () => [{id: 'w1', name: 'W'}], roleOf: () => 'owner'},
    workspaces: {get: id => (id === 'w1' ? store : null)},
    push: {}, version: '0.0.0',
  });
  // Node sets `res.req` on every response; the recorder does the same.
  const call = async req => { const res = recorder(); res.req = req; await app.handler(req, res); return res; };
  return {store, call, async done() { await store.close(); await fs.rm(dir, {recursive: true, force: true}); }};
}

test('the snapshot carries an ETag, answers 304 while unchanged, and a write changes it', async () => {
  const t = await seam();
  try {
    const first = await t.call(request('/api/state'));
    assert.equal(first.status, 200);
    const etag = first.headers.ETag;
    assert.match(etag, /^W\/"/);
    const again = await t.call(request('/api/state', {'if-none-match': etag}));
    assert.equal(again.status, 304);
    assert.equal(again.body, null, 'a 304 has no body');
    assert.equal(again.headers['X-Content-Type-Options'], 'nosniff', 'security headers stay on a 304');
    await t.store.update(s => { s.settings.style = 'changed'; });
    const after = await t.call(request('/api/state', {'if-none-match': etag}));
    assert.equal(after.status, 200);
    assert.notEqual(after.headers.ETag, etag);
    assert.equal(JSON.parse(after.body).settings.style, 'changed');
  } finally { await t.done(); }
});

test('a large snapshot is gzipped for a client that accepts it, and only then', async () => {
  const t = await seam();
  try {
    await t.store.update(s => { s.chats = {c: Array.from({length: 200}, (_, i) => ({id: `m${i}`, at: new Date().toISOString(), role: 'user', text: 'hello '.repeat(20)}))}; });
    const plain = await t.call(request('/api/state'));
    assert.equal(plain.headers['Content-Encoding'], undefined);
    const packed = await t.call(request('/api/state', {'accept-encoding': 'gzip, deflate, br'}));
    assert.equal(packed.headers['Content-Encoding'], 'gzip');
    assert.equal(packed.headers.Vary, 'Accept-Encoding');
    assert.ok(packed.body.length < plain.body.length / 4, 'the body really shrank');
    const a = JSON.parse(zlib.gunzipSync(packed.body)), b = JSON.parse(plain.body);
    delete a.serverTime; delete b.serverTime;
    assert.deepEqual(a, b, 'the same snapshot either way');
  } finally { await t.done(); }
});

test('the snapshot leaves out captured pages and long step outputs; the store keeps them', async () => {
  const t = await seam();
  try {
    const page = 'p'.repeat(20000), output = 'o'.repeat(5000);
    await t.store.update(s => {
      s.browserRequests = [{id: 'b1', status: 'done', result: {title: 'T', text: 'summary', page}}, {id: 'b2', status: 'pending', result: null}];
      s.groupRuns = [{id: 'r1', groupId: 'g', input: 'x', recipients: [], mode: 'm', status: 'completed', trace: [{botId: 'a', output}, {botId: 'b', output: 'short'}], browserPage: page, task: {feedText: page, botIds: ['a']}}];
    });
    const snap = JSON.parse((await t.call(request('/api/state'))).body);
    const [done, pending] = snap.browserRequests;
    assert.equal(done.result.title, 'T');
    assert.equal(done.result.text, 'summary');
    assert.ok(done.result.page.length <= 200 && done.result.page.length > 0, 'a short excerpt, still truthy');
    assert.equal(pending.result, null);
    const run = snap.groupRuns[0];
    assert.equal(run.trace.length, 2, 'every step is still listed');
    assert.equal(run.trace[0].output.length, 600);
    assert.equal(run.trace[1].output, 'short');
    assert.ok(run.browserPage.length <= 200 && run.task.feedText.length <= 200);
    assert.deepEqual(run.task.botIds, ['a']);
    const stored = t.store.read();
    assert.equal(stored.browserRequests[0].result.page, page, 'the server copy is untouched');
    assert.equal(stored.groupRuns[0].trace[0].output, output);
    assert.equal(stored.groupRuns[0].task.feedText, page);
  } finally { await t.done(); }
});

test('slimming never mutates what it is given', () => {
  const request = Object.freeze({id: 'b', result: Object.freeze({page: 'x'.repeat(500)})});
  const run = Object.freeze({id: 'r', trace: Object.freeze([Object.freeze({output: 'y'.repeat(900)})]), task: Object.freeze({feedText: 'z'.repeat(500)})});
  assert.equal(slimRequest(request).result.page.length, 200);
  assert.equal(slimRun(run).trace[0].output.length, 600);
  assert.equal(slimRequest({id: 'n', result: null}).result, null);
});

test('the state route does not mutate the cached document', async () => {
  const t = await seam();
  try {
    await t.store.update(s => { s.browserRequests = [{id: 'b1', status: 'done', result: {page: 'p'.repeat(1000)}}]; });
    const before = JSON.stringify(t.store.peek());
    await t.call(request('/api/state'));
    assert.equal(JSON.stringify(t.store.peek()), before);
  } finally { await t.done(); }
});

test('static files are revalidated with an ETag, gzipped on request, and keep their headers', async () => {
  const t = await seam();
  try {
    const first = await t.call({method: 'GET', url: '/app.js?v=123', headers: {host: '127.0.0.1:4173'}});
    assert.equal(first.status, 200);
    assert.equal(first.headers['Cache-Control'], 'no-cache');
    assert.ok(first.headers.ETag);
    assert.ok(first.headers['Content-Security-Policy'], 'the CSP header is still sent');
    assert.equal(first.headers['X-Frame-Options'], 'DENY');
    const source = await fs.readFile(new URL('../shared/app.js', import.meta.url));
    assert.deepEqual(first.body, source, 'the file itself, uncompressed without Accept-Encoding');
    const again = await t.call({method: 'GET', url: '/app.js', headers: {host: '127.0.0.1:4173', 'if-none-match': first.headers.ETag}});
    assert.equal(again.status, 304);
    assert.equal(again.body, null);
    const packed = await t.call({method: 'GET', url: '/app.js', headers: {host: '127.0.0.1:4173', 'accept-encoding': 'gzip'}});
    assert.equal(packed.headers['Content-Encoding'], 'gzip');
    assert.deepEqual(zlib.gunzipSync(packed.body), source);
  } finally { await t.done(); }
});
