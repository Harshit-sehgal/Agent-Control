import test from 'node:test';
import assert from 'node:assert/strict';
import {needsYou, chatRows, timeline, retryTarget, threadLineActions, runButtons, waitingOnYou, totalWaitingOnYou, isRunNote, runBelongsToChat} from '../shared/ui-model.js';

// ---- fixtures -------------------------------------------------------------------------

const X = 'x-engage';
const bot = (id, name, extra = {}) => ({id, name, instructions: `${name} does a job`, ...extra});
const xGroup = () => ({id: X, name: 'X engagement', description: 'Find posts and draft replies', bots: [bot('scout', 'Scout'), bot('writer', 'Writer')]});
const otherGroup = () => ({id: 'research', name: 'Research', description: '', bots: [bot('analyst', 'Analyst', {instructions: ''})]});
const draft = (id, status, extra = {}) => ({id, status, candidateId: `c-${id}`, createdAt: '2026-03-01T12:00:00Z', ...extra});
const state = (extra = {}) => ({groups: [xGroup(), otherGroup()], drafts: [], candidates: [], groupRuns: [], ...extra});
const at = (day, hour = 12) => `2026-03-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`;
const ids = rows => rows.map(r => r.id);

// ---- needsYou -------------------------------------------------------------------------

test('needsYou counts paused runs (awaiting_checkpoint) for any group, scoped to that group', () => {
  const s = state({groupRuns: [
    {groupId: 'research', status: 'awaiting_checkpoint'},
    {groupId: 'research', status: 'awaiting_checkpoint'},
    {groupId: 'research', status: 'completed'},
    {groupId: 'research', status: 'running'},
    {groupId: X, status: 'awaiting_checkpoint'},
  ]});
  assert.equal(needsYou(s, s.groups[1]), 2);
  assert.equal(needsYou(s, s.groups[0]), 1);
});

test('needsYou counts paused runs and handles empty input', () => {
  const s = state({groupRuns: [{groupId: X, status: 'awaiting_checkpoint'}, {groupId: X, status: 'awaiting_checkpoint'}]});
  assert.equal(needsYou(s, s.groups[0]), 2);
  assert.equal(needsYou(null, s.groups[0]), 0);
  assert.equal(needsYou(s, null), 0);
  assert.equal(needsYou({groups: [xGroup()]}, xGroup()), 0, 'a missing groupRuns array counts as zero');
});

// ---- waitingOnYou ---------------------------------------------------------------------

test('waitingOnYou answers once per chat: plans, pauses and pending pages', () => {
  const s = state({
    groupRuns: [
      {id: 'p1', groupId: X, chatKey: 'team-x-engage', status: 'awaiting_plan'},
      {id: 'c1', groupId: X, chatKey: 'team-x-engage', status: 'awaiting_checkpoint'},
      {id: 'other', groupId: 'research', chatKey: 'team-research', status: 'awaiting_plan'},
    ],
    browserRequests: [
      {id: 'b1', status: 'pending', chatKey: 'team-x-engage'},
    ],
  });
  assert.deepEqual(waitingOnYou(s, 'team-x-engage'), {plans: 1, pauses: 1, pages: 1, asks: 0});
  assert.equal(totalWaitingOnYou(waitingOnYou(s, 'team-x-engage')), 3);
  // Another chat gets its own answer; a plan there is not the X group's.
  assert.deepEqual(waitingOnYou(s, 'team-research'), {plans: 1, pauses: 0, pages: 0, asks: 0});
});

test('waitingOnYou reads the runs a caller merged in, so a demo plan still counts', () => {
  const s = state();
  const local = waitingOnYou(s, 'analyst', [{id: 'local', groupId: 'research', chatKey: 'analyst', status: 'awaiting_plan'}]);
  assert.equal(local.plans, 1);
  assert.equal(waitingOnYou(s, 'analyst').plans, 0, 'the workspace state alone has no such run');
});

