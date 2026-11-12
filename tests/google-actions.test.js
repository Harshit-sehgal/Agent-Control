/** The Gmail and Drive actions (Phase 6, Task 3), against the fake Google.
 *
 * Reads return bounded text. Writes build the message here, from validated
 * parts, so a bot cannot add a header, a Bcc or a path of its own. The access
 * token only ever goes to Google's own address, and an expired one is refreshed
 * once, never looped.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {callGoogle} from '../src/google-actions.js';
import {connect, rig} from './google-rig.js';
import {GOOGLE_ACTIONS, describeCall, connectorNeeds} from '../shared/connectors.js';

async function ready(t) {
  const r = await rig(t);
  await connect(r);
  const connector = () => r.store.read().connectors.find(c => c.id === 'google');
  const use = (tool, args) => callGoogle(r.store, connector(), tool, args);
  const sent = () => r.google.state.sent.map(m => Buffer.from(m.raw, 'base64url').toString('utf8'));
  return {...r, use, connector, sent};
}

test('gmail.search lists a few messages with sender, subject, date and a snippet, from metadata only', async t => {
  const r = await ready(t);
  const out = await r.use('gmail.search', {query: 'from:pat newer_than:7d', max: 2});
  assert.equal(out.ok, true);
  assert.match(out.text, /m1abc/);
  assert.match(out.text, /Pat <pat@example\.org>/);
  assert.match(out.text, /Subject of m1abc/);
  assert.match(out.text, /A short snippet/);
  const list = r.google.calls('/gmail/v1/users/me/messages').find(l => l.path === '/gmail/v1/users/me/messages');
  assert.equal(list.query.get('q'), 'from:pat newer_than:7d');
  assert.equal(list.query.get('maxResults'), '2');
  for (const get of r.google.log.filter(l => /messages\/m/.test(l.path))) assert.equal(get.query.get('format'), 'metadata', 'a search never downloads bodies');
  await r.use('gmail.search', {query: 'x', max: 500});
  assert.equal(r.google.calls('/gmail/v1/users/me/messages').filter(l => l.path === '/gmail/v1/users/me/messages').at(-1).query.get('maxResults'), '10', 'the count is capped');
  await assert.rejects(r.use('gmail.search', {}), /query/i);
});

test('gmail.read returns headers and the plain text part; html-only mail is stripped; long mail is cut', async t => {
  const r = await ready(t);
  const plain = await r.use('gmail.read', {id: 'm1abc'});
  assert.match(plain.text, /^From: Pat <pat@example\.org>/m);
  assert.match(plain.text, /Subject: Subject of m1abc/);
  assert.match(plain.text, /Hello owner\./);
  assert.doesNotMatch(plain.text, /<p>/, 'the plain part, not the html');
  const html = await r.use('gmail.read', {id: 'htmlonly'});
  assert.match(html.text, /Hello there/);
  assert.doesNotMatch(html.text.split('\n\n').slice(1).join('\n\n'), /<|alert\(1\)/, 'tags and scripts are gone from the body');
  const huge = await r.use('gmail.read', {id: 'huge'});
  assert.ok(huge.text.length < 9000);
  assert.match(huge.text, /\[cut:/);
  for (const bad of ['../../etc', 'a/b', '', 'x'.repeat(200), 'm1?alt=media', undefined]) await assert.rejects(r.use('gmail.read', {id: bad}), /id/i, String(bad));
});

test('gmail.draft and gmail.send build the message from validated parts: no header or Bcc of the bot\'s own', async t => {
  const r = await ready(t);
  const sentOut = await r.use('gmail.send', {to: 'bob@example.org', subject: 'Lunch\r\nBcc: spy@evil.test', body: 'See you at noon.\nBcc: not-a-header@example.org'});
  assert.equal(sentOut.ok, true);
  assert.match(sentOut.text, /Sent/);
  const [mime] = r.sent();
  const [head, ...rest] = mime.split('\r\n\r\n');
  assert.match(head, /^To: bob@example\.org\r\n/);
  assert.match(head, /Subject: Lunch Bcc: spy@evil\.test\r\n/, 'a line break in the subject cannot start a header');
  assert.doesNotMatch(head, /^Bcc:/m);
  assert.match(head, /MIME-Version: 1\.0/);
  assert.match(head, /Content-Type: text\/plain; charset="UTF-8"/);
  assert.equal(Buffer.from(rest.join('\r\n\r\n').replace(/\r\n/g, ''), 'base64').toString('utf8'), 'See you at noon.\nBcc: not-a-header@example.org');
  // Draft: saved, not sent.
  const draft = await r.use('gmail.draft', {to: ['a@example.org', 'b@example.org'], cc: 'c@example.org', subject: 'Ünïcode ✓', body: 'Hi'});
  assert.match(draft.text, /Draft saved/);
  assert.equal(r.google.state.sent.length, 1);
  const raw = Buffer.from(r.google.state.drafts[0].message.raw, 'base64url').toString('utf8');
  assert.match(raw, /^To: a@example\.org, b@example\.org\r\nCc: c@example\.org\r\n/);
  assert.match(raw, /Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/);
});

test('recipients, subject and body are validated before anything is sent', async t => {
  const r = await ready(t);
  const bad = (args, re) => assert.rejects(r.use('gmail.send', {subject: 's', body: 'b', to: 'a@example.org', ...args}), re);
  await bad({to: ''}, /to/i);
  await bad({to: 'not an address'}, /address/i);
  await bad({to: 'a@example.org, evil@x'}, /address/i);
  await bad({to: 'Bob <bob@example.org>'}, /address/i);
  await bad({to: 'a@example.org\nBcc: x@example.org'}, /address/i);
  await bad({to: Array.from({length: 11}, (_, i) => `u${i}@example.org`)}, /at most 10/i);
  await bad({cc: 'nope'}, /address/i);
  await bad({subject: ''}, /subject/i);
  await bad({subject: 'x'.repeat(300)}, /subject/i);
  await bad({body: ''}, /body/i);
  await bad({body: 'x'.repeat(30000)}, /body/i);
  await bad({body: 5}, /body/i);
  assert.deepEqual(r.google.state.sent, [], 'nothing went out');
});

test('drive.search escapes the words it puts in the query; drive.read exports docs and sheets and refuses binaries', async t => {
  const r = await ready(t);
  const found = await r.use('drive.search', {query: `Bob's \\ lease`});
  assert.match(found.text, /Lease/);
  assert.match(found.text, /f1_doc/);
  const search = r.google.calls('/drive/v3/files').find(l => l.path === '/drive/v3/files');
  assert.equal(search.query.get('q'), "fullText contains 'Bob\\'s \\\\ lease' and trashed = false");
  await assert.rejects(r.use('drive.search', {}), /query/i);
  const doc = await r.use('drive.read', {id: 'f1_doc'});
  assert.match(doc.text, /Lease text/);
  assert.equal(r.google.log.find(l => /f1_doc\/export/.test(l.path)).query.get('mimeType'), 'text/plain');
  assert.match((await r.use('drive.read', {id: 'f3_sheet'})).text, /a,b\n1,2/);
  assert.equal(r.google.log.find(l => /f3_sheet\/export/.test(l.path)).query.get('mimeType'), 'text/csv');
  assert.match((await r.use('drive.read', {id: 'f4_txt'})).text, /plain file text/);
  assert.match((await r.use('drive.read', {id: 'f2_pdf'})).text, /cannot be read as text/);
  const big = await r.use('drive.read', {id: 'f5_big'});
  assert.ok(big.text.length < 9000);
  assert.match(big.text, /\[cut:/);
  await assert.rejects(r.use('drive.read', {id: 'f9_missing'}), /not found/i);
  for (const bad of ['../x', 'a b', '', undefined]) await assert.rejects(r.use('drive.read', {id: bad}), /id/i);
});

test('an expired access token is refreshed once and the call retried; a revoked one reports reconnect', async t => {
  const r = await ready(t);
  r.google.expireAccess();
  assert.match((await r.use('gmail.read', {id: 'm1abc'})).text, /Hello owner/, 'the 401 was absorbed');
  assert.equal(r.google.calls('/token').filter(l => /refresh_token/.test(l.raw)).length, 1);
  r.google.expireAccess();
  r.google.revokeRefresh();
  await assert.rejects(r.use('gmail.read', {id: 'm1abc'}), error => error.code === 'reconnect');
  assert.equal(r.connector().status, 'reconnect');
});

test('a refusal from Google is reported with its reason; the token goes only to the configured address', async t => {
  const r = await ready(t);
  r.google.state.apiStatus = 403;
  await assert.rejects(r.use('gmail.read', {id: 'm1abc'}), error => /Google refused/.test(error.message) && /Insufficient Permission/.test(error.message) && !/at-\d+/.test(error.message));
  r.google.state.apiStatus = 0;
  for (const call of r.google.log.filter(l => l.headers.authorization)) assert.equal(call.headers.host, new URL(r.google.base).host);
  await assert.rejects(r.use('nothing.here', {}), /no tool/i);
  assert.deepEqual(GOOGLE_ACTIONS.map(a => a.name), ['gmail.search', 'gmail.read', 'gmail.draft', 'gmail.send', 'drive.search', 'drive.read']);
});

test('an ask for a Google action says what it would do, with the recipient, the subject and the start of the body', () => {
  const google = {id: 'google', kind: 'google', name: 'Google', account: 'owner@example.test', actions: GOOGLE_ACTIONS};
  assert.equal(describeCall(google, 'gmail.send', {to: 'bob@example.org', subject: 'Lunch', body: 'See you at noon.'}), 'send an email to bob@example.org (outside your domain): "Lunch" (See you at noon.)');
  assert.equal(describeCall(google, 'gmail.draft', {to: ['a@example.org', 'b@example.org'], subject: 'Hi', body: 'x'.repeat(300)}).startsWith('save a draft email to a@example.org (outside your domain), b@example.org (outside your domain): "Hi" (xxx'), true);
  assert.ok(describeCall(google, 'gmail.send', {to: 'a@b.co', subject: 's'.repeat(300), body: 'b'.repeat(900)}).length <= 280);
  assert.equal(describeCall(google, 'gmail.search', {query: 'rent'}), 'search Gmail for "rent"');
  assert.equal(describeCall(google, 'gmail.read', {id: 'abc'}), 'read an email in Gmail');
  assert.equal(describeCall(google, 'drive.search', {query: 'lease'}), 'search Drive for "lease"');
  assert.equal(describeCall(google, 'drive.read', {id: 'abc'}), 'read a file in Drive');
  assert.deepEqual(connectorNeeds(google, 'gmail.send', {to: 'a@b.co', subject: 's', body: 'b'}).map(n => [n.action, n.target]), [['connector.google.write.gmail.send', 'owner@example.test']]);
  assert.equal(connectorNeeds(google, 'gmail.search', {query: 'x'})[0].action, 'connector.google.read');
});
