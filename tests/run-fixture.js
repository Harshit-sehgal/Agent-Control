/** A small company in a real store, and a scripted model, for run-loop tests.
 *
 * Atlas leads everyone. Ops lead manages Mailroom and Planner. Scholar and
 * Scribe report to no one. `ask` starts a run the way a chat message does and
 * waits for the real loop to finish; the "model" is a function per bot name.
 */
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import * as wf from '../shared/workflow.js';
import {createRun, summonableGuests} from '../shared/coordination.js';
import {SqliteStore} from '../src/sqlite-store.js';
import {coordinationState, runGroup} from '../src/coordination.js';

export async function company(t, {extra = {}} = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ac-lead-'));
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  t.after(() => rm(dir, {recursive: true, force: true}));
  const ids = {atlas: 'atlas'};
  await store.update(s => {
    const add = (key, name, instructions, settings = {}, more = {}) => { ids[key] = wf.addBot(s, 'home', {name, instructions, settings, ...more}).id; };
    add('ops', 'Ops lead', 'Runs operations: mail, calendars and logistics for the owner.');
    add('mail', 'Mailroom', 'Reads and drafts email for the owner.', {reportsTo: ids.ops});
    add('plan', 'Planner', 'Plans the owner\'s week and books appointments.', {reportsTo: ids.ops});
    add('scholar', 'Scholar', 'Checks facts and finds sources.');
    add('scribe', 'Scribe', 'Writes up notes and summaries.');
    for (const [key, spec] of Object.entries(extra)) add(key, spec.name, spec.instructions, spec.settings, spec.more);
    coordinationState(s);
  });
  return {store, ids};
}

/** A scripted model. `script` maps a bot name to a string, or to a function
 * `(envelope, callNumber) => string`. Every envelope a bot was handed is kept. */
export function model(script = {}) {
  const calls = [];
  const executor = async (bot, input) => {
    const envelope = JSON.parse(input);
    const mine = calls.filter(c => c.name === bot.name).length;
    calls.push({name: bot.name, envelope});
    const reply = script[bot.name];
    const text = typeof reply === 'function' ? reply(envelope, mine) : reply;
    return text ?? `${bot.name} replies.`;
  };
  return {calls, executor, of: name => calls.filter(c => c.name === name).map(c => c.envelope)};
}

/** Start a run the way a chat message does, run it to the end, return the run. */
export async function ask(store, {message, to = 'atlas', chatKey = to, executor, anyway = false, group = 'home', extra = {}}) {
  let id;
  await store.update(s => {
    const host = s.groups.find(g => g.id === group);
    const guests = summonableGuests(s.groups, group, {includeOff: true});
    const run = createRun({group: host, message, directBotId: to, chatKey, guests, makeId: randomUUID, anyway});
    Object.assign(run, extra);
    s.groupRuns.unshift(run); id = run.id;
  });
  await runGroup(store, id, executor);
  return store.read().groupRuns.find(r => r.id === id);
}