test('a pending ask counts in the chat it is in, and a page request that has an ask is not counted twice', () => {
  const s = state({
    asks: [{id: 'a1', status: 'pending', chatKey: 'scout'}, {id: 'a2', status: 'allowed', chatKey: 'scout'}, {id: 'a3', status: 'pending', chatKey: 'analyst'}],
    browserRequests: [{id: 'b1', status: 'pending', chatKey: 'scout', askId: 'a1'}, {id: 'b2', status: 'pending', chatKey: 'scout'}],
  });
  assert.deepEqual(waitingOnYou(s, 'scout'), {plans: 0, pauses: 0, pages: 1, asks: 1}, 'only the old-style request without an ask is a page');
  assert.equal(totalWaitingOnYou(waitingOnYou(s, 'scout')), 2);
  assert.equal(waitingOnYou(s, 'analyst').asks, 1);
  assert.equal(waitingOnYou(s, 'writer').asks, 0);
});

test('the primary\'s chat holds every pending ask (its "Needs you" list), counted once each', () => {
  const lead = bot('atlas', 'Atlas', {settings: {lead: true}});
  const s = state({groups: [{id: 'home', name: 'Home', bots: [lead, bot('scout', 'Scout')]}], asks: [
    {id: 'a1', status: 'pending', chatKey: 'scout'}, {id: 'a2', status: 'pending', chatKey: 'team-t1'}, {id: 'a3', status: 'pending', chatKey: 'atlas'}, {id: 'a4', status: 'declined', chatKey: 'scout'},
  ]});
  assert.equal(waitingOnYou(s, 'atlas').asks, 3);
  assert.equal(waitingOnYou(s, 'scout').asks, 1);
  assert.equal(waitingOnYou(s, 'team-t1').asks, 1);
});

// ---- runButtons -----------------------------------------------------------------------

test('runButtons answers a run status once, for the thread note and the info card alike', () => {
  assert.deepEqual(runButtons({status: 'awaiting_plan'}), {plan: true, checkpoint: false, stop: false, retry: false});
  assert.deepEqual(runButtons({status: 'awaiting_checkpoint', live: true}), {plan: false, checkpoint: true, stop: true, retry: false});
  assert.deepEqual(runButtons({status: 'running', live: true}), {plan: false, checkpoint: false, stop: true, retry: false});
  assert.deepEqual(runButtons({status: 'failed', live: true}), {plan: false, checkpoint: false, stop: false, retry: true});
  assert.deepEqual(runButtons({status: 'interrupted', live: true}), {plan: false, checkpoint: false, stop: false, retry: true});
  assert.equal(runButtons({status: 'failed'}).retry, false, 'Retry needs the Node build');
  assert.equal(runButtons({status: 'completed', live: true}).stop, false, 'a finished run offers nothing');
  assert.deepEqual(runButtons({}), {plan: false, checkpoint: false, stop: false, retry: false});
});

// ---- chatRows -------------------------------------------------------------------------

test('chatRows lists every group conversation and every bot, in natural order by default', () => {
  const rows = chatRows({state: state()});
  assert.deepEqual(ids(rows), ['team-x-engage', 'scout', 'writer', 'team-research', 'analyst']);
  const team = rows[0], scout = rows[1];
  assert.equal(team.isTeam, true);
  assert.equal(team.name, 'X engagement');
  assert.deepEqual(team.members, [{name: 'Scout', tint: 0}, {name: 'Writer', tint: 1}]);
  assert.equal(scout.isTeam, false);
  assert.equal(scout.groupName, 'X engagement');
  assert.equal(scout.needs, 0);
});

test('chatRows orders pinned first, then most recent message, then natural order', () => {
  const messages = {
    'team-research': [{role: 'user', text: 'hi', at: at(5)}],
    writer: [{role: 'user', text: 'older', at: at(2)}],
    scout: [{role: 'user', text: 'newest', at: at(9)}],
  };
  const profiles = {analyst: {pinned: true}};
  const rows = chatRows({state: state(), messages, profiles});
  // analyst is pinned (no messages), then by recency: scout(9), team-research(5), writer(2),
  // then the two with no messages in natural order: team-x-engage, before nothing else.
  assert.deepEqual(ids(rows), ['analyst', 'scout', 'team-research', 'writer', 'team-x-engage']);
});

