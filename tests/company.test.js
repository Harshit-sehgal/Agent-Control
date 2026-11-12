import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState} from '../shared/core.js';
import * as wf from '../shared/workflow.js';
import {companyBots, primaryOf, managerOf, reportsOf, teamOf, isLead, setManager} from '../shared/company.js';

function company() {
  const s = wf.migrate(initialState());
  const add = (name, settings = {}) => wf.addBot(s, 'home', {name, instructions: `${name} does ${name.toLowerCase()} work.`, settings});
  const ops = add('Ops lead');
  const mail = add('Mailroom', {reportsTo: ops.id});
  const plan = add('Planner', {reportsTo: ops.id});
  const solo = add('Scholar');
  return {s, ops, mail, plan, solo};
}

test('a manager is a bot with reports and the primary leads everyone', () => {
  const {s, ops, mail, plan, solo} = company();
  assert.equal(primaryOf(s).id, 'atlas');
  assert.deepEqual(reportsOf(s, ops.id).map(b => b.id), [mail.id, plan.id]);
  assert.equal(managerOf(s, mail.id).id, ops.id);
  assert.equal(managerOf(s, solo.id), null);
  assert.ok(isLead(s, 'atlas') && isLead(s, ops.id));
  assert.equal(isLead(s, mail.id), false);
  assert.deepEqual(teamOf(s, ops.id).map(b => b.id), [mail.id, plan.id]);
  assert.deepEqual(new Set(teamOf(s, 'atlas').map(b => b.id)), new Set([ops.id, mail.id, plan.id, solo.id]));
  assert.equal(companyBots(s).length, 5);
});

test('a reporting cycle is refused', () => {
  const {s, ops, mail} = company();
  assert.throws(() => setManager(s, ops.id, mail.id), e => e.status === 400 && /cycle|reports to/i.test(e.message));
  assert.throws(() => setManager(s, mail.id, mail.id), e => e.status === 400);
  assert.throws(() => wf.updateBot(s, 'home', ops.id, {settings: {reportsTo: mail.id}}), e => e.status === 400);
  assert.throws(() => setManager(s, mail.id, 'nobody'), e => e.status === 400);
  assert.equal(managerOf(s, ops.id), null, 'nothing stored after a refused change');
});

test('the primary cannot be deleted or given a manager', () => {
  const {s, ops} = company();
  assert.throws(() => wf.removeBot(s, 'home', 'atlas'), e => e.status === 409 && /primary/i.test(e.message));
  assert.throws(() => setManager(s, 'atlas', ops.id), e => e.status === 400);
  assert.throws(() => wf.removeGroup(s, 'home'), e => e.status === 409);
});

test('deleting a manager leaves its reports solo', () => {
  const {s, ops, mail, plan} = company();
  wf.removeBot(s, 'home', ops.id);
  assert.equal(managerOf(s, mail.id), null);
  assert.equal(managerOf(s, plan.id), null);
  assert.ok(companyBots(s).some(b => b.id === mail.id));
});

test("bots in an old workspace's other groups are company bots, solo until moved", () => {
  const s = wf.migrate(initialState());
  const g = wf.addGroup(s, {name: 'Old team'});
  const old = wf.addBot(s, g.id, {name: 'Archivist', instructions: 'Keeps the old archive tidy.'});
  assert.ok(companyBots(s).some(b => b.id === old.id));
  assert.equal(managerOf(s, old.id), null);
  setManager(s, old.id, 'atlas');
  assert.equal(managerOf(s, old.id).id, 'atlas');
  assert.ok(teamOf(s, 'atlas').some(b => b.id === old.id));
});

test('bot settings accept shape, manager, pin and order', () => {
  const {s, mail} = company();
  const bot = wf.updateBot(s, 'home', mail.id, {settings: {shape: 'drop', pinned: true, order: 3, tint: 2}});
  assert.equal(bot.settings.shape, 'drop');
  assert.equal(bot.settings.pinned, true);
  assert.equal(bot.settings.order, 3);
  assert.throws(() => wf.updateBot(s, 'home', mail.id, {settings: {shape: 'star'}}), e => e.status === 400);
  assert.throws(() => wf.updateBot(s, 'home', mail.id, {settings: {reportsTo: 42}}), e => e.status === 400);
});
