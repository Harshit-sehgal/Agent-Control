import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOT_CREATE_PERMISSION, MAX_BOTS_PER_GROUP, MIN_BOT_JOB,
  validateCreateBotRequest, parseCreateBotRequests, stripCreateBotBlocks,
  buildCreatedBot, botCreatedText, nameFromSentence, firstUnusedTint,
} from '../shared/bot-create.js';
import {createBotsFromReply} from '../src/bot-create.js';

const makeId = (() => { let n = 0; return () => `new-${++n}`; })();
const at = '2026-01-01T00:00:00.000Z';
const creator = {id: 'writer', name: 'Writer', permissions: [BOT_CREATE_PERMISSION]};
const blockFor = (body, language = 'create-bot') => '```' + language + '\n' + JSON.stringify(body) + '\n```';

/** The slice of a store the creator needs: read, and an update that commits. */
function memoryStore(state) {
  let current = structuredClone(state);
  return {
    read: () => structuredClone(current),
    update: fn => {
      const next = structuredClone(current);
      const result = fn(next);
      current = next;
      return Promise.resolve(result);
    },
    state: () => current,
  };
}
const baseState = () => ({
  groups: [{id: 'g1', name: 'Research team', bots: [{id: 'writer', name: 'Writer', permissions: [BOT_CREATE_PERMISSION]}], settings: {pipeline: ['writer']}}],
  events: [],
});

test('a new-bot request needs a name and a real job, and defaults its reply length', () => {
  const request = validateCreateBotRequest({name: '  Source scout  ', job: '  Find posts that mention the project and list their links.  ', style: 'Terse.'});
  assert.equal(request.name, 'Source scout');
  assert.match(request.job, /^Find posts/);
  assert.equal(request.replyLength, 'medium');
  assert.equal(request.style, 'Terse.');
  assert.equal(validateCreateBotRequest({name: 'Named', job: 'x'.repeat(200)}).replyLength, 'medium');
  assert.equal(validateCreateBotRequest({name: 'Named', job: 'x'.repeat(200), replyLength: 'long'}).replyLength, 'long');
  assert.equal(validateCreateBotRequest({name: 'Named', job: 'x'.repeat(200), replyLength: 'huge'}).replyLength, 'medium');
  assert.throws(() => validateCreateBotRequest({name: 'A', job: 'x'.repeat(MIN_BOT_JOB)}), /name/);
  assert.throws(() => validateCreateBotRequest({name: 'Named', job: 'too short'}), /job/);
  assert.throws(() => validateCreateBotRequest(null), /must be an object/);
});

test('create-bot blocks parse one at a time and invalid JSON is reported', () => {
  const [good] = parseCreateBotRequests('```create-bot\n{"name":"Scout","job":"Find posts and list their links."}\n```');
  assert.equal(good.ok, true);
  assert.equal(good.request.name, 'Scout');
  const [bad] = parseCreateBotRequests('```create-bot\n{not json}\n```');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /not valid JSON/);
  const [short] = parseCreateBotRequests(blockFor({name: 'Scout', job: 'short'}));
  assert.equal(short.ok, false);
  assert.match(short.error, /job/);
  const names = ['Aaa', 'Bbb', 'Ccc', 'Ddd', 'Eee', 'Fff'];
  const six = parseCreateBotRequests(names.map(name => blockFor({name, job: 'x'.repeat(50)})).join(''));
  assert.equal(six.length, 6, 'the sixth block must be reported, not silently dropped');
  assert.deepEqual(six.map(x => x.ok), [true, true, true, true, true, false]);
  assert.match(six[5].error, /5 new bots per reply/);
  assert.equal(stripCreateBotBlocks(`Before\n${blockFor({name: 'Scout', job: 'x'.repeat(50)})}\nAfter`), 'Before\n\nAfter');
  assert.equal(stripCreateBotBlocks('No block here.'), 'No block here.');
});

