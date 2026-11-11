import test from 'node:test';
import assert from 'node:assert/strict';
import {botRows, botStatus, botIsManager, threadRows, progressPill, handoffs, chatStatus, companyRoute, companyHash} from '../shared/ui-company.js';

const bot = (id, name, settings = {}, instructions = '') => ({id, name, instructions, settings});
const atlas = bot('atlas', 'Atlas', {lead: true, pinned: true}, 'Runs the company and hands work out.');
const ops = bot('ops', 'Ops lead', {reportsTo: 'atlas'}, 'Keeps the daily work moving: planning and mail.');
const mail = bot('mail', 'Mailroom', {reportsTo: 'ops'}, 'Reads and drafts email.');
const plan = bot('plan', 'Planner', {reportsTo: 'ops'}, 'Plans the week around meetings.');
const ledger = bot('ledger', 'Ledger', {reportsTo: null}, '');
const company = bots => ({id: 'home', name: 'Company', settings: {}, bots});
const thread = (id, name, extra = {}) => ({id, name, bots: [], settings: {kind: 'thread', ownerId: 'atlas', members: ['atlas'], ...extra}});
const stateOf = (extra = {}) => ({groups: [company([atlas, ops, mail, plan, ledger])], chats: {}, groupRuns: [], ...extra});
const run = (extra = {}) => ({id: 'r1', groupId: 'home', chatKey: 'mail', status: 'running', recipients: ['mail'], trace: [], currentStep: 0, ...extra});
const rowOf = (rows, id) => rows.find(r => r.id === id);

// ---- botRows ----

test('botRows gives one row per company bot, never a thread', () => {
  const rows = botRows(stateOf({groups: [company([atlas, mail]), thread('t1', 'Northwind call')]}));
  assert.deepEqual(rows.map(r => r.id).sort(), ['atlas', 'mail']);
});

test('botRows names the primary and the managers', () => {
  const rows = botRows(stateOf());
  assert.equal(rowOf(rows, 'atlas').isPrimary, true);
  assert.equal(rowOf(rows, 'ops').isManager, true);
  assert.equal(rowOf(rows, 'mail').isManager, false);
  assert.equal(rowOf(rows, 'mail').isPrimary, false);
});

test('a row job is the first sentence of the instructions, or says the bot has none yet', () => {
  const rows = botRows(stateOf());
  assert.equal(rowOf(rows, 'mail').job, 'Reads and drafts email');
  assert.equal(rowOf(rows, 'ledger').job, 'New, no job yet');
});

test('a row carries the bot face, drawn in its role shape', () => {
  const rows = botRows(stateOf());
  assert.match(rowOf(rows, 'ops').face, /data-shape="hexagon"/);
  assert.match(rowOf(rows, 'atlas').face, /data-shape="circle"/);
  assert.match(rowOf(rows, 'mail').face, /data-shape="rounded"/);
});

test('an idle bot is asleep and an idle primary is awake', () => {
  const rows = botRows(stateOf());
  assert.equal(rowOf(rows, 'mail').status, 'asleep');
  assert.equal(rowOf(rows, 'atlas').status, 'awake');
  assert.match(rowOf(rows, 'mail').face, /face--asleep/);
});

test('a bot with a queued or running run is working', () => {
  for (const status of ['queued', 'running']) {
    const rows = botRows(stateOf({groupRuns: [run({status})]}));
    assert.equal(rowOf(rows, 'mail').status, 'working');
    assert.equal(rowOf(rows, 'plan').status, 'asleep');
  }
});

test('a bot whose run waits on the person is waiting (an ask is the owner\'s to answer, not live work)', () => {
  for (const status of ['awaiting_checkpoint', 'awaiting_plan', 'awaiting_browser', 'awaiting_ask']) {
    assert.equal(rowOf(botRows(stateOf({groupRuns: [run({status})]})), 'mail').status, 'waiting', status);
  }
});

test('a finished run leaves the bot asleep', () => {
  assert.equal(rowOf(botRows(stateOf({groupRuns: [run({status: 'completed'})]})), 'mail').status, 'asleep');
});

