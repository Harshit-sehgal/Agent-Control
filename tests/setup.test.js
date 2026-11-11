/** The setup block: a bot proposes a change, the owner taps Apply. And what the primary bot knows. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSetupRequests, stripSetupBlocks, resolveSetup, modelFor, setupCardOf, setupButton, workspaceBrief} from '../shared/setup.js';
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
