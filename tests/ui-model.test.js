import test from 'node:test';
import assert from 'node:assert/strict';
import {needsYou, chatRows, timeline, parseRoute, routeHash, feedPauseAction, retryTarget, threadLineActions, runButtons, waitingOnYou, totalWaitingOnYou, isRunNote, runBelongsToChat, FEED_WAIT, FEED_OPEN} from '../shared/ui-model.js';

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

test('waitingOnYou answers once per chat: plans, pauses, pending pages and stuck feeds', () => {
  const s = state({
    groupRuns: [
      {id: 'p1', groupId: X, chatKey: 'team-x-engage', status: 'awaiting_plan'},
      {id: 'c1', groupId: X, chatKey: 'team-x-engage', status: 'awaiting_checkpoint'},
      {id: 'f1', groupId: X, chatKey: 'team-x-engage', status: 'awaiting_feed'},
      {id: 'other', groupId: 'research', chatKey: 'team-research', status: 'awaiting_plan'},
    ],
    browserRequests: [
      {id: 'b1', status: 'pending', chatKey: 'team-x-engage'},
      {id: 'f1r', purpose: 'feed', status: 'dispatched', chatKey: 'team-x-engage', runId: 'f1'},
    ],
  });
  assert.deepEqual(waitingOnYou(s, 'team-x-engage'), {plans: 1, pauses: 1, pages: 1, feeds: 1});
  assert.equal(totalWaitingOnYou(waitingOnYou(s, 'team-x-engage')), 4);
  // Another chat gets its own answer; a plan there is not the X group's.
  assert.deepEqual(waitingOnYou(s, 'team-research'), {plans: 1, pauses: 0, pages: 0, feeds: 0});
});