test('chatRows keeps several pinned chats ordered by recency among themselves', () => {
  const messages = {writer: [{role: 'user', text: 'a', at: at(3)}], scout: [{role: 'user', text: 'b', at: at(4)}]};
  const rows = chatRows({state: state(), messages, profiles: {writer: {pinned: true}, scout: {pinned: true}}});
  assert.deepEqual(ids(rows).slice(0, 2), ['scout', 'writer']);
});

test('chatRows filter "needs" keeps only conversations that are waiting on the human', () => {
  const s = state({groupRuns: [{groupId: X, chatKey: 'team-x-engage', status: 'awaiting_plan'}, {groupId: 'research', status: 'awaiting_checkpoint'}]});
  assert.deepEqual(ids(chatRows({state: s, filter: 'needs'})), ['team-x-engage', 'team-research']);
  assert.deepEqual(ids(chatRows({state: state(), filter: 'needs'})), []);
});

test('a checkpoint counts on the chat that holds it, not the whole group', () => {
  assert.equal(runBelongsToChat({groupId: 'research', chatKey: 'analyst'}, 'analyst'), true);
  assert.equal(runBelongsToChat({groupId: 'research'}, 'team-research'), true);
  assert.equal(runBelongsToChat({groupId: 'research'}, 'analyst'), false);
  const s = state({groupRuns: [
    {id: 'c1', groupId: 'research', chatKey: 'analyst', status: 'awaiting_checkpoint'},
    {id: 'c2', groupId: X, chatKey: 'team-x-engage', status: 'awaiting_checkpoint'},
  ]});
  const rows = chatRows({state: s});
  assert.equal(rows.find(r => r.id === 'analyst').needs, 1);
  assert.equal(rows.find(r => r.id === 'team-research').needs, 0, 'A pause in a 1:1 chat is not the group chat');
  assert.equal(rows.find(r => r.id === 'team-x-engage').needs, 1);
  assert.equal(rows.find(r => r.id === 'writer').needs, 0);
  assert.equal(needsYou(s, s.groups[1]), 1, 'The group still counts every pause');
});
test('a waiting plan counts on the chat that holds it, including a demo run the workspace never stored', () => {
  const s = state({groupRuns: [
    {id: 'p1', groupId: 'research', chatKey: 'team-research', status: 'awaiting_plan'},
    {id: 'p2', groupId: X, chatKey: 'writer', status: 'awaiting_plan'},
    {id: 'p3', groupId: 'research', chatKey: 'team-research', status: 'running'},
  ]});
  const rows = chatRows({state: s});
  assert.equal(rows.find(r => r.id === 'team-research').needs, 1);
  assert.equal(rows.find(r => r.id === 'writer').needs, 1);
  assert.equal(rows.find(r => r.id === 'team-x-engage').needs, 0, 'A plan in the writer chat is not the group chat');
  const local = chatRows({state: state(), localRuns: [{id: 'local', groupId: 'research', chatKey: 'analyst', status: 'awaiting_plan'}]});
  assert.equal(local.find(r => r.id === 'analyst').needs, 1);
  assert.deepEqual(ids(chatRows({state: state(), filter: 'needs', localRuns: [{id: 'local', groupId: 'research', chatKey: 'analyst', status: 'awaiting_plan'}]})), ['analyst']);
  const stale = chatRows({
    state: state({groupRuns: [{id: 'p1', groupId: 'research', chatKey: 'team-research', status: 'completed'}]}),
    localRuns: [{id: 'p1', groupId: 'research', chatKey: 'team-research', status: 'awaiting_plan'}],
  });
  assert.equal(stale.find(r => r.id === 'team-research').needs, 0, 'The workspace status wins over a stale local plan');
});

