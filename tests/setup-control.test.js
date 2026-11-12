// Everything the owner can change by hand, a bot can propose as a card: a bot's look, pausing everyone, run limits,
// browsing without asking, forgetting what a bot learned, removing a connector, and renaming or deleting a thread.
import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveSetup, setupCardOf, setupDone, setupButton, SETUP_TOOL_HINT, workspaceBrief} from '../shared/setup.js';
import {COLOR_NAMES, TINT_COUNT} from '../shared/ui-kit.js';

const state = () => ({
  groups: [
    {id: 'home', name: 'Company', bots: [{id: 'atlas', name: 'Atlas', settings: {lead: true}}, {id: 'pt', name: 'Price tracker', settings: {tint: 0}}]},
    {id: 't1', name: 'Plan the Goa trip', settings: {kind: 'thread'}, bots: [{id: 'atlas2', name: 'Atlas'}]},
  ],
  connectors: [{id: 'notes', name: 'Notes', kind: 'mcp'}],
  limits: {pages: 4},
});
const card = (request, s = state()) => {
  const out = resolveSetup(s, request);
  assert.equal(out.ok, true, out.error);
  assert.deepEqual(setupCardOf({setup: out.card}), out.card, 'the card reads back');
  return out.card;
};

test('every colour has a name, one per tint', () => {
  assert.equal(COLOR_NAMES.length, TINT_COUNT);
  assert.equal(new Set(COLOR_NAMES).size, TINT_COUNT);
});

test('a bot can propose a new colour by name and a new shape', () => {
  const c = card({action: 'settings', bot: 'Price tracker', settings: {colour: 'blue', shape: 'egg'}});
  assert.deepEqual(c.settings, {tint: COLOR_NAMES.indexOf('blue'), shape: 'egg'});
  assert.match(c.text, /blue/);
  assert.match(c.text, /egg/i);
  const bad = resolveSetup(state(), {action: 'settings', bot: 'Price tracker', settings: {colour: 'tartan'}});
  assert.equal(bad.ok, false);
  assert.match(bad.error, /blue/);
});

test('pause stops every bot, behind an Apply card', () => {
  const c = card({action: 'pause'});
  assert.equal(c.action, 'pause');
  assert.match(c.text, /pause/i);
  assert.equal(setupDone({guard: {paused: true}}, c), true);
  assert.equal(setupDone({}, c), false);
});

test('limits change how far a run may go, and refuse a number past the backstop', () => {
  const c = card({action: 'limits', pages: 6, steps: 'none'});
  assert.deepEqual(c.limits, {pages: 6, steps: null});
  assert.match(c.text, /6/);
  assert.equal(setupDone({limits: {pages: 6}}, c), true);
  assert.equal(setupDone({limits: {pages: 6, steps: 10}}, c), false);
  const bad = resolveSetup(state(), {action: 'limits', pages: 500});
  assert.equal(bad.ok, false);
  assert.match(bad.error, /8/);
  assert.equal(resolveSetup(state(), {action: 'limits'}).ok, false);
});

test('basics turns asking before every page on or off', () => {
  const c = card({action: 'basics', ask: true});
  assert.equal(c.ask, true);
  assert.match(c.text, /ask/i);
  assert.equal(setupDone({askBasics: true}, c), true);
  assert.equal(resolveSetup(state(), {action: 'basics', ask: 'maybe'}).ok, false);
});

test('forget clears what a bot learned, never by a bad name', () => {
  const c = card({action: 'forget', bot: 'Price tracker'});
  assert.equal(c.botId, 'pt');
  assert.equal(setupButton(c), 'Forget');
  assert.equal(resolveSetup(state(), {action: 'forget', bot: 'Nobody'}).ok, false);
});

test('disconnect removes a connector by name', () => {
  const c = card({action: 'disconnect', connector: 'notes'});
  assert.equal(c.connectorId, 'notes');
  assert.equal(setupButton(c), 'Remove');
  assert.equal(setupDone({connectors: []}, c), true);
  assert.equal(setupDone(state(), c), false);
  const bad = resolveSetup(state(), {action: 'disconnect', connector: 'Slack'});
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Notes/);
});

