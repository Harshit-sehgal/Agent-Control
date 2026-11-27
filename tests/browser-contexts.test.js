import test from 'node:test';
import assert from 'node:assert/strict';
import {cookieParams, startBrowserSession} from '../agent/browser.mjs';
import {fakeCdp} from './fake-cdp.js';

/* Phase 2: one browser context per account, and its cookies moved whole.
 * The session code runs against the scripted DevTools connection: no Chrome. */

const CRM = 'https://crm.example.com/';
const ALLOW = ['crm.example.com'];
const WHO = {name: 'who', value: 'alice', domain: 'crm.example.com', path: '/', httpOnly: true, expires: -1, size: 8, session: true};
const crmPages = () => ({[CRM]: ({cookies}) => ({title: cookies.some(c => c.name === 'who') ? 'Signed in' : 'Sign in', text: '…'})});
const titleIn = async (session, tab) => (await session.capture(CRM, {allow: ALLOW, tab, settleMs: 0})).title;

test('a tab in a context sees only that context\'s cookies, and cookies move between contexts whole', async () => {
  const fake = fakeCdp({pages: crmPages()});
  const session = await startBrowserSession({connection: fake.connection});
  const a = await session.createContext(), b = await session.createContext();
  fake.setCookie(a, WHO);
  const tabB = await session.newTab({allow: ALLOW, browserContextId: b});
  assert.equal(tabB.browserContextId, b);
  assert.equal(await titleIn(session, tabB), 'Sign in');
  await session.setCookies(b, await session.getCookies(a));
  assert.equal(await titleIn(session, tabB), 'Signed in');
  assert.deepEqual(Object.keys(cookieParams([{name: 'who', value: 'a', expires: -1, size: 8, session: true}])[0]).sort(), ['name', 'value']);
  assert.equal((await session.liveTargets()).find(t => t.targetId === tabB.targetId).browserContextId, b);
});

test('a tab in one context never sees another context\'s cookies, and the default context sees none of them', async () => {
  const fake = fakeCdp({pages: crmPages()});
  const session = await startBrowserSession({connection: fake.connection});
  const a = await session.createContext();
  fake.setCookie(a, WHO);
  const tabA = await session.newTab({allow: ALLOW, browserContextId: a});
  const plain = await session.newTab({allow: ALLOW});
  assert.equal(plain.browserContextId, null, 'a tab with no context is in the default one');
  assert.equal(await titleIn(session, tabA), 'Signed in');
  assert.equal(await titleIn(session, plain), 'Sign in');
  assert.deepEqual((await session.getCookies(a)).map(c => c.name), ['who']);
});

test('a tab in the default context asks for no context, so a browser with none behaves as before', async () => {
  const fake = fakeCdp();
  const session = await startBrowserSession({connection: fake.connection});
  await session.newTab({allow: ALLOW});
  assert.equal('browserContextId' in fake.called('Target.createTarget')[0].params, false);
});

test('disposing a context removes it and its tabs, and a second dispose is an error the caller can see', async () => {
  const fake = fakeCdp();
  const session = await startBrowserSession({connection: fake.connection});
  const a = await session.createContext(), b = await session.createContext();
  const tabA = await session.newTab({allow: ALLOW, browserContextId: a});
  const tabB = await session.newTab({allow: ALLOW, browserContextId: b});
  assert.deepEqual(fake.contexts().sort(), [a, b].sort());
  await session.disposeContext(a);
  assert.deepEqual(fake.contexts(), [b]);
  const left = (await session.liveTargets()).map(t => t.targetId);
  assert.equal(left.includes(tabA.targetId), false);
  assert.equal(left.includes(tabB.targetId), true);
  await assert.rejects(() => session.disposeContext(a), /context/i);
  await assert.rejects(() => session.getCookies(a), /context/i);
});

test('setCookies sends only what Storage.setCookies accepts, and keeps a persistent cookie\'s expiry', async () => {
  const fake = fakeCdp();
  const session = await startBrowserSession({connection: fake.connection});
  const id = await session.createContext();
  await session.setCookies(id, [
    {...WHO, expires: -1},
    {name: 'keep', value: 'x', domain: '.example.com', path: '/', secure: true, httpOnly: false, sameSite: 'Lax', expires: 4102444800, size: 5, session: false, priority: 'Medium', sourceScheme: 'Secure', sourcePort: 443},
  ]);
  const sent = fake.called('Storage.setCookies')[0].params;
  assert.equal(sent.browserContextId, id);
  assert.deepEqual(sent.cookies.map(c => c.name), ['who', 'keep']);
  assert.equal('expires' in sent.cookies[0], false, 'a session cookie carries no expiry');
  assert.equal(sent.cookies[1].expires, 4102444800);
  for (const cookie of sent.cookies) for (const key of ['size', 'session']) assert.equal(key in cookie, false, `${key} is not a CookieParam`);
  assert.deepEqual((await session.getCookies(id)).map(c => c.name), ['who', 'keep']);
});

test('cookieParams keeps the fields a CookieParam has, and drops what it has not', () => {
  const full = {name: 'n', value: 'v', domain: 'a.example.com', path: '/p', secure: true, httpOnly: true, sameSite: 'Strict', expires: 1900000000.5, priority: 'High', sourceScheme: 'Secure', sourcePort: 443, partitionKey: {topLevelSite: 'https://a.example.com', hasCrossSiteAncestor: false}, size: 2, session: false, sameParty: false};
  const [out] = cookieParams([full]);
  assert.deepEqual(Object.keys(out).sort(), ['domain', 'expires', 'httpOnly', 'name', 'partitionKey', 'path', 'priority', 'sameSite', 'secure', 'sourcePort', 'sourceScheme', 'value']);
  assert.deepEqual(out.partitionKey, full.partitionKey);
  assert.equal('expires' in cookieParams([{name: 'a', value: 'b'}])[0], false, 'a missing expiry stays missing');
  assert.equal('expires' in cookieParams([{name: 'a', value: 'b', expires: -1}])[0], false);
  assert.equal(cookieParams([{name: 'a', value: '', domain: 'x.com'}]).length, 1, 'an empty value is still a value');
  assert.deepEqual(cookieParams([{name: 'a'}, {value: 'b'}, {name: 1, value: 'b'}, {name: 'a', value: 2}, null, 'x', {name: 'ok', value: 'v'}]).map(c => c.name), ['ok']);
  assert.deepEqual(cookieParams(undefined), []);
  assert.deepEqual(cookieParams(null), []);
});
