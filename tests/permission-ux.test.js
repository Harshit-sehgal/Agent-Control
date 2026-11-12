// What the owner sees: one bot's permissions in plain words, the first-run checklist, and a rule with an end.
import test from 'node:test';
import assert from 'node:assert/strict';
import {permissionSummary, grantRows} from '../shared/ui-asks.js';
import {setupChecklist} from '../shared/ui-profile-model.js';

const later = ms => new Date(Date.now() + ms).toISOString();
const bot = (id, name, settings = {}) => ({id, name, instructions: `${name} does a job.`, settings});
const stateOf = (extra = {}) => ({groups: [{id: 'home', name: 'Home', settings: {}, bots: [bot('atlas', 'Atlas', {lead: true}), bot('mail', 'Mailroom')]}], asks: [], grants: [], chats: {}, connectors: [], ai: {providers: []}, ...extra});
const newOf = (extra = {}) => stateOf({groups: [{id: 'home', name: 'Home', settings: {}, bots: [bot('atlas', 'Atlas', {lead: true})]}], ...extra});
const g = (action, scope, choice, extra = {}) => ({botId: 'mail', action, scope, choice, at: '2026-11-12T10:00:00Z', ...extra});
const texts = list => list.map(x => x.text);

// ---- the per-bot summary ----

test('a fresh bot: the basics go without asking; sending, posting, deleting and paying ask; nothing is denied', () => {
  const sum = permissionSummary(stateOf(), 'mail');
  assert.deepEqual(texts(sum.free), ['Chat, hand work to its team, make bots and set schedules', 'Open web pages and read connected apps']);
  assert.deepEqual(texts(sum.asks), ['Send, post or change a connected app', 'Delete anything', 'Pay for anything, every time']);
  assert.deepEqual(sum.denied, []);
  assert.match(sum.limits.join(' '), /No limits/);
});

test('the summary reads the bot\'s own rules, Careful and Hands-off, and leaves out an ended rule', () => {
  const s = stateOf({grants: [
    g('post', 'https://x.com', 'always', {until: later(3600000)}),
    g('send', 'https://mail.example.com', 'deny'),
    g('browser.use', 'https://bank.example.com', 'ask'),
    g('delete', 'https://x.com', 'always', {until: later(-1000)}),
    {...g('post', 'https://y.com', 'always'), botId: 'atlas'},
  ]});
  const sum = permissionSummary(s, 'mail');
  assert.ok(texts(sum.free).includes('Post on x.com'));
  assert.ok(sum.free.find(x => x.text === 'Post on x.com').until, 'an Always allow with an end says so');
  assert.ok(!texts(sum.free).includes('Post on y.com'), 'another bot\'s rule is not this bot\'s');
  assert.ok(!texts(sum.free).some(t => /Delete/.test(t)), 'an ended rule is gone');
  assert.deepEqual(texts(sum.denied), ['Send on mail.example.com']);
  assert.ok(texts(sum.asks).includes('Open bank.example.com'));

  const careful = permissionSummary({...s, askBasics: true}, 'mail');
  assert.ok(texts(careful.asks).includes('Open web pages and read connected apps'));
  assert.ok(!texts(careful.free).includes('Open web pages and read connected apps'));

  const hands = permissionSummary({...stateOf(), handsOff: true}, 'mail');
  assert.ok(texts(hands.free).includes('Send, post and change connected apps on any site'));
  assert.deepEqual(texts(hands.asks), ['Delete anything', 'Pay for anything, every time']);
});

test('the summary names the limits the owner set, and a pause', () => {
  const sum = permissionSummary(stateOf({limits: {pages: 3, steps: 6}, guard: {paused: true}}), 'mail');
  assert.ok(sum.limits.some(l => /3 pages/.test(l)), sum.limits);
  assert.ok(sum.limits.some(l => /6 bot hand-offs/.test(l)), sum.limits);
  assert.ok(sum.limits.some(l => /paused/.test(l)), sum.limits);
  assert.equal(permissionSummary(stateOf(), 'nobody'), null);
});

test('a rule row carries its end, and an ended rule is not a row', () => {
  const rows = grantRows(stateOf({grants: [g('post', 'https://x.com', 'always', {until: later(60000)}), g('send', 'https://a.com', 'always', {until: later(-1)})]}), 'mail');
  assert.deepEqual(rows.map(r => r.label), ['Post on x.com']);
  assert.ok(rows[0].until);
});

// ---- the first-run checklist ----

test('a new workspace: five steps, none done, each with the place that does it', () => {
  const list = setupChecklist(newOf());
  assert.deepEqual(list.items.map(i => i.id), ['model', 'agent', 'task', 'connect', 'perm']);
  assert.equal(list.done, 0);
  assert.equal(list.complete, false);
  assert.deepEqual(list.items.map(i => i.go), [{settings: 'models'}, {settings: 'agents'}, {bot: 'atlas'}, {settings: 'conn'}, {settings: 'perm'}]);
});

test('each step is ticked from what is really there', () => {
  const s = newOf({
    ai: {providers: [{id: 'p', kind: 'local-cli'}]},
    chats: {atlas: [{id: 'm1', role: 'user', text: 'hi'}]},
    connectors: [{id: 'c'}],
    grants: [g('post', 'https://x.com', 'always')],
  });
  const list = setupChecklist(s, {agents: 1});
  assert.deepEqual(list.items.filter(i => i.done).map(i => i.id), ['model', 'agent', 'task', 'connect', 'perm']);
  assert.equal(list.complete, true);
  assert.equal(setupChecklist(newOf({aiEnabled: true})).items[0].done, true, 'a model from the environment counts');
  assert.equal(setupChecklist(newOf({groupRuns: [{id: 'r'}]})).items.find(i => i.id === 'task').done, true);
  assert.equal(setupChecklist(stateOf()).items.find(i => i.id === 'task').done, true, 'a second bot counts');
  assert.equal(setupChecklist(newOf(), {seen: true}).items.find(i => i.id === 'perm').done, true, 'opening Permissions counts as a review');
  assert.equal(setupChecklist(newOf({handsOff: true})).items.find(i => i.id === 'perm').done, true);
});

test('the Pages demo leaves out the model and pairing steps it cannot do', () => {
  const list = setupChecklist(newOf(), {demo: true});
  assert.deepEqual(list.items.map(i => i.id), ['task', 'connect', 'perm']);
  assert.equal(list.total, 3);
});