test('a thread can be renamed or deleted by its title, and a team is not a thread', () => {
  const renamed = card({action: 'thread', thread: 'goa trip', name: 'Goa in March'});
  assert.deepEqual([renamed.groupId, renamed.name], ['t1', 'Goa in March']);
  assert.equal(setupDone({groups: [{id: 't1', name: 'Goa in March', settings: {kind: 'thread'}}]}, renamed), true);
  const gone = card({action: 'thread', thread: 'Plan the Goa trip', remove: true});
  assert.equal(gone.remove, true);
  assert.equal(setupButton(gone), 'Delete');
  assert.equal(setupDone({groups: []}, gone), true);
  assert.equal(resolveSetup(state(), {action: 'thread', thread: 'Company', remove: true}).ok, false);
});

test('the hint teaches every new block, and the brief says the limits and colours', () => {
  for (const action of ['pause', 'limits', 'basics', 'forget', 'disconnect', 'thread']) assert.match(SETUP_TOOL_HINT, new RegExp(`"action":"${action}"`));
  assert.match(SETUP_TOOL_HINT, /colour/);
  assert.match(SETUP_TOOL_HINT, /at most 3 pages per reply[^.]*"action":"limits"/, 'the owner\'s own words map to the limits block');
  const brief = workspaceBrief(state());
  assert.match(brief.limits, /4 pages/);
  assert.ok(brief.facts.some(f => /from now on/.test(f) && /setup block/.test(f)), 'a standing instruction reads as a setting');
  assert.equal(brief.bots.find(b => b.name === 'Price tracker').look, `${COLOR_NAMES[0]} rounded`);
  assert.equal(brief.paused, undefined);
  assert.equal(workspaceBrief({...state(), guard: {paused: true}}).paused, true);
});

test('the new fields survive the block parser, so a real reply reaches each card', async () => {
  const {parseSetupRequests} = await import('../shared/setup.js');
  const fence = body => '```setup\n' + JSON.stringify(body) + '\n```';
  const read = body => { const [item] = parseSetupRequests(fence(body)); assert.equal(item.ok, true, item.error); return resolveSetup(state(), item.request); };
  assert.equal(read({action: 'basics', ask: true}).card.ask, true);
  assert.equal(read({action: 'basics', ask: 'yes'}).card.ask, true);
  assert.deepEqual(read({action: 'limits', pages: 3, rounds: 'none'}).card.limits, {pages: 3, rounds: null});
  assert.equal(read({action: 'disconnect', connector: 'Notes'}).card.connectorId, 'notes');
  assert.equal(read({action: 'thread', thread: 'Goa trip', remove: true}).card.remove, true);
  assert.equal(read({action: 'thread', thread: 'the Goa trip thread', name: 'Goa in March'}).card.name, 'Goa in March');
  assert.equal(read({action: 'settings', bot: 'Price tracker', settings: {colour: 'Blue'}}).card.settings.tint, COLOR_NAMES.indexOf('blue'));
});

test('a card that would change nothing is not offered; the bot hears it is already so', async () => {
  const {setupCardsFromReply} = await import('../src/setup-cards.js');
  const s = state();
  const store = {read: () => s};
  const bot = s.groups[0].bots[0];
  const out = setupCardsFromReply(store, {bot, output: 'On it.\n```setup\n{"action":"settings","bot":"Price tracker","settings":{"enabled":true}}\n```'});
  assert.equal(out.lines.length, 1);
  assert.equal(out.lines[0].setup, undefined, 'no button for a change that is already in place');
  assert.match(out.lines[0].text, /already/);
});

test('more blocks than a reply may carry are reported, never dropped in silence', async () => {
  const {parseSetupRequests} = await import('../shared/setup.js');
  const fence = body => '```setup\n' + JSON.stringify(body) + '\n```';
  const many = Array.from({length: 9}, (_, i) => fence({action: 'rename', bot: 'Price tracker', name: `P${i}`})).join('\n');
  const found = parseSetupRequests(many);
  assert.ok(found.filter(f => f.ok).length >= 6, 'a reply may carry several changes');
  const over = found.filter(f => !f.ok);
  assert.equal(over.length, 1);
  assert.match(over[0].error, /at most/);
});

test('the brief always says whether bots are running', () => {
  assert.match(workspaceBrief(state()).running, /running/);
  assert.match(workspaceBrief({...state(), guard: {paused: true}}).running, /paused/);
});
