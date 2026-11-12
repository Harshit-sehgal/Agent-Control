// A bot filled a test order form with a good block that ended in {"op":"read"}. The app refused the whole
// request over that read and never told the bot, so the run ended on "Atlas asked to open a web page."
import test from 'node:test';
import assert from 'node:assert/strict';
import {recordBrowserRequests} from '../shared/bot-browser.js';

const state = () => ({groups: [{id: 'home', bots: [{id: 'atlas', name: 'Atlas'}]}], browserRequests: [], asks: [], grants: [], activity: [], tasks: [], events: []});
const record = (s, body) => { let n = 0; return recordBrowserRequests(s, {bot: {id: 'atlas', name: 'Atlas'}, groupId: 'home', chatKey: 'atlas', output: `\`\`\`browser\n${JSON.stringify(body)}\n\`\`\``, depth: 0, makeId: () => `id${++n}`, runId: 'r1'}); };

test('a read step with nothing named reads the whole page', () => {
  const out = record(state(), {url: 'https://httpbin.org/forms/post', steps: [{op: 'type', selector: 'input[name=custname]', text: 'Test Owner'}, {op: 'read'}]});
  assert.equal(out.records.length + out.asks.length > 0, true, JSON.stringify(out.lines));
  assert.ok(!out.invalid?.length);
});

test('a refused request hands its reason back, so the run can tell the bot', () => {
  const out = record(state(), {url: 'https://httpbin.org/forms/post', steps: [{op: 'click'}]});
  assert.equal(out.records.length, 0);
  assert.match(out.invalid[0], /needs an index/);
});

test('a form already submitted in this run is not submitted again; the bot gets the first result back', () => {
  const s = state();
  const submit = {url: 'https://httpbin.org/forms/post', steps: [{op: 'type', selector: 'input[name=custname]', text: 'Test Owner'}, {op: 'click', selector: 'button[type=submit]'}]};
  const first = record(s, submit);
  assert.equal(first.records.length, 1);
  assert.equal(first.records[0].submits, true);
  Object.assign(s.browserRequests[0], {status: 'done', result: {finalUrl: 'https://httpbin.org/post', page: 'Page: https://httpbin.org/post  "custname": "Test Owner"'}});
  const second = record(s, {...submit, steps: [...submit.steps, {op: 'read'}]});
  assert.equal(second.records.length, 0, 'the second submit is not sent');
  assert.equal(second.resent.length, 1);
  assert.match(second.again[0], /"custname": "Test Owner"/);
  assert.match(second.lines.map(l => l.text).join('\n'), /already submitted/i);
  // Filling the form again without submitting is still fine.
  assert.equal(record(s, {url: submit.url, steps: [{op: 'type', selector: 'input[name=custname]', text: 'x'}]}).records.length, 1);
});