test('the bot being asked by another bot is the one working', () => {
  const asking = run({chatKey: 'team-t1', groupId: 't1', recipients: ['atlas'], trace: [{botId: 'atlas', kind: 'ask', to: 'mail', task: 'Any new mail?'}]});
  const rows = botRows(stateOf({groups: [company([atlas, ops, mail, plan, ledger]), thread('t1', 'x')], groupRuns: [asking]}));
  assert.equal(rowOf(rows, 'mail').status, 'working');
});

test('in a thread, Atlas is the one working until it has handed anything out', () => {
  const fresh = run({chatKey: 'team-t1', groupId: 't1', recipients: ['atlas', 'plan'], trace: []});
  const rows = botRows(stateOf({groups: [company([atlas, ops, mail, plan, ledger]), thread('t1', 'x')], groupRuns: [fresh]}));
  assert.equal(rowOf(rows, 'atlas').status, 'working');
  assert.equal(rowOf(rows, 'plan').status, 'asleep');
});

test('pinned bots come first, in pin order, and are flagged', () => {
  const rows = botRows(stateOf(), {pins: ['plan', 'atlas']});
  assert.deepEqual(rows.slice(0, 2).map(r => r.id), ['plan', 'atlas']);
  assert.deepEqual(rows.map(r => r.pinned), [true, true, false, false, false]);
});

test('while Atlas is pinned the list starts with Atlas\'s reports, not Atlas again', () => {
  const rows = botRows(stateOf(), {pins: ['atlas']});
  assert.equal(rows.filter(r => r.id === 'atlas').length, 1);
  assert.deepEqual(rows.slice(1).map(r => r.id), ['ops', 'mail', 'plan', 'ledger']);
});

test('while Atlas is not pinned it heads the list', () => {
  assert.deepEqual(botRows(stateOf(), {pins: []}).map(r => r.id), ['atlas', 'ops', 'mail', 'plan', 'ledger']);
});

test('the saved order wins among siblings', () => {
  const rows = botRows(stateOf(), {pins: ['atlas'], order: ['ledger', 'ops', 'plan', 'mail']});
  assert.deepEqual(rows.slice(1).map(r => r.id), ['ledger', 'ops', 'plan', 'mail']);
});

test('every row says which bot it reports to, so a block of rows can move together', () => {
  const rows = botRows(stateOf(), {pins: []});
  assert.deepEqual(rows.map(r => [r.id, r.team]), [['atlas', null], ['ops', 'atlas'], ['mail', 'ops'], ['plan', 'ops'], ['ledger', 'atlas']]);
});

test('activity never reorders the sidebar', () => {
  const quiet = botRows(stateOf(), {pins: []}).map(r => r.id);
  const chats = {ledger: [{id: 'm', role: 'user', text: 'hi', at: '2026-11-11T09:00:00Z'}]};
  assert.deepEqual(botRows(stateOf({chats}), {pins: []}).map(r => r.id), quiet);
});

test('hidden bots are left out, but Atlas cannot be hidden', () => {
  const rows = botRows(stateOf(), {hidden: ['ledger', 'atlas']});
  assert.equal(rowOf(rows, 'ledger'), undefined);
  assert.ok(rowOf(rows, 'atlas'));
});

test('a query matches a bot name or its job', () => {
  assert.deepEqual(botRows(stateOf(), {query: 'mail'}).map(r => r.id), ['mail']);
  assert.deepEqual(botRows(stateOf(), {query: 'WEEK'}).map(r => r.id), ['plan']);
  assert.deepEqual(botRows(stateOf(), {query: 'zzz'}), []);
});

test('a row previews its own chat, with You: before the owner\'s words', () => {
  const chats = {mail: [
    {id: '1', role: 'bot', text: 'Two new emails.', senderId: 'mail', at: '2026-11-11T08:00:00Z'},
    {id: '2', role: 'user', text: 'Reply to Northwind', at: '2026-11-11T09:00:00Z'},
  ], plan: [{id: '3', role: 'bot', text: 'Planned.', senderId: 'plan', at: '2026-11-10T09:00:00Z'}]};
  const rows = botRows(stateOf({chats}));
  assert.equal(rowOf(rows, 'mail').preview, 'You: Reply to Northwind');
  assert.equal(rowOf(rows, 'mail').at, '2026-11-11T09:00:00Z');
  assert.equal(rowOf(rows, 'plan').preview, 'Planned.');
  assert.equal(rowOf(rows, 'ledger').preview, '');
  assert.equal(rowOf(rows, 'ledger').at, '');
});

