/** The server-owned browser runtime: one Chromium, one page at a time, started
 * on demand and closed after an idle spell. These tests inject the launch, so
 * they run without a browser installed; the last one uses a real browser. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {findBrowser} from '../agent/browser.mjs';
import {browserAllowlist, createBrowserRuntime, runtimeMode} from '../src/browser-runtime.js';

const env = extra => ({AGENT_BROWSER_ALLOWLIST: 'example.com', ...extra});
const never = async () => assert.fail('a browser must not be launched here');

/** A fake session, and the launches that produced it. */
function harness({fail = null, idleMs = '30', ...extra} = {}) {
  const launches = [], log = [];
  const start = async options => {
    launches.push(options);
    return {
      capture: async (url, opts) => {
        if (fail) throw fail;
        log.push(['capture', url, opts.allow]);
        return {url, text: `page: ${url}`};
      },
      close: async () => { log.push(['close']); },
    };
  };
  const runtime = createBrowserRuntime({env: env({BROWSER_IDLE_MS: idleMs, ...extra}), start, find: () => '/usr/bin/chrome'});
  return {runtime, launches, log};
}

test('BROWSER_RUNTIME and the allowlist are read leniently, and spelled one way', () => {
  assert.equal(runtimeMode({}), 'auto');
  assert.equal(runtimeMode({BROWSER_RUNTIME: ' SERVER '}), 'server');
  assert.equal(runtimeMode({BROWSER_RUNTIME: 'nonsense'}), 'auto', 'An unknown value is not a guess.');
  assert.deepEqual(browserAllowlist({AGENT_BROWSER_ALLOWLIST: ' X.com. , docs.example.com:8443 ,, '}), ['x.com', 'docs.example.com']);
  assert.deepEqual(browserAllowlist({}), []);
});

test('with no browser, or no allowlist, the request is refused rather than attempted', async () => {
  const noBrowser = createBrowserRuntime({env: env({}), start: never, find: () => null});
  assert.equal(noBrowser.available(), false);
  await assert.rejects(noBrowser.run({url: 'https://example.com/a'}), error => error.status === 503 && /No browser is available/.test(error.message));
  await noBrowser.close();

  const serverMode = createBrowserRuntime({env: {BROWSER_RUNTIME: 'server'}, start: never, find: () => '/usr/bin/chrome'});
  assert.equal(serverMode.available(), false);
  await assert.rejects(serverMode.run({url: 'https://example.com/a'}), error => error.status === 503 && /no browser or allowlist is configured/.test(error.message));
  await serverMode.close();
});

test('mode agent never starts a browser of its own', async () => {
  const {runtime, launches} = harness({BROWSER_RUNTIME: 'agent'});
  assert.equal(runtime.mode, 'agent');
  assert.equal(runtime.available(), false);
  await assert.rejects(runtime.run({url: 'https://example.com/a'}), error => error.status === 503);
  assert.deepEqual(launches, [], 'A device-only install does not launch Chromium.');
  await runtime.close();
});

test('one browser serves every request and is closed after the idle spell', async () => {
  const {runtime, launches, log} = harness();
  assert.equal(runtime.available(), true);
  assert.equal((await runtime.run({url: 'https://example.com/a'})).text, 'page: https://example.com/a');
  assert.equal((await runtime.run({url: 'https://example.com/b'})).text, 'page: https://example.com/b');
  assert.equal(launches.length, 1, 'The launch cost is paid once per burst, not per page.');
  assert.equal(runtime.open, true);
  assert.deepEqual(log.map(entry => entry[0]), ['capture', 'capture'], 'Nothing was closed between pages.');
  assert.deepEqual(log[0][2], ['example.com'], 'The parsed allowlist reaches the capture.');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(runtime.open, false, 'An idle runtime releases the browser.');
  assert.deepEqual(log.at(-1), ['close']);
  await runtime.close();
});

test('requests are serial, so two bots never share a page', async () => {
  const order = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const runtime = createBrowserRuntime({
    env: env({}),
    find: () => '/usr/bin/chrome',
    start: async () => ({
      capture: async url => { order.push(`start ${url}`); if (url.endsWith('a')) await gate; order.push(`end ${url}`); return {url}; },
      close: async () => {},
    }),
  });
  const first = runtime.run({url: 'https://example.com/a'});
  // Give the first request every chance to be in flight before the second one.
  await new Promise(resolve => setTimeout(resolve, 20));
  const second = runtime.run({url: 'https://example.com/b'});
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['start https://example.com/a', 'end https://example.com/a', 'start https://example.com/b', 'end https://example.com/b']);
  await runtime.close();
});