test('a built bot is always custom, unprivileged and owned by its creator', () => {
  const record = buildCreatedBot({name: 'Scout', job: 'Find posts and list their links.', replyLength: 'short', style: 'Terse.'}, {bot: creator, runId: 'run-1', now: at, makeId});
  assert.equal(record.id, 'new-1');
  assert.equal(record.type, 'custom');
  assert.deepEqual(record.permissions, [], 'A model-created bot must start with no capability.');
  assert.equal(record.contract.output.kind, 'text');
  assert.equal(record.settings.replyLength, 'short');
  assert.equal(record.settings.enabled, true);
  assert.deepEqual(record.createdBy, {botId: 'writer', botName: 'Writer', runId: 'run-1', at});
  assert.equal(record.origin, 'bot');
  assert.throws(() => buildCreatedBot({name: 'Only a name'}), /name and a job/);
  // One short line: what bots may do is the same for every bot, so the chat does not repeat it.
  assert.equal(botCreatedText(creator, record, 'Research team'), `${creator.name} created a new bot for this work: ${record.name} in Research team.`);
});

test('a permitted bot creates a lasting teammate and is told what happened', async () => {
  const store = memoryStore(baseState());
  const result = await createBotsFromReply(store, {
    bot: creator,
    groupId: 'g1',
    runId: 'run-1',
    output: `I need help.\n${blockFor({name: 'Source scout', job: 'Find posts that mention the project and list their links.'})}`,
    makeId,
    now: () => at,
  });
  assert.equal(result.created.length, 1);
  const created = result.created[0];
  assert.equal(created.name, 'Source scout');
  assert.equal(result.text, 'I need help.', 'The block must not remain in the reply.');
  assert.equal(store.state().groups[0].bots.length, 2);
  assert.deepEqual(store.state().groups[0].settings.pipeline, ['writer', created.id], 'The new bot joins an explicit pipeline.');
  const event = store.state().events[0];
  assert.equal(event.type, 'bot');
  assert.match(event.message, /Writer created Source scout\./);
  assert.equal(result.lines[0].kind, 'bot-created');
  assert.match(result.lines[0].text, /created a new bot/);
});

test('bot.create is the basic kit: a bot with no permission still makes a bot', async () => {
  const store = memoryStore(baseState());
  const plain = {...creator, permissions: []};
  const result = await createBotsFromReply(store, {bot: plain, groupId: 'g1', output: blockFor({name: 'Source scout', job: 'Find posts that mention the project and list their links.'}), makeId, now: () => at});
  assert.equal(result.created.length, 1);
  assert.equal(store.state().groups[0].bots.length, 2);
  assert.deepEqual(result.created[0].permissions, [], 'the new bot still holds nothing');
});

test('an invalid block is refused without writing a bot', async () => {
  const store = memoryStore(baseState());
  const result = await createBotsFromReply(store, {bot: creator, groupId: 'g1', output: '```create-bot\n{"name":"S","job":"short"}\n```', makeId, now: () => at});
  assert.equal(result.created.length, 0);
  assert.equal(store.state().groups[0].bots.length, 1);
  assert.match(result.lines[0].text, /the request was refused/);
});