test('a row previews the last thing said, not a system line after it', () => {
  const s = stateOf({chats: {mail: [{role: 'bot', text: 'Sent it.', at: '2026-11-11T10:00:00Z'}, {role: 'system', text: 'Done in 2 step(s).', at: '2026-11-11T10:00:01Z'}]}});
  assert.equal(rowOf(botRows(s), 'mail').preview, 'Sent it.');
});

test('a row never previews a bot\'s working step, only what it answered or was asked', () => {
  const s = stateOf({chats: {mail: [
    {role: 'user', text: 'Find jobs', at: '2026-11-11T10:00:00Z'},
    {role: 'bot', text: 'Looking.', step: true, at: '2026-11-11T10:00:05Z'},
  ]}});
  assert.equal(rowOf(botRows(s), 'mail').preview, 'You: Find jobs');
});

test('botStatus and botIsManager answer for one bot, outside the list', () => {
  const s = stateOf({groupRuns: [run({status: 'running', recipients: ['mail']})]});
  assert.equal(botStatus(s, 'mail'), 'working');
  assert.equal(botStatus(s, 'plan'), 'asleep');
  assert.equal(botStatus(s, 'atlas'), 'awake');
  assert.equal(botStatus(s, 'nobody'), 'asleep');
  assert.equal(botIsManager(s, 'ops'), true);
  assert.equal(botIsManager(s, 'atlas'), false);
});

test('a row counts what waits on the person in its own chat', () => {
  const rows = botRows(stateOf({groupRuns: [run({status: 'awaiting_checkpoint'})]}));
  assert.equal(rowOf(rows, 'mail').needs, 1);
  assert.equal(rowOf(rows, 'plan').needs, 0);
});

test('a bot reporting to a missing manager still appears', () => {
  const lost = bot('lost', 'Lost', {reportsTo: 'gone'}, 'x');
  const rows = botRows(stateOf({groups: [company([atlas, lost])]}));
  assert.ok(rowOf(rows, 'lost'));
});

test('a reportsTo cycle cannot hang the list', () => {
  const a = bot('a', 'A', {reportsTo: 'b'}), b = bot('b', 'B', {reportsTo: 'a'});
  const rows = botRows(stateOf({groups: [company([atlas, a, b])]}));
  assert.deepEqual(rows.map(r => r.id).sort(), ['a', 'atlas', 'b']);
});

test('botRows copes with an empty workspace', () => {
  assert.deepEqual(botRows(undefined), []);
  assert.deepEqual(botRows({groups: []}), []);
});

// ---- threadRows ----

// Built from local calendar parts: "today" is the reader's day, so the fixture must be too.
const local = (day, hour, minute = 0) => new Date(2026, 10, day, hour, minute).toISOString();
const NOW = new Date(2026, 10, 11, 15).getTime();
const threadState = (extra = {}) => stateOf({
  groups: [company([atlas, mail, plan]), thread('t1', 'Northwind call'), thread('t2', 'Trip to Lisbon'), thread('t3', 'Old idea')],
  chats: {
    'team-t1': [{id: 'a', role: 'user', text: 'Reply to Northwind', at: local(11, 12)}],
    'team-t2': [{id: 'b', role: 'bot', text: 'Flights found.', senderId: 'atlas', at: local(11, 14)}],
    'team-t3': [{id: 'c', role: 'bot', text: 'Parked.', senderId: 'atlas', at: local(8, 10)}],
  },
  ...extra,
});

test('threadRows lists only threads, newest first, split into today and earlier', () => {
  const rows = threadRows(threadState(), {now: NOW});
  assert.deepEqual(rows.today.map(r => r.id), ['t2', 't1']);
  assert.deepEqual(rows.earlier.map(r => r.id), ['t3']);
  assert.deepEqual(rows.waiting, []);
});

test('a thread waiting on the person moves to waiting and out of today', () => {
  const waiting = run({id: 'r9', groupId: 't1', chatKey: 'team-t1', status: 'awaiting_checkpoint', recipients: ['atlas']});
  const rows = threadRows(threadState({groupRuns: [waiting]}), {now: NOW});
  assert.deepEqual(rows.waiting.map(r => r.id), ['t1']);
  assert.deepEqual(rows.today.map(r => r.id), ['t2']);
  assert.equal(rows.waiting[0].needs, 1);
});

