import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOT_CREATE_PERMISSION, MAX_BOTS_PER_GROUP, MIN_BOT_JOB,
  validateCreateBotRequest, parseCreateBotRequests, stripCreateBotBlocks,
  buildCreatedBot, botCreatedText,
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
  const two = parseCreateBotRequests(blockFor({name: 'Aaa', job: 'x'.repeat(50)}) + blockFor({name: 'Bbb', job: 'x'.repeat(50)}));
  assert.equal(two.length, 2, 'the second block must be reported, not silently dropped');
  assert.equal(two[0].ok, true);
  assert.equal(two[1].ok, false);
  assert.match(two[1].error, /1 new bot per reply/);
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
  assert.match(botCreatedText(creator, record, 'Research team'), /It has no permissions/);
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
  assert.match(duped.lines[0].text, /already in this group/);

  const fullState = baseState();
  fullState.groups[0].bots = Array.from({length: MAX_BOTS_PER_GROUP}, (_, i) => ({id: `bot-${i}`, name: `Bot ${i}`, permissions: i === 0 ? [BOT_CREATE_PERMISSION] : []}));
  const full = memoryStore(fullState);
  const refused = await createBotsFromReply(full, {bot: fullState.groups[0].bots[0], groupId: 'g1', output: blockFor({name: 'One too many', job: 'Find posts that mention the project and list their links.'}), makeId, now: () => at});
  assert.equal(refused.created.length, 0);
  assert.match(refused.lines[0].text, /already has 40 bots/);

  const missing = memoryStore(baseState());
  const gone = await createBotsFromReply(missing, {bot: creator, groupId: 'gone', output: blockFor({name: 'Scout', job: 'Find posts that mention the project and list their links.'}), makeId, now: () => at});
  assert.equal(gone.created.length, 0);
  assert.match(gone.lines[0].text, /group no longer exists/);
});

test('a reply with two blocks creates one bot and says why', async () => {
  const store = memoryStore(baseState());
  const result = await createBotsFromReply(store, {
    bot: creator, groupId: 'g1', makeId, now: () => at,
    output: blockFor({name: 'Source scout', job: 'Find posts that mention the project and list their links.'}) + blockFor({name: 'Second scout', job: 'Also find posts that mention the project.'}),
  });
  assert.equal(result.created.length, 1);
  assert.equal(store.state().groups[0].bots.length, 2);
  assert.ok(result.lines.some(line => /1 new bot per reply/.test(line.text)), 'The extra request is refused out loud.');
});

test('a reply without a block passes through unchanged', async () => {
  const store = memoryStore(baseState());
  const result = await createBotsFromReply(store, {bot: creator, groupId: 'g1', output: 'Just a normal answer.', makeId, now: () => at});
  assert.equal(result.text, 'Just a normal answer.');
  assert.deepEqual(result.created, []);
  assert.deepEqual(result.lines, []);
  assert.equal(store.state().groups[0].bots.length, 1);
});
