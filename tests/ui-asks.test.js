import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {askCard, grantRows, allGrantRows, grantWhat, pauseBanner, PAUSE_TEXT, grantUrl, scopeOfAction} from '../shared/ui-asks.js';

const bot = (id, name, settings = {}, extra = {}) => ({id, name, instructions: `${name} does a job.`, settings, ...extra});
const atlas = bot('atlas', 'Atlas', {lead: true});
const mail = bot('mail', 'Mailroom', {reportsTo: 'atlas'});
const quill = bot('quill', 'Quill', {reportsTo: 'atlas'}, {permissions: ['browser.use', 'bot.ask']});
const stateOf = (extra = {}) => ({groups: [{id: 'home', name: 'Home', settings: {}, bots: [atlas, mail, quill]}], asks: [], grants: [], chats: {}, ...extra});
const ask = (extra = {}) => ({id: 'a1', botId: 'mail', runId: 'r1', chatKey: 'mail', action: 'send', target: '', detail: 'send an email to Northwind', grantScope: '', status: 'pending', scope: null, createdAt: '2026-11-11T10:00:00Z', ...extra});
const line = (extra = {}) => ({id: 'ask-a1', role: 'system', kind: 'ask', askId: 'a1', text: 'Mailroom wants to send an email to Northwind.', ...extra});

// ---- the card ----

test('a pending ask is an open card: its sentence, the asking bot, and the three buttons in the owner\'s words', () => {
  const card = askCard(stateOf({asks: [ask()]}), line());
  assert.equal(card.open, true);
  assert.equal(card.botId, 'mail');
  assert.equal(card.botName, 'Mailroom');
  assert.equal(card.text, 'Mailroom wants to send an email to Northwind.');
  assert.deepEqual(card.choices.map(c => [c.id, c.label]), [['allow', 'Allow once'], ['always', 'Always allow'], ['decline', "Don't allow"]]);
  assert.deepEqual(card.choices.map(c => c.primary), [true, false, false], 'Allow once is the one raised button');
});

test('the card asks a question the owner answers: "Let Mailroom send an email to Northwind?"', () => {
  assert.equal(askCard(stateOf({asks: [ask()]}), line()).question, 'Let Mailroom send an email to Northwind?');
  const page = askCard(stateOf({asks: [ask({action: 'browser.use', target: 'https://example.com/a', detail: 'open example.com'})]}), line());
  assert.equal(page.question, 'Let Mailroom open example.com?');
  // No detail: the page it wants, else the action, still as a question.
  assert.equal(askCard(stateOf({asks: [ask({action: 'browser.use', target: 'https://example.com/a', detail: ''})]}), line()).question, 'Let Mailroom open https://example.com/a?');
  assert.equal(askCard(stateOf({asks: [ask({detail: ''})]}), line()).question, 'Let Mailroom do this: send?');
  // The copy in the primary's chat asks the same question about the asking bot.
  assert.equal(askCard(stateOf({asks: [ask()]}), line({text: 'Needs you: Mailroom wants to send an email to Northwind.'})).question, 'Let Mailroom send an email to Northwind?');
});

test('a payment asks only Allow once or Don\'t allow, and says it asks every time', () => {
  const card = askCard(stateOf({asks: [ask({action: 'spend', detail: 'pay £40 at Northwind'})]}), line());
  assert.deepEqual(card.choices.map(c => [c.id, c.label]), [['allow', 'Allow once'], ['decline', "Don't allow"]]);
  assert.equal(card.choices[0].primary, true);
  assert.match(card.note, /payment/i);
  assert.equal(askCard(stateOf({asks: [ask()]}), line()).note, '');
});

test('a page ask shows the page it wants', () => {
  const card = askCard(stateOf({asks: [ask({action: 'browser.use', target: 'https://example.com/a', detail: 'open example.com'})]}), line());
  assert.equal(card.target, 'https://example.com/a');
});

test('an answered card collapses to the one muted line', () => {
  const once = askCard(stateOf({asks: [ask({status: 'allowed', scope: 'once'})]}), line());
  assert.deepEqual([once.open, once.text, once.choices], [false, 'You allowed it once', []]);
  assert.equal(askCard(stateOf({asks: [ask({status: 'allowed', scope: 'always'})]}), line()).text, 'You always allow it for this bot');
  assert.equal(askCard(stateOf({asks: [ask({status: 'declined', scope: 'once'})]}), line()).text, 'You declined it');
  assert.match(askCard(stateOf({asks: [ask({status: 'declined', expired: true})]}), line()).text, /24 hours/);
});

test('an ask that is not in the state reads as answered, never as a card that does nothing', () => {
  const card = askCard(stateOf(), line());
  assert.equal(card.open, false);
  assert.equal(card.text, 'Answered');
});

test('the copy in the primary\'s chat names the bot once it is answered, and keeps the asking bot\'s face open', () => {
  const copy = line({text: 'Needs you: Mailroom wants to send an email to Northwind.'});
  assert.equal(askCard(stateOf({asks: [ask()]}), copy).botId, 'mail', 'the face above the card is the asking bot, not Atlas');
  assert.equal(askCard(stateOf({asks: [ask({status: 'allowed', scope: 'once'})]}), copy).text, 'You allowed it once (Mailroom)');
  assert.equal(askCard(stateOf({asks: [ask({status: 'allowed', scope: 'once'})]}), line()).text, 'You allowed it once');
});

// ---- grants ----

const grant = (extra = {}) => ({botId: 'mail', action: 'send', scope: '', choice: 'always', at: '2026-11-11T10:00:00Z', ...extra});