test('a page request also counts as waiting', () => {
  const awaiting = run({id: 'r9', groupId: 't3', chatKey: 'team-t3', status: 'awaiting_browser', recipients: ['atlas']});
  assert.deepEqual(threadRows(threadState({groupRuns: [awaiting]}), {now: NOW}).waiting.map(r => r.id), ['t3']);
});

test('a thread row has a title, a preview, a time and Atlas\'s face', () => {
  const [row] = threadRows(threadState(), {now: NOW}).today.slice(1);
  assert.equal(row.title, 'Northwind call');
  assert.equal(row.preview, 'You: Reply to Northwind');
  assert.equal(row.at, local(11, 12));
  assert.equal(row.chatKey, 'team-t1');
  assert.match(row.face, /<svg /);
});

test('a thread with no messages still shows, by its creation time', () => {
  const fresh = thread('t4', 'Just made');
  fresh.createdAt = local(11, 14, 30);
  const rows = threadRows(threadState({groups: [company([atlas]), fresh]}), {now: NOW});
  assert.deepEqual(rows.today.map(r => r.id), ['t4']);
  assert.equal(rows.today[0].preview, '');
});

test('threadRows copes with an empty workspace', () => {
  assert.deepEqual(threadRows(undefined), {waiting: [], today: [], earlier: []});
});

// ---- handoffs ----

test('handoffs reads a change of bot as a handoff carrying the earlier bot\'s words', () => {
  const r = run({trace: [
    {botId: 'atlas', output: 'Is Wednesday free? @Planner'},
    {botId: 'plan', output: 'Wednesday 11:00 is free.'},
    {botId: 'atlas', output: 'Done.'},
  ]});
  assert.deepEqual(handoffs(r), [
    {from: 'atlas', to: 'plan', text: 'Is Wednesday free? @Planner'},
    {from: 'plan', to: 'atlas', text: 'Wednesday 11:00 is free.'},
  ]);
});

test('handoffs shows a bot-to-bot ask and its answer', () => {
  const r = run({trace: [
    {botId: 'atlas', kind: 'ask', to: 'mail', task: 'Reply to Northwind'},
    {botId: 'mail', kind: 'peer', to: 'atlas', output: 'Sent.'},
  ]});
  assert.deepEqual(handoffs(r), [
    {from: 'atlas', to: 'mail', text: 'Reply to Northwind'},
    {from: 'mail', to: 'atlas', text: 'Sent.'},
  ]);
});

test('a last step addressed to a bot that has not answered yet is a hop on its way', () => {
  const r = run({status: 'running', trace: [{botId: 'atlas', output: 'go', toBotId: 'mail'}]});
  assert.deepEqual(handoffs(r), [{from: 'atlas', to: 'mail', text: 'go'}]);
  assert.deepEqual(handoffs(run({trace: [{botId: 'atlas', output: 'done', toBotId: 'None'}]})), []);
});

test('handoffs is empty when one bot did everything, or there is no run', () => {
  assert.deepEqual(handoffs(run({trace: [{botId: 'atlas', output: 'Hi'}]})), []);
  assert.deepEqual(handoffs(undefined), []);
});

// ---- progressPill ----

const threadRun = (extra = {}) => run({groupId: 't1', chatKey: 'team-t1', recipients: ['atlas', 'plan', 'atlas'], ...extra});
const pill = (r, s = stateOf()) => progressPill(r, s);

test('progress starts with Atlas thinking it through', () => {
  assert.deepEqual(pill(threadRun({recipients: ['atlas'], trace: []})), {botId: 'atlas', text: 'Thinking it through'});
});

test('an ask in flight reads "Checking with <Bot>", with the asked bot\'s face', () => {
  const task = 'Please check whether the Northwind invoice from last month was paid and tell me the amount.';
  const out = pill(threadRun({trace: [{botId: 'atlas', output: 'x'}, {botId: 'atlas', kind: 'ask', to: 'mail', task}], currentStep: 1}));
  assert.deepEqual(out, {botId: 'mail', text: 'Checking with Mailroom'});
});

