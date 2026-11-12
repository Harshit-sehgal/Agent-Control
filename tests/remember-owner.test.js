// "Remember: I prefer remote internships" is kept without the owner opening
// Settings: the sentence lands in the company notes every bot reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import {rememberFromOwner, promptMemory, COMPANY_KEY} from '../shared/memory.js';

const notes = s => promptMemory(s, 'm', 'c').companyNotes;

test('an explicit remember line is saved to the company notes, without the cue', () => {
  const s = {};
  const added = rememberFromOwner(s, 'Remember: I prefer internships in Bangalore or remote, with a stipend above 20k per month.');
  assert.equal(added.length, 1);
  assert.deepEqual(notes(s), ['I prefer internships in Bangalore or remote, with a stipend above 20k per month.']);
  assert.ok(s.memory.rulebooks[COMPANY_KEY]);
});

test('lasting habits are saved too', () => {
  const s = {};
  rememberFromOwner(s, 'From now on, reply in short bullet points. Always cite your sources.');
  assert.deepEqual(notes(s).sort(), ['Always cite your sources.', 'From now on, reply in short bullet points.']);
});

test('tasks, questions and reminders are not saved', () => {
  const s = {};
  for (const text of ['Find me 5 remote internships.', 'Please summarize Hacker News.', 'Remember to update my resume every Monday.', 'Do you remember what I said?', 'Never mind, stop.', 'Use the researcher bot for this.'])
    assert.deepEqual(rememberFromOwner(s, text), [], text);
  assert.equal(s.memory?.rulebooks?.[COMPANY_KEY]?.rules?.length || 0, 0);
});

test('saying it twice keeps one note', () => {
  const s = {};
  rememberFromOwner(s, 'Remember that my name is Harshit.');
  rememberFromOwner(s, 'remember that my name is Harshit');
  assert.equal(notes(s).length, 1);
});

test('bots are told exactly which remember lines were saved, and to confirm only those', async () => {
  const {createEnvelope} = await import('../shared/coordination.js');
  const env = createEnvelope({run: {id: 'r', groupId: 'home', currentStep: 0, recipients: ['b'], input: 'x', remembered: ['Reply in British English.']}, bot: {id: 'b', name: 'Atlas', instructions: 'Lead.'}});
  assert.deepEqual(env.remembered, ['Reply in British English.']);
  assert.match(JSON.stringify(env.restrictions), /remembered lists what the app just saved/);
  const none = createEnvelope({run: {id: 'r', groupId: 'home', currentStep: 0, recipients: ['b'], input: 'x'}, bot: {id: 'b', name: 'Atlas', instructions: 'Lead.'}});
  assert.equal(none.remembered, undefined, 'nothing saved, nothing to confirm');
  assert.match(none.now.iso, /^\d{4}-\d{2}-\d{2}T/, 'every run carries today');
});