test('a duplicate name and a full group are refused', async () => {
  const duplicateState = baseState();
  duplicateState.groups[0].bots.push({id: 'scout', name: 'Source Scout', permissions: []});
  const duplicate = memoryStore(duplicateState);
  const duped = await createBotsFromReply(duplicate, {bot: creator, groupId: 'g1', output: blockFor({name: 'source scout', job: 'Find posts that mention the project and list their links.'}), makeId, now: () => at});
  assert.equal(duped.created.length, 0);
  assert.match(duped.lines[0].text, /already in the company/);

  const fullState = baseState();
  fullState.groups[0].bots = Array.from({length: MAX_BOTS_PER_GROUP}, (_, i) => ({id: `bot-${i}`, name: `Bot ${i}`, permissions: i === 0 ? [BOT_CREATE_PERMISSION] : []}));
  const full = memoryStore(fullState);
  const refused = await createBotsFromReply(full, {bot: fullState.groups[0].bots[0], groupId: 'g1', output: blockFor({name: 'One too many', job: 'Find posts that mention the project and list their links.'}), makeId, now: () => at});
  assert.equal(refused.created.length, 0);
  assert.match(refused.lines[0].text, new RegExp(`already has ${MAX_BOTS_PER_GROUP} bots`));

  const missing = memoryStore(baseState());
  const gone = await createBotsFromReply(missing, {bot: creator, groupId: 'gone', output: blockFor({name: 'Scout', job: 'Find posts that mention the project and list their links.'}), makeId, now: () => at});
  assert.equal(gone.created.length, 0);
  assert.match(gone.lines[0].text, /group no longer exists/);
});

test('a reply with several blocks creates each bot, up to five, and says why past that', async () => {
  const store = memoryStore(baseState());
  const jobs = ['Source', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth'].map(name => blockFor({name: `${name} scout`, job: `Find posts that mention the project from the ${name.toLowerCase()} list.`}));
  const result = await createBotsFromReply(store, {bot: creator, groupId: 'g1', makeId, now: () => at, output: jobs.join('')});
  assert.equal(result.created.length, 5);
  assert.equal(store.state().groups[0].bots.length, 6);
  assert.ok(result.lines.some(line => /5 new bots per reply/.test(line.text)), 'The extra request is refused out loud.');
  assert.equal(result.lines.filter(line => /created a new bot/.test(line.text)).length, 5);
});

test('a reply without a block passes through unchanged', async () => {
  const store = memoryStore(baseState());
  const result = await createBotsFromReply(store, {bot: creator, groupId: 'g1', output: 'Just a normal answer.', makeId, now: () => at});
  assert.equal(result.text, 'Just a normal answer.');
  assert.deepEqual(result.created, []);
  assert.deepEqual(result.lines, []);
  assert.equal(store.state().groups[0].bots.length, 1);
});

test('a name comes from the first noun phrase of the sentence, else Helper N', () => {
  assert.equal(nameFromSentence('Watches my inbox and drafts replies to the people who write to me.'), 'Inbox');
  assert.equal(nameFromSentence('Find posts that mention the project and list their links.'), 'Posts');
  assert.equal(nameFromSentence('Tracks the weekly budget for the family.'), 'Weekly Budget');
  assert.equal(nameFromSentence('What is the weather in Delhi today'), 'Weather');
  assert.equal(nameFromSentence('Tell me the USD to INR rate'), 'USD', 'an acronym keeps its capitals');
  assert.equal(nameFromSentence('Make me a bot'), 'Helper 1');
  assert.equal(nameFromSentence('Make me a bot', ['helper 1', 'Helper 2']), 'Helper 3');
  assert.equal(nameFromSentence('Watches my inbox.', ['Inbox']), 'Inbox 2', 'a taken name gets a number');
  assert.equal(validateCreateBotRequest({job: 'Watches my inbox and drafts replies.'}).name, 'Inbox');
  assert.equal(validateCreateBotRequest({job: 'Watches my inbox and drafts replies.'}).derived, true);
  assert.equal(validateCreateBotRequest({name: 'Mail', job: 'Watches my inbox and drafts replies.'}).derived, undefined);
});

test('the first unused colour counts a bot with no colour by its position', () => {
  const bots = [{settings: {tint: 0}}, {settings: {}}, {settings: {tint: 3}}, {}];
  assert.equal(firstUnusedTint(bots, 6), 2, 'position 1 and 3 use colours 1 and 3; 2 is free');
  assert.equal(firstUnusedTint(Array.from({length: 6}, (_, i) => ({settings: {tint: i}})), 6), 0, 'all taken: wrap by position');
});