test('a bot handed the turn by another reads as the hop in progress', () => {
  const out = pill(threadRun({trace: [{botId: 'atlas', output: '@Planner plan it'}], currentStep: 1}));
  assert.deepEqual(out, {botId: 'plan', text: 'Checking with Planner'});
});

test('a run waiting on the person says it needs your input', () => {
  const out = pill(threadRun({status: 'awaiting_checkpoint', trace: [{botId: 'atlas', output: 'x'}], currentStep: 1}));
  assert.deepEqual(out, {botId: 'plan', text: 'Needs your input'});
});

test('a helper handing back to Atlas reads as that hop', () => {
  const out = pill(threadRun({trace: [{botId: 'atlas', output: 'x'}, {botId: 'plan', output: 'y'}], currentStep: 2}));
  assert.deepEqual(out, {botId: 'atlas', text: 'Checking with Atlas'});
});

test('a finished run becomes a quiet pill naming its latest hop', () => {
  const out = pill(threadRun({status: 'completed', trace: [
    {botId: 'atlas', output: 'a'}, {botId: 'plan', output: 'b'},
    {botId: 'atlas', kind: 'ask', to: 'mail', task: 'c'}, {botId: 'mail', kind: 'peer', to: 'atlas', output: 'd'},
    {botId: 'atlas', output: 'e'},
  ], currentStep: 3}));
  assert.deepEqual(out, {done: true, text: 'Planner messaged Atlas'});
});

test('one hop reads as that hop', () => {
  const out = pill(threadRun({status: 'completed', trace: [{botId: 'atlas', output: 'a'}, {botId: 'plan', output: 'b'}]}));
  assert.deepEqual(out, {done: true, text: 'Atlas messaged Planner'});
});

test('a chain of three hops names only the last one', () => {
  const out = pill(threadRun({status: 'completed', trace: [
    {botId: 'atlas', output: 'a'}, {botId: 'plan', output: 'b'}, {botId: 'mail', output: 'c'}, {botId: 'ledger', output: 'd'},
  ]}), stateOf());
  assert.equal(out.text, 'Mailroom messaged Ledger');
});

test('no pill when Atlas did it alone, or the run failed, or there is no run', () => {
  assert.equal(pill(threadRun({status: 'completed', trace: [{botId: 'atlas', output: 'a'}]})), null);
  assert.equal(pill(threadRun({status: 'failed'})), null);
  assert.equal(pill(threadRun({status: 'cancelled'})), null);
  assert.equal(pill(undefined), null);
});

test('a deleted bot never crashes the pill', () => {
  const out = pill(threadRun({trace: [{botId: 'atlas', output: 'x'}], currentStep: 1, recipients: ['atlas', 'ghost']}));
  assert.equal(out.text, 'Checking with A bot');
});

test('a bot-chat run says it is working from the first moment, and the phrase moves on calmly', () => {
  const r = run({recipients: ['mail'], trace: [], startedAt: '2026-11-12T00:00:00Z'});
  const at = s => progressPill(r, stateOf(), {now: Date.parse('2026-11-12T00:00:00Z') + s * 1000}).text;
  assert.equal(at(0), 'Working on it');
  assert.equal(at(5), 'Working on it', 'a phrase holds for a while');
  assert.notEqual(at(20), 'Working on it');
});

test('while a page is open the line says it is reading, and clicking when it acts on the page', () => {
  const r = run({id: 'rb', recipients: ['mail'], trace: [], status: 'awaiting_browser'});
  const s = {...stateOf(), browserRequests: [{id: 'q', runId: 'rb', status: 'dispatched', steps: []}]};
  assert.deepEqual(progressPill(r, s), {botId: 'mail', text: 'Doing some reading'});
  s.browserRequests[0].steps = [{op: 'click', index: 2}];
  assert.equal(progressPill(r, s).text, 'Clicking through pages');
});

// ---- chatStatus ----

test('a bot chat header says what the bot can do', () => {
  assert.equal(chatStatus(stateOf(), 'mail'), 'One continuous chat');
  assert.equal(chatStatus(stateOf(), 'ops'), 'Hands work to its team');
  assert.equal(chatStatus(stateOf(), 'atlas'), 'Hands work to any bot');
});

