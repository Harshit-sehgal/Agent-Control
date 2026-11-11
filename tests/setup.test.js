/** The setup block: a bot proposes a change, the owner taps Apply. And what the primary bot knows. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSetupRequests, stripSetupBlocks, resolveSetup, modelFor, setupCardOf, setupButton, workspaceBrief, setupDone} from '../shared/setup.js';
import {CONTROL_FENCES} from '../shared/reply-blocks.js';

const state = {
  groups: [{id: 'home', bots: [{id: 'atlas', name: 'Atlas', instructions: 'Hands work out.', settings: {lead: true}}, {id: 'rep', name: 'Replier', instructions: 'Drafts short, polite replies to emails.'}]}],
  ai: {
    providers: [
      {id: 'p1', label: 'My Claude', kind: 'local-cli', engine: 'claude'},
      {id: 'p2', label: 'Groq', kind: 'api', host: 'api.groq.com', chatModels: ['llama-3.3-70b-versatile', 'qwen/qwen3-32b']},
    ],
    defaultProviderId: 'p2', defaultModel: 'llama-3.3-70b-versatile', bots: {rep: {providerId: 'p1', model: 'haiku-5.5'}},
  },
};
const block = body => `Sure.\n\`\`\`setup\n${JSON.stringify(body)}\n\`\`\``;

test('setup is one of the control fences, and the block is read and stripped', () => {
  assert.ok(CONTROL_FENCES.includes('setup'));
  const out = block({action: 'model', bot: 'Replier', provider: 'My Claude', model: 'haiku'});
  assert.deepEqual(parseSetupRequests(out).map(r => r.ok), [true]);
  assert.equal(stripSetupBlocks(out), 'Sure.');
  assert.equal(parseSetupRequests('```setup\nnot json\n```')[0].ok, false);
  assert.match(parseSetupRequests(block({action: 'delete-everything'}))[0].error, /not something setup can do/);
});

test('a model change names the bot and the model the owner will see, in the provider\'s own ids', () => {
  const [{request}] = parseSetupRequests(block({action: 'model', bot: 'replier', provider: 'Claude', model: 'Claude Haiku 5.5'}));
  const out = resolveSetup(state, request);
  assert.equal(out.ok, true);
  assert.deepEqual(out.card, {action: 'model', botId: 'rep', providerId: 'p1', model: 'haiku', text: 'Replier uses My Claude · haiku'});
  // Left out, the bot is everyone's default; a key provider's id is matched against its list.
  const def = resolveSetup(state, {action: 'model', provider: 'groq', model: 'qwen3-32b'});
  assert.deepEqual(def.card, {action: 'model', providerId: 'p2', model: 'qwen/qwen3-32b', text: "Everyone's default model: Groq · qwen/qwen3-32b"});
});

test('"me" is the bot that wrote the block', () => {
  const out = resolveSetup(state, {action: 'model', bot: 'me', provider: 'My Claude', model: 'sonnet'}, {speaker: state.groups[0].bots[1]});
  assert.equal(out.card.botId, 'rep');
});

test('what cannot be done says why, naming what can', () => {
  assert.match(resolveSetup(state, {action: 'model', bot: 'Nobody', provider: 'Groq'}).error, /no bot called "Nobody"/);
  assert.match(resolveSetup(state, {action: 'model', provider: 'Gemini'}).error, /Connected: My Claude, Groq/);
  assert.match(resolveSetup(state, {action: 'model', provider: 'Groq', model: 'gpt-9'}).error, /Groq has no model "gpt-9"\. It offers llama/);
  assert.match(resolveSetup({ai: {}}, {action: 'model', provider: 'x'}).error, /Models and keys/);
  assert.match(resolveSetup(state, {action: 'job', bot: 'Replier', job: 'short'}).error, /20 to 3000/);
  assert.match(resolveSetup(state, {action: 'open', page: 'secrets'}).error, /no "secrets" page/);
});

test('modelFor keeps a full Claude id and refuses a flag-like name', () => {
  assert.deepEqual(modelFor({kind: 'local-cli', engine: 'claude'}, 'claude-haiku-5-5'), {ok: true, model: 'claude-haiku-5-5'});
  assert.deepEqual(modelFor({kind: 'local-cli', engine: 'claude'}, 'OPUS'), {ok: true, model: 'opus'});
  assert.equal(modelFor({kind: 'local-cli', engine: 'codex'}, '--yolo').ok, false);
  assert.deepEqual(modelFor({kind: 'api', chatModels: []}, 'anything'), {ok: true, model: 'anything'});
});

test('job and open cards, and the card read back from a stored message', () => {
  const job = resolveSetup(state, {action: 'job', bot: 'Replier', job: 'Drafts short, warm replies and signs them with my name.'});
  assert.equal(job.card.action, 'job');
  assert.match(job.card.text, /^New job for Replier: “Drafts/);
  const open = resolveSetup(state, {action: 'open', page: 'keys'});
  assert.deepEqual(open.card, {action: 'open', section: 'models', text: 'Settings → Models and keys'});
  assert.equal(setupButton(open.card), 'Open Models and keys');
  assert.equal(setupButton(job.card), 'Apply');
  assert.deepEqual(setupCardOf({setup: JSON.stringify(open.card)}), open.card);
  assert.equal(setupCardOf({setup: '{"action":"open","section":"../../admin"}'}), null);
  assert.equal(setupCardOf({setup: 'nope'}), null);
});

test('a card is done once the change is what the app already has', async () => {
  const {setupDone} = await import('../shared/setup.js');
  assert.equal(setupDone(state, {action: 'model', botId: 'rep', providerId: 'p1', model: 'haiku-5.5'}), true);
  assert.equal(setupDone(state, {action: 'model', botId: 'rep', providerId: 'p1', model: 'haiku'}), false);
  assert.equal(setupDone(state, {action: 'model', providerId: 'p2', model: 'llama-3.3-70b-versatile'}), true);
  assert.equal(setupDone(state, {action: 'job', botId: 'rep', job: 'Drafts short, polite replies to emails.'}), true);
  assert.equal(setupDone(state, {action: 'open', section: 'models'}), false);
});

test('the primary bot is told the models, each bot\'s model, this computer and how the app works', () => {
  const brief = workspaceBrief(state, {agents: [{name: 'This computer', online: true, permissions: ['browser.action', 'model.run'], cli: {claude: 'signed-in', codex: 'missing'}}], connectors: [{name: 'Gmail', status: 'ready'}]});
  assert.match(brief.you, /You are Atlas, the primary bot/);
  assert.deepEqual(brief.models[0], {name: 'My Claude', kind: 'Claude subscription, runs on this computer', models: ['opus', 'sonnet', 'haiku']});
  assert.equal(brief.models[1].default, true);
  assert.equal(brief.defaultModel, 'Groq · llama-3.3-70b-versatile');
  assert.deepEqual(brief.bots.map(b => [b.name, b.model]), [['Atlas', 'the default'], ['Replier', 'My Claude · haiku-5.5']]);
  assert.equal(brief.computer, 'This computer: online, opens web pages, claude signed in, codex not installed');
  assert.deepEqual(brief.connectors, ['Gmail']);
  assert.ok(brief.facts.some(f => /Never ask for a key/.test(f)));
  assert.ok(!JSON.stringify(brief).includes('secret'), 'no key or secret field is ever copied');
  assert.equal(workspaceBrief({}, {}).computer, 'no computer connected');
});

test('the brief also carries the saved rules, what waits on the owner and the open threads', () => {
  const withMore = {
    ...state,
    groups: [...state.groups, {id: 'th1', name: 'Sam reply', bots: [], settings: {kind: 'thread'}}],
    grants: [{botId: 'rep', action: 'browser.use', scope: 'https://example.org', choice: 'always'}, {botId: 'gone', action: 'browser.use', scope: 'x', choice: 'deny'}],
    asks: [{id: 'a', botId: 'atlas', status: 'pending', action: 'browser.use', target: 'example.com'}, {id: 'b', status: 'answered'}],
  };
  const brief = workspaceBrief(withMore, {});
  assert.deepEqual(brief.rules, ['Replier: Always allow browser.use https://example.org']);
  assert.deepEqual(brief.waitingOnOwner, ['Atlas wants to open example.com.']);
  assert.deepEqual(brief.threads, ['Sam reply']);
  assert.ok(brief.facts.some(f => /MCP server.*On my computer/.test(f)));
  const empty = workspaceBrief({}, {});
  assert.equal(empty.rules, 'none');
  assert.equal(empty.waitingOnOwner, 'nothing');
});

test('rename, settings and rule cards: what Settings can change, a bot proposes', async () => {
  const {resolveSetup, setupDone, setupCardOf, parseSetupRequests} = await import('../shared/setup.js');
  const rename = resolveSetup(state, {action: 'rename', bot: 'Replier', name: 'Mailer'});
  assert.deepEqual(rename.card, {action: 'rename', botId: 'rep', name: 'Mailer', text: 'Rename Replier to Mailer'});
  assert.match(resolveSetup(state, {action: 'rename', bot: 'Replier', name: 'Atlas'}).error, /already called Atlas/);

  const [{request}] = parseSetupRequests(block({action: 'settings', bot: 'Replier', settings: {replyLength: 'short', style: 'Warm and brief', memory: false, enabled: false, reportsTo: 'Atlas', lead: true, browserApproval: 'auto'}}));
  const settings = resolveSetup(state, request);
  assert.equal(settings.ok, true, settings.error);
  assert.deepEqual(settings.card.settings, {replyLength: 'short', style: 'Warm and brief', memory: false, enabled: false, reportsTo: 'atlas'}, 'lead and browserApproval are not something a bot can change');
  assert.equal(settings.card.text, 'Replier: short replies, style “Warm and brief”, no memory, switched off, reports to Atlas');
  assert.match(resolveSetup(state, {action: 'settings', bot: 'Replier', settings: {replyLength: 'huge'}}).error, /reply length/i);
  assert.match(resolveSetup(state, {action: 'settings', bot: 'Replier', settings: {lead: true}}).error, /nothing to change/);
  assert.equal(setupDone(state, settings.card), false);

  const rule = resolveSetup(state, {action: 'rule', bot: 'Replier', do: 'open', site: 'docs.example.org/path', choice: 'always'});
  assert.deepEqual(rule.card, {action: 'rule', botId: 'rep', act: 'browser.use', scope: 'https://docs.example.org', choice: 'always', text: 'Replier: Always allow · Open docs.example.org'});
  assert.match(resolveSetup(state, {action: 'rule', bot: 'Replier', do: 'spend', choice: 'always'}).error, /payment is asked every time/);
  assert.match(resolveSetup(state, {action: 'rule', bot: 'Replier', do: 'open', site: 'x', choice: 'maybe'}).error, /always, ask or deny/);
  const ruled = {...state, grants: [{botId: 'rep', action: 'browser.use', scope: 'https://docs.example.org', choice: 'always'}]};
  assert.equal(setupDone(ruled, rule.card), true);
  for (const card of [rename.card, settings.card, rule.card]) assert.deepEqual(setupCardOf({setup: JSON.stringify(card)}), card);
  assert.equal(setupCardOf({setup: JSON.stringify({...rule.card, act: 'rm -rf'})}), null);
});

test('every bot is told the workspace; one that is not the primary is told who it is and who sets things up', () => {
  const brief = workspaceBrief(state, {speaker: state.groups[0].bots[1]});
  assert.match(brief.you, /^You are Replier\. Atlas is the primary bot/);
  assert.ok(Array.isArray(brief.bots) && brief.models.length === 2);
  assert.match(workspaceBrief(state, {speaker: state.groups[0].bots[0]}).you, /You are Atlas, the primary bot/);
});

test('a team card turns on "Approve between steps" and the step limit for the speaker\'s group', async () => {
  const {setupDone} = await import('../shared/setup.js');
  const atlas = state.groups[0].bots[0];
  const [ask] = parseSetupRequests(block({action: 'team', settings: {checkpoints: true, maxSteps: 4}}));
  const out = resolveSetup(state, ask.request, {speaker: atlas});
  assert.equal(out.ok, true, out.error);
  assert.deepEqual(out.card, {action: 'team', groupId: 'home', settings: {checkpoints: true, maxSteps: 4}, text: 'This team: asks you before each step, at most 4 steps'});
  assert.deepEqual(setupCardOf({setup: JSON.stringify(out.card)}), out.card);
  assert.equal(setupDone(state, out.card), false);
  assert.equal(setupDone({groups: [{...state.groups[0], settings: {checkpoints: true, maxSteps: 4}}]}, out.card), true);
  assert.match(resolveSetup(state, {action: 'team', settings: {routing: 'everyone'}}, {speaker: atlas}).error, /checkpoints/);
  assert.match(resolveSetup(state, {action: 'team', settings: {maxSteps: 99}}, {speaker: atlas}).error, /step limit/i);
  assert.match(resolveSetup(state, {action: 'team', team: 'Nowhere', settings: {checkpoints: true}}, {speaker: atlas}).error, /no team/);
  assert.equal(setupCardOf({setup: JSON.stringify({action: 'team', groupId: 'home', settings: {pipeline: []}})}), null, 'only the listed keys ride on a card');
});

test('the parser keeps the team a team card names', () => {
  const [ask] = parseSetupRequests(block({action: 'team', team: 'Ops', settings: {checkpoints: false}}));
  assert.equal(ask.request.team, 'Ops');
});

test('the brief says how each bot is set and how each team runs, so a bot knows what is already on', () => {
  const s = {groups: [{id: 'home', name: 'Home', settings: {checkpoints: true, maxSteps: 4}, bots: [
    {id: 'atlas', name: 'Atlas', instructions: 'Hands work out.', settings: {lead: true}},
    {id: 'rep', name: 'Replier', instructions: 'Drafts replies.', settings: {enabled: false, replyLength: 'short', memory: false, reportsTo: 'atlas'}},
  ]}, {id: 't1', name: 'Offsite', settings: {kind: 'thread'}, bots: []}]};
  const brief = workspaceBrief(s);
  const rep = brief.bots.find(b => b.name === 'Replier');
  assert.equal(rep.off, true, 'a bot switched off in its settings is reported off');
  assert.equal(rep.settings, 'short replies, no memory, reports to Atlas');
  assert.equal(brief.bots.find(b => b.name === 'Atlas').settings, undefined, 'defaults are not listed');
  assert.deepEqual(brief.teams, [{name: 'Home', bots: 2, runs: 'asks the owner before each step, at most 4 steps'}]);
});

test('a bot can set how hard another bot (or everyone) thinks, alone or with a model', () => {
  const [only] = parseSetupRequests(block({action: 'model', bot: 'Replier', effort: 'High'}));
  const r = resolveSetup(state, only.request);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual({...r.card, text: undefined}, {action: 'model', botId: 'rep', effort: 'high', text: undefined});
  assert.equal(r.card.text, 'Replier thinks with high effort');
  assert.equal(setupDone(state, r.card), false);
  assert.equal(setupDone({...state, ai: {...state.ai, bots: {rep: {providerId: 'p1', model: 'haiku-5.5', effort: 'high'}}}}, r.card), true);
  assert.ok(setupCardOf({setup: JSON.stringify(r.card)}), 'an effort-only card is a valid card');

  const both = resolveSetup(state, parseSetupRequests(block({action: 'model', bot: 'Replier', provider: 'Groq', model: 'qwen/qwen3-32b', effort: 'low'}))[0].request);
  assert.equal(both.card.effort, 'low');
  assert.equal(both.card.text, 'Replier uses Groq · qwen/qwen3-32b, low effort');

  const everyone = resolveSetup(state, parseSetupRequests(block({action: 'model', effort: 'default'}))[0].request);
  assert.deepEqual([everyone.card.effort, everyone.card.text], ['', "Everyone's effort: the model's own default"]);

  const bad = resolveSetup(state, parseSetupRequests(block({action: 'model', bot: 'Replier', effort: 'ludicrous'}))[0].request);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /low, medium or high/);
});

test('the brief says each bot\'s effort and the workspace default', () => {
  const brief = workspaceBrief({...state, ai: {...state.ai, defaultEffort: 'medium', bots: {rep: {providerId: 'p1', model: 'haiku-5.5', effort: 'high'}}}});
  assert.equal(brief.bots.find(b => b.name === 'Replier').model, 'My Claude · haiku-5.5 · high effort');
  assert.equal(brief.defaultModel, 'Groq · llama-3.3-70b-versatile · medium effort');
});
