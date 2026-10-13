import test from 'node:test';
import assert from 'node:assert/strict';
import {ACTIVE_DRAFTS, draftStage, needsYou, chatRows, timeline, parseRoute, routeHash} from '../shared/ui-model.js';

// ---- fixtures -------------------------------------------------------------------------

const X = 'x-engage';
const bot = (id, name, extra = {}) => ({id, name, instructions: `${name} does a job`, ...extra});
const xGroup = () => ({id: X, name: 'X engagement', description: 'Find posts and draft replies', bots: [bot('scout', 'Scout'), bot('writer', 'Writer')]});
const otherGroup = () => ({id: 'research', name: 'Research', description: '', bots: [bot('analyst', 'Analyst', {instructions: ''})]});
const draft = (id, status, extra = {}) => ({id, status, candidateId: `c-${id}`, createdAt: '2026-03-01T12:00:00Z', ...extra});
const state = (extra = {}) => ({groups: [xGroup(), otherGroup()], drafts: [], candidates: [], groupRuns: [], ...extra});
const at = (day, hour = 12) => `2026-03-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`;
const ids = rows => rows.map(r => r.id);

// ---- draftStage -----------------------------------------------------------------------

test('draftStage gives each lifecycle status a tone and a plain sentence', () => {
  assert.equal(draftStage({status: 'pending'}).tone, 'wait');
  assert.match(draftStage({status: 'pending'}).line, /Waiting on you\. Nothing posts by itself/);
  assert.equal(draftStage({status: 'scheduled'}).tone, 'ok');
  assert.match(draftStage({status: 'scheduled'}).line, /^Approved\. Ready soon\.$/);
  assert.match(draftStage({status: 'scheduled', dueAt: at(2)}).line, /^Approved\. Ready .+\.$/);
  assert.doesNotMatch(draftStage({status: 'scheduled', dueAt: at(2)}).line, /soon/);
  assert.equal(draftStage({status: 'ready'}).tone, 'ok');
  assert.match(draftStage({status: 'ready'}).line, /Post it on X yourself/);
  assert.deepEqual(draftStage({status: 'posted'}), {tone: 'done', line: 'Posted by you.'});
  assert.deepEqual(draftStage({status: 'rejected'}), {tone: 'off', line: 'Skipped.'});
});

test('draftStage never says a draft posted itself and tolerates unknown or missing status', () => {
  assert.deepEqual(draftStage({status: 'weird'}), {tone: 'off', line: 'weird'});
  assert.deepEqual(draftStage({}), {tone: 'off', line: 'Draft'});
  for (const status of ['pending', 'scheduled', 'ready', 'rejected']) assert.doesNotMatch(draftStage({status}).line, /posted/i);
});

test('ACTIVE_DRAFTS are exactly the drafts a human can still act on', () => {
  assert.deepEqual([...ACTIVE_DRAFTS].sort(), ['pending', 'ready', 'scheduled']);
});

// ---- needsYou -------------------------------------------------------------------------

test('needsYou counts pending and ready drafts, only for the x-engage group', () => {
  const s = state({drafts: [draft('1', 'pending'), draft('2', 'ready'), draft('3', 'scheduled'), draft('4', 'posted'), draft('5', 'rejected'), draft('6', 'pending')]});
  assert.equal(needsYou(s, s.groups[0]), 3, 'two pending + one ready; scheduled, posted and skipped are not blocked on the human');
  assert.equal(needsYou(s, s.groups[1]), 0, 'drafts belong to the x-engage group only');
});

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