test('chatStatus for an unknown bot is the plain one', () => {
  assert.equal(chatStatus(stateOf(), 'nobody'), 'One continuous chat');
  assert.equal(chatStatus(undefined, 'mail'), 'One continuous chat');
});

// ---- routes ----

const rs = stateOf({groups: [company([atlas, ops, mail, plan]), thread('t1', 'Northwind call')]});
const route = hash => companyRoute(hash, rs);

test('the new routes parse', () => {
  assert.deepEqual(route('#bot/mail'), {bot: 'mail'});
  assert.deepEqual(route('#thread/t1'), {thread: 't1'});
  assert.deepEqual(route('#profile/mail'), {profile: 'mail'});
  assert.deepEqual(route('#profile/mail/memory'), {profile: 'mail', sub: 'memory'});
  assert.deepEqual(route('#settings'), {settings: ''});
  assert.deepEqual(route('#settings/models'), {settings: 'models'});
  assert.deepEqual(route('#new-bot'), {newBot: true});
  assert.deepEqual(route('#new-bot/watch%20my%20inbox'), {newBot: true, job: 'watch my inbox'});
  assert.deepEqual(route('#new-thread'), {newThread: true});
  assert.deepEqual(route('#company'), {company: true});
  assert.deepEqual(route('#activity'), {activity: true});
  assert.deepEqual(route('#chats'), {home: true});
});

test('every profile sub-page parses and an unknown one is dropped', () => {
  for (const sub of ['memory', 'activity', 'permissions', 'model', 'computer', 'team', 'edit']) {
    assert.deepEqual(route(`#profile/mail/${sub}`), {profile: 'mail', sub});
  }
  assert.deepEqual(route('#profile/mail/nope'), {profile: 'mail'});
});

test('a route to something that does not exist falls back to home', () => {
  assert.deepEqual(route('#bot/ghost'), {home: true});
  assert.deepEqual(route('#thread/ghost'), {home: true});
  assert.deepEqual(route('#thread/home'), {home: true});
  assert.deepEqual(route('#profile/ghost'), {home: true});
  assert.deepEqual(route('#whatever'), {home: true});
  assert.deepEqual(route(''), {home: true});
  assert.deepEqual(route(undefined), {home: true});
});

test('old chat hashes map to the nearest new route', () => {
  assert.deepEqual(route('#chat/mail'), {bot: 'mail'});
  assert.deepEqual(route('#chat/team-t1'), {thread: 't1'});
  assert.deepEqual(route('#chat/team-home'), {bot: 'atlas'});
  assert.deepEqual(route('#group/t1'), {thread: 't1'});
  assert.deepEqual(route('#group/home'), {bot: 'atlas'});
  assert.deepEqual(route('#chat/mail/info'), {profile: 'mail'});
  assert.deepEqual(route('#chat/mail/info/memory'), {profile: 'mail', sub: 'memory'});
  assert.deepEqual(route('#chat/mail/info/edit'), {profile: 'mail', sub: 'edit'});
  assert.deepEqual(route('#chat/mail/info/tasks'), {profile: 'mail', sub: 'activity'});
  assert.deepEqual(route('#chat/team-t1/info'), {thread: 't1'});
});

test('old page and inbox hashes map to Settings and home', () => {
  assert.deepEqual(route('#you'), {settings: ''});
  assert.deepEqual(route('#you/ai'), {settings: 'ai'});
  assert.deepEqual(route('#ai'), {settings: 'ai'});
  assert.deepEqual(route('#inbox'), {home: true});
});

test('companyHash writes every route and parse reads it back', () => {
  const routes = [
    {bot: 'mail'}, {thread: 't1'}, {profile: 'mail'}, {profile: 'mail', sub: 'team'}, {settings: ''}, {settings: 'models'},
    {newBot: true}, {newBot: true, job: 'watch my inbox'}, {newThread: true}, {company: true}, {activity: true}, {home: true},
  ];
  for (const r of routes) assert.deepEqual(route(`#${companyHash(r)}`), r, JSON.stringify(r));
  assert.equal(companyHash({home: true}), 'chats');
  assert.equal(companyHash({}), 'chats');
  assert.equal(companyHash({bot: 'mail'}), 'bot/mail');
});

