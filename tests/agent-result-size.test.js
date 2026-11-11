// A browser task's result carries a whole page (up to 60,000 characters of text,
// often multi-byte, plus its links and controls). The result route must take a
// body that size, or a long page such as a Wikipedia article is dropped with a
// 413 and the bot loops asking for it again.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRouter} from '../src/router.js';
import {publicRoutes} from '../src/routes-public.js';

test('the agent result route reads a body big enough for a whole page', async () => {
  const router = createRouter();
  publicRoutes(router, {auth: {}, workspaces: {holding: () => null, get: () => ({})}, version: 'test'});
  const {route} = router.find('POST', '/api/agent/tasks/t1/result');
  let asked = 0;
  const stop = new Error('stop');
  await assert.rejects(route.handler({req: {headers: {}}, path: '/api/agent/tasks/t1/result', params: {id: 't1'}, raw: async limit => { asked = limit; throw stop; }}), stop);
  const page = {status: 'done', result: {text: 'ई'.repeat(60000), excerpt: 'ई'.repeat(600), links: Array.from({length: 40}, (_, i) => ({text: 'x'.repeat(100), url: `https://e.com/${'y'.repeat(280)}${i}`})), elements: Array.from({length: 80}, (_, i) => ({index: i, tag: 'a', text: 'z'.repeat(80)}))}};
  assert.ok(asked >= Buffer.byteLength(JSON.stringify(page)), `limit ${asked} is below a full page result`);
});