test('waitingOnYou reads the runs a caller merged in, so a demo plan still counts', () => {
  const s = state();
  const local = waitingOnYou(s, 'analyst', [{id: 'local', groupId: 'research', chatKey: 'analyst', status: 'awaiting_plan'}]);
  assert.equal(local.plans, 1);
  assert.equal(waitingOnYou(s, 'analyst').plans, 0, 'the workspace state alone has no such run');
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

test('a feed-permission failure keeps Grant and Retry, and the demo still shows a plan', () => {
  assert.deepEqual(threadLineActions({kind: 'feed-permission', senderId: 'scout', status: 'failed', live: true, note: true, latest: true}), {grant: true, plan: false, checkpoint: false, stop: false, retry: true});
  assert.equal(threadLineActions({kind: 'feed-permission', senderId: 'scout', status: 'failed', live: false, note: true, latest: true}).grant, true);
  assert.deepEqual(threadLineActions({status: 'awaiting_plan', live: false, note: true, latest: true}), {grant: false, plan: true, checkpoint: false, stop: false, retry: false});
  assert.deepEqual(threadLineActions({status: 'awaiting_checkpoint', live: false, note: true, latest: true}), {grant: false, plan: false, checkpoint: true, stop: false, retry: false});
  assert.deepEqual(threadLineActions({status: 'awaiting_checkpoint', live: true, note: true, latest: true}), {grant: false, plan: false, checkpoint: true, stop: true, retry: false});
  assert.deepEqual(threadLineActions({status: 'failed', live: true, note: true, latest: false}), {grant: false, plan: false, checkpoint: false, stop: false, retry: false});
  // Stop is the opposite of Retry: a run that can still work offers Stop, and a
  // run that ended offers Retry. The plan note has its own Cancel next to Start,
  // so it is not offered a second button that stops the same run.
  assert.deepEqual(threadLineActions({status: 'running', live: true, note: true, latest: true}), {grant: false, plan: false, checkpoint: false, stop: true, retry: false});
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

test('a feed pause keeps watching once the read is sent, and waits once it is still on the person', () => {
  assert.deepEqual(feedPauseAction(null), {action: 'lookAgain', text: ''});
  assert.deepEqual(feedPauseAction({status: 'pending'}), {action: 'lookAgain', text: ''});
  assert.deepEqual(feedPauseAction({status: 'pending'}, {graceUsed: true}), {action: 'wait', text: FEED_WAIT});
  assert.deepEqual(feedPauseAction({status: 'dispatched'}, {graceUsed: true}), {action: 'follow', text: FEED_OPEN});
  assert.deepEqual(feedPauseAction({status: 'failed'}), {action: 'follow', text: ''});
});

test('a dispatched feed read that still holds the group shows on that chat', () => {
  const s = state({
    groupRuns: [{id: 'run-1', groupId: 'research', chatKey: 'team-research', status: 'awaiting_feed'}],
    browserRequests: [{id: 'f', purpose: 'feed', status: 'dispatched', chatKey: 'team-research', runId: 'run-1'}],
  });
  const row = chatRows({state: s, filter: 'needs'}).find(r => r.id === 'team-research');
  assert.equal(row.needs, 1);
  assert.equal(row.text, 'A feed read is still open');
  const done = state({
    groupRuns: [{id: 'run-1', groupId: 'research', chatKey: 'team-research', status: 'failed'}],
    browserRequests: [{id: 'f', purpose: 'feed', status: 'dispatched', chatKey: 'team-research', runId: 'run-1'}],
  });
  assert.equal(chatRows({state: done}).find(r => r.id === 'team-research').needs, 0);
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

// ---- parseRoute / routeHash -----------------------------------------------------------

const S = state();
const parse = (hash, opts) => parseRoute(hash, S, opts);
const none = {chat: null, page: null, info: null};

test('parseRoute opens a team chat or a bot chat by id', () => {
  assert.deepEqual(parse('#chat/team-x-engage'), {chat: 'team-x-engage', page: null, info: null});
  assert.deepEqual(parse('#chat/scout'), {chat: 'scout', page: null, info: null});
  assert.deepEqual(parse('chat/analyst'), {chat: 'analyst', page: null, info: null}, 'the leading # is optional');
});

test('parseRoute reads the info panel and defaults an unknown section to home', () => {
  assert.equal(parse('#chat/team-x-engage/info').info, 'home');
  assert.equal(parse('#chat/team-x-engage/info/runs').info, 'runs');
  assert.equal(parse('#chat/team-x-engage/info/tasks').info, 'tasks');
  assert.equal(parse('#chat/team-x-engage/info/nonsense').info, 'home');
  assert.equal(parse('#chat/team-x-engage/open/runs').info, null, 'only /info/ opens the panel');
  assert.equal(parse('#chat/scout/info/edit').info, 'edit');
  assert.equal(parse('#chat/scout/info/edit', {write: false}).info, 'home', 'Viewers do not open the bot edit form.');
  // Sections are per kind: a bot has no runs panel and a group has no edit panel.
  assert.equal(parse('#chat/scout/info/runs').info, 'home');
  assert.equal(parse('#chat/team-x-engage/info/edit').info, 'home');
});

test('parseRoute sends unknown chats, unknown pages and garbage to the chat list', () => {
  for (const hash of ['', '#', '#chats', '#chat', '#chat/', '#chat/ghost', '#chat/ghost/info/drafts', '#nonsense', '#you/nonsense', '#team-', undefined, null, 42]) {
    assert.deepEqual(parse(hash, {server: true, admin: true}), none, `${hash} should fall back to the list`);
  }
  assert.deepEqual(parseRoute('#chat/scout', null), none, 'no state yet means no chats exist');
  assert.deepEqual(parseRoute('#chat/scout', {}), none);
});

test('parseRoute decodes percent-encoding and survives malformed escapes', () => {
  const s = state({groups: [{id: 'a b/c', name: 'Odd', bots: [bot('odd bot', 'Odd bot')]}]});
  assert.equal(parseRoute(`#chat/${encodeURIComponent('team-a b/c')}`, s).chat, 'team-a b/c');
  assert.equal(parseRoute(`#chat/${encodeURIComponent('odd bot')}`, s).chat, 'odd bot');
  assert.doesNotThrow(() => parseRoute('#chat/%E0%A4%A', s));
  assert.deepEqual(parseRoute('#chat/%E0%A4%A', s), none);
});

test('parseRoute sends an old #group/<id> route to that chat\'s info home', () => {
  for (const tab of ['overview', 'approvals', 'settings']) assert.deepEqual(parse(`#group/${X}/${tab}`), {chat: 'team-x-engage', page: null, info: 'home'}, tab);
  assert.deepEqual(parse(`#group/${X}`), {chat: 'team-x-engage', page: null, info: 'home'});
  assert.deepEqual(parse('#group/research/approvals'), {chat: 'team-research', page: null, info: 'home'});
  assert.equal(parse(`#group/${X}/never-heard-of-it`).info, 'home');
  assert.deepEqual(parse('#group/ghost/approvals'), none);
});

test('parseRoute never lets an inherited object key through as an info section', () => {
  // The legacy-tab table is a plain object, so a prototype key must not leak out of it.
  const sections = ['home', 'drafts', 'posts', 'reminders', 'runs', 'voice'];
  for (const tab of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
    const route = parse(`#group/${X}/${tab}`);
    assert.ok(sections.includes(route.info), `#group/${X}/${tab} produced info=${String(route.info)}`);
  }
});

test('parseRoute opens the You pages for everyone', () => {
  assert.deepEqual(parse('#you'), {chat: null, page: 'you', info: null});
  assert.deepEqual(parse('#you/you'), {chat: null, page: 'you', info: null});
  assert.deepEqual(parse('#you/about'), {chat: null, page: 'about', info: null});
});

test('parseRoute refuses admin pages unless the viewer is an admin', () => {
  for (const page of ['team', 'agents', 'data']) {
    assert.deepEqual(parse(`#you/${page}`, {server: true}), none, `${page} without admin`);
    assert.deepEqual(parse(`#${page}`, {server: true}), none, `${page} directly without admin`);
    assert.deepEqual(parse(`#you/${page}`), none, `${page} with no options`);
    assert.deepEqual(parse(`#you/${page}`, {admin: false}), none);
    assert.deepEqual(parse(`#you/${page}`, {server: true, admin: true}), {chat: null, page, info: null}, `${page} as admin`);
  }
});

test('parseRoute opens the workspaces page for any signed-in server user only', () => {
  assert.deepEqual(parse('#you/workspaces'), none);
  assert.deepEqual(parse('#you/workspaces', {server: true}), {chat: null, page: 'workspaces', info: null});
});

test('parseRoute refuses notifications without a server', () => {
  assert.deepEqual(parse('#you/notifications'), none);
  assert.deepEqual(parse('#you/notifications', {server: false, admin: true}), none);
  assert.deepEqual(parse('#you/notifications', {server: true}), {chat: null, page: 'notifications', info: null}, 'a non-admin server user may read their own notifications');
});

test('routeHash writes the canonical hash for every kind of route', () => {
  assert.equal(routeHash(none), 'chats');
  assert.equal(routeHash({chat: null, page: 'you', info: null}), 'you');
  assert.equal(routeHash({chat: null, page: 'about', info: null}), 'you/about');
  assert.equal(routeHash({chat: 'scout', page: null, info: null}), 'chat/scout');
  assert.equal(routeHash({chat: 'scout', page: null, info: 'home'}), 'chat/scout/info');
  assert.equal(routeHash({chat: 'team-x-engage', page: null, info: 'drafts'}), 'chat/team-x-engage/info/drafts');
  assert.equal(routeHash({chat: 'team-a b/c', page: null, info: null}), 'chat/team-a%20b%2Fc', 'ids are encoded so they stay one path segment');
});

test('routeHash round-trips through parseRoute', () => {
  const s = state({groups: [xGroup(), otherGroup(), {id: 'a b/c', name: 'Odd', bots: [bot('odd bot', 'Odd bot')]}]});
  const opts = {server: true, admin: true};
  const routes = [
    none,
    {chat: null, page: 'you', info: null},
    {chat: null, page: 'about', info: null},
    {chat: null, page: 'notifications', info: null},
    {chat: null, page: 'team', info: null},
    {chat: null, page: 'agents', info: null},
    {chat: null, page: 'data', info: null},
    {chat: 'team-x-engage', page: null, info: null},
    {chat: 'team-x-engage', page: null, info: 'home'},
    ...['runs', 'group-settings', 'tasks'].map(info => ({chat: 'team-x-engage', page: null, info})),
    {chat: 'team-research', page: null, info: 'runs'},
    {chat: 'scout', page: null, info: null},
    {chat: 'scout', page: null, info: 'home'},
    {chat: 'scout', page: null, info: 'edit'},
    {chat: 'team-a b/c', page: null, info: 'home'},
    {chat: 'odd bot', page: null, info: null},
  ];
  for (const route of routes) assert.deepEqual(parseRoute(`#${routeHash(route)}`, s, opts), route, `round trip of ${JSON.stringify(route)} via ${routeHash(route)}`);
});

test('every bot info section the panel links to is a route the parser accepts', () => {
  // The bot panel renders "Memory and rules" and pushes #chat/<bot>/info/memory.
  // Without `memory` in BOT_SECTIONS the parser fell back to home, so the row
  // appeared to do nothing and a reload dropped the person out of the page.
  const botId = (state().groups[0].bots[0] || {}).id || 'scout';
  for (const section of ['home', 'edit', 'memory', 'tasks']) {
    assert.equal(parseRoute(`#chat/${botId}/info/${section}`, state()).info, section, section);
    assert.equal(routeHash({chat: botId, page: null, info: section}), `chat/${botId}/info${section === 'home' ? '' : `/${section}`}`);
  }
  // A section a bot does not have still falls back rather than painting nothing.
  assert.equal(parseRoute(`#chat/${botId}/info/drafts`, state()).info, 'home');
});

test('group sections hold no X surfaces', async () => {
  const s = {groups: [{id: 'g', name: 'G', bots: [{id: 'b', name: 'B'}]}]};
  for (const name of ['drafts', 'posts', 'reminders', 'voice'])
    assert.equal(parseRoute(`#chat/team-g/info/${name}`, s).info, 'home', `${name} is still a group section`);
  const {ASSETS} = await import('../shared/assets.js');
  assert.equal(ASSETS.includes('usability.js'), false);
  assert.equal(ASSETS.includes('chat-engine.js'), false);
});