test('ids with slashes are encoded in hashes', () => {
  assert.equal(companyHash({bot: 'a/b'}), 'bot/a%2Fb');
  const s = stateOf({groups: [company([atlas, bot('a/b', 'Slashy')])]});
  assert.deepEqual(companyRoute('#bot/a%2Fb', s), {bot: 'a/b'});
});

test('a thread at work says what it is doing, under the face of the bot doing it', () => {
  const live = run({id: 'r7', groupId: 't3', chatKey: 'team-t3', status: 'running', recipients: ['atlas', 'mail'], currentStep: 1, startedAt: local(11, 12), trace: [{botId: 'atlas', output: '@Mailroom draft it'}]});
  const rows = threadRows(threadState({groupRuns: [live]}), {now: NOW}), row = [...rows.today, ...rows.earlier].find(r => r.id === 't3');
  assert.equal(row.working, true);
  assert.equal(row.activity, 'Checking with Mailroom');
  assert.equal(row.faceBot, 'mail');
  assert.match(row.face, /face--working/);
});

test('a thread or bot with an answer newer than when the person last opened it is unread', () => {
  const s = threadState();
  const t1 = threadRows(s, {now: NOW}).today.find(r => r.id === 't1');
  // t1's newest line is the owner's own: nothing to read.
  assert.equal(t1.unread, false);
  const answered = {...s, chats: {...s.chats, 'team-t1': [...(s.chats['team-t1'] || []), {role: 'bot', senderId: 'atlas', text: 'Drafted.', at: local(11, 13)}]}};
  assert.equal(threadRows(answered, {now: NOW}).today.find(r => r.id === 't1').unread, true);
  assert.equal(threadRows(answered, {now: NOW, seen: {'team-t1': local(11, 13, 30)}}).today.find(r => r.id === 't1').unread, false);
  const bots = stateOf({chats: {mail: [{role: 'bot', senderId: 'mail', text: 'Two new emails.', at: '2026-11-11T08:00:00Z'}]}});
  assert.equal(rowOf(botRows(bots), 'mail').unread, true);
  assert.equal(rowOf(botRows(bots, {seen: {mail: '2026-11-11T09:00:00Z'}}), 'mail').unread, false);
});

test('a thread whose run stopped says so, with the reason, until a bot answers again', () => {
  const failed = run({id: 'r5', groupId: 't1', chatKey: 'team-t1', status: 'failed', error: 'Atlas kept asking for pages it already had, so the task stopped.', recipients: ['atlas'], createdAt: local(11, 12, 1), completedAt: local(11, 12, 5)});
  const row = threadRows(threadState({groupRuns: [failed]}), {now: NOW}).today.find(r => r.id === 't1');
  assert.equal(row.stopped, true);
  assert.equal(row.preview, 'Atlas kept asking for pages it already had, so the task stopped.');
  const s = threadState({groupRuns: [failed]});
  s.chats['team-t1'].push({id: 'z', role: 'bot', text: 'Here it is.', senderId: 'atlas', at: local(11, 13)});
  const again = threadRows(s, {now: NOW}).today.find(r => r.id === 't1');
  assert.equal(again.stopped, false);
  assert.equal(again.preview, 'Here it is.');
});

test('a run the person stopped is not flagged', () => {
  const cancelled = run({id: 'r6', groupId: 't1', chatKey: 'team-t1', status: 'cancelled', error: 'Stopped.', recipients: ['atlas'], createdAt: local(11, 12, 1), completedAt: local(11, 12, 5)});
  const row = threadRows(threadState({groupRuns: [cancelled]}), {now: NOW}).today.find(r => r.id === 't1');
  assert.equal(row.stopped, false);
  assert.equal(row.preview, 'You: Reply to Northwind');
});

test('a bot chat whose last run stopped says so on its row', () => {
  const failed = run({id: 'r7', chatKey: 'mail', status: 'failed', error: 'The model did not answer.', createdAt: '2026-11-11T10:00:00Z', completedAt: '2026-11-11T10:01:00Z'});
  const s = stateOf({groups: [company([atlas, mail])], chats: {mail: [{id: 'u', role: 'user', text: 'Check mail', at: '2026-11-11T09:59:00Z'}]}, groupRuns: [failed]});
  const row = rowOf(botRows(s), 'mail');
  assert.equal(row.stopped, true);
  assert.equal(row.preview, 'The model did not answer.');
});
