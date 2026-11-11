/** "Make a bot and have it do X" in one message: the new bot starts on X in the same run, even when the
 * reply that made it also opened pages, and the owner never has to ask twice. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {resumeBrowserRun} from '../src/coordination.js';
import {setBrowserResultHooks} from '../src/bot-browser.js';
import {browserRuntime} from '../src/browser-runtime.js';
import {company, model, ask} from './run-fixture.js';

const until = async (check, note) => {
  for (let i = 0; i < 500; i++) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error(`timed out waiting for ${note}`);
};

test('a bot made in a reply that also opened pages still gets its task once the pages come back', async t => {
  const realRun = browserRuntime.run, realAvailable = browserRuntime.available;
  browserRuntime.available = () => true;
  browserRuntime.run = async request => ({title: 'Shop', finalUrl: request.url, text: 'WH-1000XM5 ₹19,989'});
  t.after(() => { browserRuntime.available = realAvailable; browserRuntime.run = realRun; });
  const {store} = await company(t);
  const ai = model({
    Atlas: (e, n) => n === 0
      ? 'Making a tracker.\n```create-bot\n{"name":"Price tracker","job":"Track the price of Sony WH-1000XM5 headphones in India."}\n```\n@Price tracker check the current price.\n```browser\n{"url":"https://shop.example/xm5"}\n```'
      : e.previous?.from && e.previous.from !== 'atlas' ? `Report: ${e.previous.output}` : 'I opened the shop page.',
    'Price tracker': 'Current price: ₹19,989 at shop.example.',
  });
  setBrowserResultHooks({continueRun: async () => {}, resumeBrowser: (s, request, options) => resumeBrowserRun(s, request, {...options, executor: ai.executor})});
  const run = await ask(store, {message: 'Make a bot that tracks the price of Sony WH-1000XM5 in India and tell me the price.', executor: ai.executor});
  await until(() => ['completed', 'failed'].includes(store.read().groupRuns.find(r => r.id === run.id)?.status), 'the run');
  const done = store.read().groupRuns.find(r => r.id === run.id);
  assert.equal(done.status, 'completed', done.error);
  assert.ok(ai.calls.some(c => c.name === 'Price tracker'), `the new bot ran: ${ai.calls.map(c => c.name).join(', ')}`);
});