test('a plan and a pending page on the same chat both count', () => {
  const s = state({
    groupRuns: [{id: 'p1', groupId: 'research', chatKey: 'team-research', status: 'awaiting_plan'}],
    browserRequests: [{id: 'a', status: 'pending', chatKey: 'team-research'}],
  });
  const row = chatRows({state: s}).find(r => r.id === 'team-research');
  assert.equal(row.needs, 2);
  assert.equal(row.text, 'Wants to open a page');
});

test('a failed run offers Retry, and the demo still shows a plan', () => {
  assert.deepEqual(threadLineActions({status: 'failed', live: true, note: true, latest: true}), {plan: false, checkpoint: false, stop: false, retry: true});
  assert.deepEqual(threadLineActions({status: 'awaiting_plan', live: false, note: true, latest: true}), {plan: true, checkpoint: false, stop: false, retry: false});
  assert.deepEqual(threadLineActions({status: 'awaiting_checkpoint', live: false, note: true, latest: true}), {plan: false, checkpoint: true, stop: false, retry: false});
  assert.deepEqual(threadLineActions({status: 'awaiting_checkpoint', live: true, note: true, latest: true}), {plan: false, checkpoint: true, stop: true, retry: false});
  assert.deepEqual(threadLineActions({status: 'failed', live: true, note: true, latest: false}), {plan: false, checkpoint: false, stop: false, retry: false});
  // Stop is the opposite of Retry: a run that can still work offers Stop, and a
  // run that ended offers Retry. The plan note has its own Cancel next to Start,
  // so it is not offered a second button that stops the same run.
  assert.deepEqual(threadLineActions({status: 'running', live: true, note: true, latest: true}), {plan: false, checkpoint: false, stop: true, retry: false});
  assert.equal(threadLineActions({status: 'awaiting_plan', live: true, note: true, latest: true}).stop, false);
  assert.equal(threadLineActions({status: 'completed', live: true, note: true, latest: true}).stop, false);
  assert.equal(isRunNote({role: 'system', runId: 'r', kind: 'browser'}), false);
  // A sub-agent line never takes the Start/Retry button from the run's real note.
  assert.equal(isRunNote({role: 'system', runId: 'r', kind: 'subagent'}), false);
  assert.equal(isRunNote({role: 'system', runId: 'r'}), true);
  assert.equal(isRunNote({role: 'bot', runId: 'r'}), false);
});

test('a pending browser request waits on the chat that holds it, including a one-to-one bot chat', () => {
  const s = state({browserRequests: [
    {id: 'a', status: 'pending', chatKey: 'team-research'},
    {id: 'b', status: 'pending', chatKey: 'scout'},
    {id: 'c', status: 'dispatched', chatKey: 'writer'},
    {id: 'd', status: 'pending', chatKey: 'gone'},
  ]});
  const rows = chatRows({state: s, filter: 'needs'});
  assert.deepEqual(ids(rows), ['scout', 'team-research']);
  const team = rows.find(r => r.id === 'team-research'), one = rows.find(r => r.id === 'scout');
  assert.equal(team.needs, 1);
  assert.equal(team.text, 'Wants to open a page');
  assert.equal(one.needs, 1);
  assert.equal(one.text, 'Wants to open a page');
  assert.equal(chatRows({state: s}).find(r => r.id === 'writer').needs, 0, 'A request already on the device is not waiting on you.');
});

test('retry of a tracked run names the primary bot and the conversation it started in', () => {
  const group = {bots: [bot('handoff', 'Handoff', {settings: {lead: true}}), bot('writer', 'Writer', {type: 'writing'})]};
  assert.deepEqual(retryTarget(group, {mode: 'tracked', chatKey: 'handoff', recipients: ['writer']}), {direct: 'handoff', chat: 'handoff'});
  assert.deepEqual(retryTarget(group, {mode: 'direct', chatKey: 'writer', recipients: ['writer']}), {direct: 'writer', chat: 'writer'});
  assert.deepEqual(retryTarget(group, {mode: 'pipeline', chatKey: 'team-g', recipients: ['writer']}), {direct: '', chat: 'team-g'});
});