test('a capture that fails relaunches the browser for the next request', async () => {
  const launch = {count: 0};
  const runtime = createBrowserRuntime({
    env: env({}),
    find: () => '/usr/bin/chrome',
    start: async () => {
      launch.count += 1;
      const dying = launch.count === 1;
      return {capture: async url => { if (dying) throw new Error('The browser died.'); return {url}; }, close: async () => {}};
    },
  });
  await assert.rejects(runtime.run({url: 'https://example.com/a'}), /died/);
  assert.equal(runtime.open, false, 'A failed session is dropped, not reused.');
  assert.equal((await runtime.run({url: 'https://example.com/b'})).url, 'https://example.com/b');
  assert.equal(launch.count, 2);
  await runtime.close();
});

test('a page that takes longer than the idle window is not cut off', async () => {
  const closedAt = [];
  const runtime = createBrowserRuntime({
    env: env({BROWSER_IDLE_MS: '30'}),
    find: () => '/usr/bin/chrome',
    start: async () => ({
      capture: async url => { await new Promise(resolve => setTimeout(resolve, 60)); return {url}; },
      close: async () => { closedAt.push(Date.now()); },
    }),
  });
  // The first request arms the idle clock; the second starts before it fires and
  // runs longer than it. Neither may lose its browser, and the process stays up
  // until both are done.
  assert.equal((await runtime.run({url: 'https://example.com/first'})).url, 'https://example.com/first');
  assert.equal((await runtime.run({url: 'https://example.com/slow'})).url, 'https://example.com/slow');
  assert.equal(closedAt.length, 0, 'Nothing closed the process while a page was open.');
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(closedAt.length, 1, 'The idle clock only starts once no request is left.');
  await runtime.close();
});

test('closing the runtime stops accepting work and finishes the open browser', async () => {
  const {runtime, log} = harness();
  await runtime.run({url: 'https://example.com/a'});
  await runtime.close();
  assert.equal(runtime.open, false);
  assert.deepEqual(log.at(-1), ['close']);
  await assert.rejects(runtime.run({url: 'https://example.com/a'}), error => error.status === 503);
});

test('closing the runtime waits for the request already in flight', async () => {
  let finished = false;
  const runtime = createBrowserRuntime({
    env: env({}),
    find: () => '/usr/bin/chrome',
    start: async () => ({
      capture: async url => { await new Promise(resolve => setTimeout(resolve, 60)); finished = true; return {url}; },
      close: async () => {},
    }),
  });
  const inFlight = runtime.run({url: 'https://example.com/a'});
  await new Promise(resolve => setTimeout(resolve, 20));
  await runtime.close();
  assert.equal(finished, true, 'A drain does not kill a page it is still serving.');
  assert.equal((await inFlight).url, 'https://example.com/a');
});

test('the runtime reads a real page through a real browser', {skip: !findBrowser() && 'no browser installed', timeout: 60000}, async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, {'Content-Type': 'text/html'});
    res.end('<title>Runtime</title><button id="go">Press me</button><p id="body">body text</p>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  // A loopback page on purpose, in a test: the default policy would refuse it.
  const before = process.env.AGENT_ALLOW_PRIVATE;
  process.env.AGENT_ALLOW_PRIVATE = '1';
  const runtime = createBrowserRuntime({env: {AGENT_BROWSER_ALLOWLIST: '127.0.0.1', BROWSER_IDLE_MS: '200'}, find: () => findBrowser()});
  try {
    assert.equal(runtime.available(), true);
    const page = await runtime.run({url});
    assert.equal(page.title, 'Runtime');
    assert.match(page.text, /body text/);
    assert.ok(page.elements.some(e => e.text === 'Press me'), `the controls came back: ${JSON.stringify(page.elements)}`);
    // The allowlist is checked before the browser is handed a URL.
    await assert.rejects(runtime.run({url: 'https://example.com/'}), /not in AGENT_BROWSER_ALLOWLIST/);
    // One process serves both pages, and each still gets a fresh context.
    const second = await runtime.run({url, steps: [{op: 'read', selector: '#body'}]});
    assert.equal(runtime.open, true, 'The warm process is reused.');
    assert.equal(second.actions[0].text, 'body text');
  } finally {
    await runtime.close();
    if (before === undefined) delete process.env.AGENT_ALLOW_PRIVATE;
    else process.env.AGENT_ALLOW_PRIVATE = before;
    server.close();
  }
});