test('needsYou adds drafts and paused runs together and handles empty input', () => {
  const s = state({drafts: [draft('1', 'pending')], groupRuns: [{groupId: X, status: 'awaiting_checkpoint'}]});
  assert.equal(needsYou(s, s.groups[0]), 2);
  assert.equal(needsYou(null, s.groups[0]), 0);
  assert.equal(needsYou(s, null), 0);
  assert.equal(needsYou({groups: [xGroup()]}, xGroup()), 0, 'missing drafts/groupRuns arrays count as zero');
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
  assert.equal(scout.needs, 0, 'only group conversations carry a needs count');
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
  const s = state({drafts: [draft('1', 'pending')], groupRuns: [{groupId: 'research', status: 'awaiting_checkpoint'}]});
  assert.deepEqual(ids(chatRows({state: s, filter: 'needs'})), ['team-x-engage', 'team-research']);
  assert.deepEqual(ids(chatRows({state: state(), filter: 'needs'})), []);
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
  const waiting = chatRows({state: state({drafts: [draft('1', 'pending'), draft('2', 'ready')]})}).find(r => r.id === 'team-x-engage');
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

test('timeline for the x-engage team chat merges messages, drafts and posts in time order', () => {
  const s = state({
    candidates: [{id: 'p1', createdAt: at(2, 9)}],
    drafts: [draft('d1', 'pending', {candidateId: 'p1', createdAt: at(2, 10)})],
  });
  const messages = {'team-x-engage': [{id: 'm1', role: 'user', text: 'hello', at: at(2, 11)}]};
  const items = timeline({conv: xConv(), state: s, messages});
  assert.deepEqual(kinds(items), ['day', 'post', 'draft', 'message']);
  assert.equal(items[1].post.id, 'p1');
  assert.equal(items[2].draft.id, 'd1');
  assert.equal(items[3].message.id, 'm1');
});

test('timeline puts a post before its draft before a message when they share a timestamp', () => {
  const s = state({candidates: [{id: 'p1', createdAt: at(2)}], drafts: [draft('d1', 'pending', {createdAt: at(2)})]});
  const items = timeline({conv: xConv(), state: s, messages: {'team-x-engage': [{role: 'user', text: 'x', at: at(2)}]}});
  assert.deepEqual(kinds(items).filter(k => k !== 'day'), ['post', 'draft', 'message']);
});

test('timeline shows posts and drafts only in the x-engage team chat', () => {
  const s = state({candidates: [{id: 'p1', createdAt: at(2)}], drafts: [draft('d1', 'pending')]});
  const messages = {
    'team-research': [{role: 'user', text: 'a', at: at(2)}],
    scout: [{role: 'user', text: 'b', at: at(2)}],
  };
  const research = {id: 'team-research', isTeam: true, group: otherGroup()};
  const direct = {id: 'scout', isTeam: false, group: xGroup(), bot: xGroup().bots[0]};
  assert.deepEqual(kinds(timeline({conv: research, state: s, messages})), ['day', 'message']);
  assert.deepEqual(kinds(timeline({conv: direct, state: s, messages})), ['day', 'message'], 'a direct bot chat in the x group is messages only');
});

test('timeline flags a post as drafted when any draft references it', () => {
  const s = state({
    candidates: [{id: 'p1', createdAt: at(2, 9)}, {id: 'p2', createdAt: at(2, 10)}],
    drafts: [draft('d1', 'rejected', {candidateId: 'p1'})],
  });
  const posts = timeline({conv: xConv(), state: s}).filter(i => i.kind === 'post');
  assert.deepEqual(posts.map(p => [p.post.id, p.drafted]), [['p1', true], ['p2', false]]);
});

test('timeline keeps only the 20 most recent posts', () => {
  const candidates = Array.from({length: 25}, (_, i) => ({id: `p${i}`, createdAt: at(1 + i)}));
  const items = timeline({conv: xConv(), state: state({candidates})});
  const posts = items.filter(i => i.kind === 'post');
  assert.equal(posts.length, 20);
  assert.ok(posts.some(p => p.post.id === 'p24'), 'newest kept');
  assert.ok(!posts.some(p => p.post.id === 'p4'), 'the five oldest are dropped');
  assert.ok(posts.some(p => p.post.id === 'p5'));
});

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
  assert.equal(parse('#chat/team-x-engage/info/drafts').info, 'drafts');
  assert.equal(parse('#chat/team-x-engage/info/voice').info, 'voice');
  assert.equal(parse('#chat/team-x-engage/info/nonsense').info, 'home');
  assert.equal(parse('#chat/team-x-engage/open/drafts').info, null, 'only /info/ opens the panel');
  assert.equal(parse('#chat/scout/info/edit').info, 'edit');
  // Sections are per kind: a bot has no drafts panel and a group has no edit panel.
  assert.equal(parse('#chat/scout/info/drafts').info, 'home');
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

test('parseRoute keeps the old #inbox route working as a redirect to the x-engage drafts', () => {
  assert.deepEqual(parse('#inbox'), {chat: 'team-x-engage', page: null, info: 'drafts'});
  assert.deepEqual(parseRoute('#inbox', state({groups: [otherGroup()]})), none, 'without an x-engage group there is nowhere to go');
});

test('parseRoute maps the old #group/<id>/<tab> routes onto info sections', () => {
  const expected = {overview: 'home', discovery: 'posts', approvals: 'drafts', schedules: 'reminders', activity: 'runs', settings: 'voice'};
  for (const [tab, section] of Object.entries(expected)) {
    assert.deepEqual(parse(`#group/${X}/${tab}`), {chat: 'team-x-engage', page: null, info: section}, tab);
  }
  assert.deepEqual(parse(`#group/${X}`), {chat: 'team-x-engage', page: null, info: 'home'});
  // Legacy tab names are X-engage's own; another group falls back to its home
  // instead of showing the X group's drafts.
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
    ...['drafts', 'posts', 'reminders', 'runs', 'voice'].map(info => ({chat: 'team-x-engage', page: null, info})),
    {chat: 'team-research', page: null, info: 'runs'},
    {chat: 'scout', page: null, info: null},
    {chat: 'scout', page: null, info: 'home'},
    {chat: 'scout', page: null, info: 'edit'},
    {chat: 'team-a b/c', page: null, info: 'home'},
    {chat: 'odd bot', page: null, info: null},
  ];
  for (const route of routes) assert.deepEqual(parseRoute(`#${routeHash(route)}`, s, opts), route, `round trip of ${JSON.stringify(route)} via ${routeHash(route)}`);
});