test('chatRows filters "groups" and "bots" split team chats from bot chats', () => {
  assert.deepEqual(ids(chatRows({state: state(), filter: 'groups'})), ['team-x-engage', 'team-research']);
  assert.deepEqual(ids(chatRows({state: state(), filter: 'bots'})), ['scout', 'writer', 'analyst']);
  assert.equal(chatRows({state: state(), filter: 'all'}).length, 5);
});

test('chatRows search matches name, preview text and group name, ignoring case and padding', () => {
  const messages = {writer: [{role: 'user', text: 'Please tighten the PIZZA reply', at: at(2)}]};
  assert.deepEqual(ids(chatRows({state: state(), messages, query: '  pizza '})), ['writer']);
  assert.deepEqual(ids(chatRows({state: state(), query: 'ANALYST'})), ['analyst']);
  // A bot row also matches its group's name; the team row matches its own name.
  assert.deepEqual(ids(chatRows({state: state(), query: 'research'})), ['team-research', 'analyst']);
  assert.deepEqual(ids(chatRows({state: state(), query: 'no such thing'})), []);
  // The query narrows within a filter instead of replacing it.
  assert.deepEqual(ids(chatRows({state: state(), query: 'research', filter: 'bots'})), ['analyst']);
});

test('chatRows preview: "You" for the user, the sender name in team chats, nothing for a bot chat', () => {
  const messages = {
    'team-x-engage': [{role: 'user', text: 'draft please', at: at(2)}, {role: 'bot', senderName: 'Writer', text: 'Here it is', at: at(3)}],
    scout: [{role: 'user', text: 'find posts', at: at(2)}],
    writer: [{role: 'bot', senderName: 'Writer', text: 'Done', at: at(2)}],
    'team-research': [{role: 'user', text: 'go', at: at(2)}],
  };
  const byId = Object.fromEntries(chatRows({state: state(), messages}).map(r => [r.id, r]));
  assert.deepEqual([byId['team-x-engage'].sender, byId['team-x-engage'].text], ['Writer', 'Here it is']);
  assert.deepEqual([byId.scout.sender, byId.scout.text], ['You', 'find posts']);
  assert.deepEqual([byId.writer.sender, byId.writer.text], ['', 'Done'], 'a direct bot chat has one voice, so no sender label');
  assert.equal(byId['team-research'].sender, 'You');
  assert.equal(byId['team-x-engage'].at, at(3));
});

test('chatRows preview: system events show text without a sender', () => {
  const messages = {'team-research': [{role: 'system', text: 'Paused after step 1.', at: at(2)}]};
  const row = chatRows({state: state(), messages}).find(r => r.id === 'team-research');
  assert.deepEqual([row.sender, row.text], ['', 'Paused after step 1.']);
});

test('chatRows preview collapses whitespace and caps the length at 120 characters', () => {
  const messages = {scout: [{role: 'user', text: `line one\n\n   line   two ${'x'.repeat(300)}`, at: at(2)}]};
  const {text} = chatRows({state: state(), messages}).find(r => r.id === 'scout');
  assert.ok(text.startsWith('line one line two x'));
  assert.equal(text.length, 120);
});

test('chatRows fallback preview when a chat is empty', () => {
  const byId = Object.fromEntries(chatRows({state: state()}).map(r => [r.id, r]));
  assert.equal(byId['team-x-engage'].text, 'Find posts and draft replies', 'team: its description');
  assert.equal(byId['team-research'].text, 'Message the whole team', 'team without a description');
  assert.equal(byId.scout.text, 'Scout does a job', 'bot: its instructions');
  assert.equal(byId.analyst.text, 'Say what you need', 'bot without instructions');
  assert.equal(byId.scout.sender, '');
  const waiting = chatRows({state: state({groupRuns: [{groupId: X, chatKey: 'team-x-engage', status: 'awaiting_checkpoint'}, {groupId: X, chatKey: 'team-x-engage', status: 'awaiting_checkpoint'}]})}).find(r => r.id === 'team-x-engage');
  assert.equal(waiting.text, '2 waiting on you', 'an empty team chat with work for the human says so');
  assert.equal(waiting.needs, 2);
});

