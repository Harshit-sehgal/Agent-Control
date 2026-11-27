import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {findBrowser, startBrowserSession} from '../agent/browser.mjs';
import {createSharedBrowser} from '../agent/shared-browser.mjs';
import {createJarStore} from '../agent/account-jars.mjs';
import {signinPage} from '../shared/bot-browser.js';

/* Real Chrome, no scripted DevTools: two bots signed in to two accounts of one site each read their own, and
 * both are still signed in after the shared browser is closed and a new one is started on the same profile,
 * jar folder and secret. Hosted CI restricts Chrome's sandbox, so there this is skipped. */

const A = '0a1b2c3d-0000-4000-8000-00000000000a';
const B = '0a1b2c3d-0000-4000-8000-00000000000b';
const SECRET = 'chrome-test-pairing-secret';
const browser = process.env.CI ? null : findBrowser();

/** A site on loopback. `/login?as=<name>` signs that name in with a cookie nothing in a page can read; `/` says who. */
function startSite() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const who = /(?:^|;\s*)who=([a-z]+)/.exec(req.headers.cookie || '')?.[1];
      if (url.pathname === '/login') {
        const name = (url.searchParams.get('as') || '').replace(/[^a-z]/g, '');
        // A session cookie: no Max-Age, so only a jar (not Chrome's own profile) can bring it back.
        return res.writeHead(200, {'Content-Type': 'text/html', 'Set-Cookie': `who=${name}; HttpOnly; Path=/`}).end(`<title>Logged in</title><p>Welcome ${name}</p>`);
      }
      res.writeHead(200, {'Content-Type': 'text/html'}).end(who
        ? `<title>Home</title><p>Signed in as ${who}</p>`
        : '<title>Sign in</title><p>Please sign in</p><input type="password" name="pw">');
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('two bots signed in to two accounts of one site each see their own, and both are still signed in after a restart', {skip: !browser && 'no browser installed', timeout: 90000}, async t => {
  const site = await startSite();
  t.after(() => site.close());
  const base = `http://127.0.0.1:${site.address().port}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ba-chrome-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const profile = path.join(root, 'profile'), dir = path.join(root, 'jars');
  const open = () => createSharedBrowser({
    start: opts => startBrowserSession({...opts, binary: browser, permit: (host, address) => address === '127.0.0.1'}),
    allow: ['127.0.0.1'], profile, jars: createJarStore({dir, secret: SECRET}),
  });
  const accounts = [{id: A, site: '127.0.0.1'}, {id: B, site: '127.0.0.1'}];

  let shared = open();
  t.after(() => shared.close());
  await shared.setAccounts(accounts);
  await shared.run('scout', {url: `${base}/login?as=alice`, account: A});
  await shared.run('writer', {url: `${base}/login?as=bob`, account: B});
  const [scout, writer] = [await shared.run('scout', {url: `${base}/`, account: A}), await shared.run('writer', {url: `${base}/`, account: B})];
  assert.match(scout.text, /Signed in as alice/);
  assert.match(writer.text, /Signed in as bob/);
  assert.doesNotMatch(scout.text, /bob/);
  assert.doesNotMatch(writer.text, /alice/);
  const atlas = await shared.run('atlas', {url: `${base}/`});
  assert.match(atlas.text, /Please sign in/, 'a bot with no account is nobody in particular');
  assert.equal(signinPage(atlas), '127.0.0.1', 'and its page reads as a sign-in page');

  // Closing keeps every account's cookies; a new shared browser on the same folders restores them.
  await shared.close();
  assert.equal(createJarStore({dir, secret: SECRET}).ids().sort().join(), [A, B].sort().join(), 'each account has a jar');
  for (const name of fs.readdirSync(dir)) assert.doesNotMatch(fs.readFileSync(path.join(dir, name), 'utf8'), /alice|bob/, 'a jar holds no cookie in the clear');

  shared = open();
  await shared.setAccounts(accounts);
  const again = [await shared.run('scout', {url: `${base}/`, account: A}), await shared.run('writer', {url: `${base}/`, account: B})];
  assert.match(again[0].text, /Signed in as alice/);
  assert.match(again[1].text, /Signed in as bob/);
  await shared.sweep();
  assert.deepEqual(shared.accountStates().map(s => [s.id, s.state]).sort(), [[A, 'signed-in'], [B, 'signed-in']].sort());
});