test('a bot\'s grants list what it may do, each with the three choices and the current one marked', () => {
  const rows = grantRows(stateOf({grants: [grant(), grant({action: 'browser.use', scope: 'https://example.com', choice: 'deny'})]}), 'mail');
  assert.deepEqual(rows.map(r => [r.label, r.choice]), [['Open example.com', 'deny'], ['Send', 'always']], 'pages first, then in the order the actions are asked');
  assert.deepEqual(rows[0].choices.map(c => [c.id, c.label, c.on]), [['always', 'Always allow', false], ['ask', 'Ask each time', false], ['deny', 'Deny', true]]);
  assert.equal(rows[0].scope, 'https://example.com');
  assert.equal(rows[0].botName, 'Mailroom');
});

test('spend never offers Always allow, even if a stored grant says so', () => {
  const rows = grantRows(stateOf({grants: [grant({action: 'spend', choice: 'deny'})]}), 'mail');
  assert.deepEqual(rows[0].choices.map(c => c.id), ['ask', 'deny']);
  const doctored = grantRows(stateOf({grants: [grant({action: 'spend', choice: 'always'})]}), 'mail');
  assert.equal(doctored[0].choice, 'ask', 'a stored Always allow for a payment reads as Ask each time');
});

test('grants of a bot that is gone, or of another bot, are not listed', () => {
  const s = stateOf({grants: [grant({botId: 'ghost'}), grant({botId: 'quill', action: 'post'})]});
  assert.deepEqual(grantRows(s, 'mail'), []);
  assert.deepEqual(allGrantRows(s).map(r => `${r.botId}:${r.label}`), ['quill:Post'], 'only Quill\'s own post rule');
});

test('a permission a bot held before asks existed is not a rule: only grants are listed', () => {
  assert.deepEqual(grantRows(stateOf(), 'quill'), [], 'bot.permissions is never shown, read-only or otherwise');
  assert.deepEqual(grantRows(stateOf({grants: [grant({botId: 'quill', action: 'browser.use', scope: 'https://a.com', choice: 'ask'})]}), 'quill').map(r => r.label), ['Open a.com']);
});

test('every grant across bots comes in roster order', () => {
  const rows = allGrantRows(stateOf({grants: [grant({botId: 'quill', action: 'post'}), grant({botId: 'quill', action: 'browser.use'}), grant()]}));
  assert.deepEqual(rows.map(r => `${r.botId}:${r.label}`), ['mail:Send', 'quill:Open web pages', 'quill:Post']);
});

test('the words of an action: a site, a connector account, and the plain ones', () => {
  assert.equal(grantWhat('browser.use', 'https://news.example.com'), 'Open news.example.com');
  assert.equal(grantWhat('browser.use', ''), 'Open web pages');
  assert.equal(grantWhat('send', ''), 'Send');
  assert.equal(grantWhat('post', ''), 'Post');
  assert.equal(grantWhat('delete', ''), 'Delete');
  assert.equal(grantWhat('spend', ''), 'Spend money');
  // A send, post or delete rule is for one site, and says which (review I2).
  assert.equal(grantWhat('send', 'https://mail.example.com'), 'Send on mail.example.com');
  assert.equal(grantWhat('delete', 'https://files.example.com'), 'Delete on files.example.com');
  assert.equal(grantWhat('connector.gmail.read', 'me@x.com'), 'Read gmail (me@x.com)');
  assert.equal(grantWhat('connector.gmail.write', ''), 'Change gmail');
});

test('a choice is sent as the grant the server stores', () => {
  const [row] = grantRows(stateOf({grants: [grant({action: 'browser.use', scope: 'https://example.com'})]}), 'mail');
  assert.deepEqual(grantUrl(row, 'deny'), {url: '/api/grants', body: {botId: 'mail', action: 'browser.use', scope: 'https://example.com', choice: 'deny'}});
  assert.equal(scopeOfAction('spend', 'https://x'), '', 'only a site or an account is a scope');
});

// ---- pause ----

test('the pause banner is the owner\'s words, shown only while paused, and Resume only for who may', () => {
  assert.equal(PAUSE_TEXT, 'All bots are paused. Nothing runs until you resume.');
  assert.equal(pauseBanner(stateOf(), {canResume: true}), null);
  assert.equal(pauseBanner(stateOf({guard: {paused: false}}), {canResume: true}), null);
  assert.deepEqual(pauseBanner(stateOf({guard: {paused: true}}), {canResume: true}), {text: PAUSE_TEXT, resume: true});
  assert.deepEqual(pauseBanner(stateOf({guard: {paused: true}}), {canResume: false}), {text: PAUSE_TEXT, resume: false});
});

// ---- the old per-bot switches are gone from every screen ----

test('no screen sets a bot\'s permissions or its browser approval: grants replace both (reading the old setting to label an old rule is fine)', async () => {
  const dir = new URL('../shared/', import.meta.url);
  const files = ['app.js', 'index.html', ...(await readdir(dir)).filter(f => /^ui-.+\.js$/.test(f))];
  for (const file of files) {
    const src = await readFile(new URL(file, dir), 'utf8');
    assert.doesNotMatch(src, /name="browserApproval"|browserApproval:|browserApproval ?=[^=]|data-action="[^"]*approval/, `${file} still sets browserApproval`);
    assert.doesNotMatch(src, /name="permissions"[^>]*data-bot|data-action="toggle-bot-permission"/, `${file} still draws a per-bot permission switch`);
  }
});