test('chatRows carries typing and tint from the UI state', () => {
  const rows = chatRows({state: state(), typing: new Set(['writer']), profiles: {scout: {avatarIndex: 4}}});
  const byId = Object.fromEntries(rows.map(r => [r.id, r]));
  assert.equal(byId.writer.typing, true);
  assert.equal(byId.scout.typing, false);
  assert.equal(byId.scout.tint, 4, 'a chosen avatar index wins');
  assert.equal(byId.writer.tint, 1, 'otherwise the bot position in its group');
  assert.equal(byId['team-x-engage'].members[0].tint, 4);
});

test('chatRows copes with no state at all', () => {
  assert.deepEqual(chatRows({state: null}), []);
  assert.deepEqual(chatRows({state: {}}), []);
});

// ---- timeline -------------------------------------------------------------------------

const xConv = () => ({id: 'team-x-engage', isTeam: true, group: xGroup()});
const kinds = items => items.map(i => i.kind);

test('timeline inserts a day divider whenever the day changes, oldest first', () => {
  const messages = {scout: [
    {id: 'a', role: 'user', text: '1', at: at(2, 9)},
    {id: 'b', role: 'user', text: '2', at: at(2, 10)},
    {id: 'c', role: 'user', text: '3', at: at(4)},
  ]};
  const items = timeline({conv: {id: 'scout', isTeam: false, group: xGroup()}, state: state(), messages});
  assert.deepEqual(kinds(items), ['day', 'message', 'message', 'day', 'message']);
  assert.equal(items[0].at, at(2, 9));
  assert.equal(items[3].at, at(4));
  // Input order does not matter.
  const reversed = timeline({conv: {id: 'scout', isTeam: false, group: xGroup()}, state: state(), messages: {scout: [...messages.scout].reverse()}});
  assert.deepEqual(reversed.filter(i => i.kind === 'message').map(i => i.message.id), ['a', 'b', 'c']);
});

test('timeline marks the first message of a run from one sender as the lead', () => {
  const messages = {'team-research': [
    {role: 'user', text: '1', at: at(2, 9)},
    {role: 'user', text: '2', at: at(2, 10)},
    {role: 'bot', senderId: 'analyst', senderName: 'Analyst', text: '3', at: at(2, 11)},
    {role: 'bot', senderId: 'analyst', senderName: 'Analyst', text: '4', at: at(2, 12)},
    {role: 'bot', senderId: 'other', senderName: 'Other', text: '5', at: at(2, 13)},
    {role: 'user', text: '6', at: at(3, 9)},
  ]};
  const items = timeline({conv: {id: 'team-research', isTeam: true, group: otherGroup()}, state: state(), messages});
  const leads = items.filter(i => i.kind === 'message').map(i => i.lead);
  assert.deepEqual(leads, [true, false, true, false, true, true], 'a new day or sender starts a new lead');
});

test('timeline of an empty conversation is empty, and a missing state is tolerated', () => {
  assert.deepEqual(timeline({conv: xConv(), state: state()}), []);
  assert.deepEqual(timeline({conv: xConv(), state: null}), []);
});

test('the asset list holds no X surfaces', async () => {
  const {ASSETS} = await import('../shared/assets.js');
  assert.equal(ASSETS.includes('usability.js'), false);
  assert.equal(ASSETS.includes('chat-engine.js'), false);
});

test('a limit card and a runaway-guard line carry their own buttons, so neither is a run note', () => {
  assert.equal(isRunNote({role: 'system', runId: 'r1', kind: 'limit'}), false);
  assert.equal(isRunNote({role: 'system', kind: 'guard'}), false);
  assert.equal(isRunNote({role: 'system', runId: 'r1'}), true);
});

test('chatRows preview skips a bot\'s working step', () => {
  const messages = {scout: [{role: 'user', text: 'Find posts', at: at(3)}, {role: 'bot', text: 'Looking.', step: true, at: at(4)}]};
  const row = chatRows({state: state(), messages}).find(r => r.id === 'scout');
  assert.equal(row.text, 'Find posts');
  assert.equal(row.sender, 'You');
});
