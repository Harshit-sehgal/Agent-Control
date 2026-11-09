import test from 'node:test';
import assert from 'node:assert/strict';
import {webLocks} from './web-locks.js';

test('the lock stand-in admits one holder per name and queues the rest', async () => {
  const locks = webLocks();
  const order = [];
  const inside = new Map();
  const enter = (name, tag, hold) => locks.request(name, {mode: 'exclusive'}, async () => {
    const held = (inside.get(name) || 0) + 1;
    inside.set(name, held);
    // One holder per name; different names are deliberately not serialised.
    assert.equal(held, 1, `${tag} entered while another holder was inside ${name}`);
    order.push(`in:${tag}`);
    await new Promise(resolve => setTimeout(resolve, hold));
    order.push(`out:${tag}`);
    inside.set(name, inside.get(name) - 1);
    return tag;
  });

  // Two names run in parallel; two requests on one name cannot overlap.
  const results = await Promise.all([enter('a', 'a1', 20), enter('a', 'a2', 1), enter('b', 'b1', 1)]);
  assert.deepEqual(results, ['a1', 'a2', 'b1'], 'each caller gets its own callback result');
  assert.deepEqual(order.filter(x => x.startsWith('in:')).sort(), ['in:a1', 'in:a2', 'in:b1']);
  assert.ok(order.indexOf('out:a1') < order.indexOf('in:a2'), 'the second holder waited for the first');
  assert.ok(order.indexOf('in:b1') < order.indexOf('out:a1'), 'a different name was not blocked');

  // A callback that throws still releases the name: the next request must run.
  await assert.rejects(locks.request('c', {}, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await locks.request('c', {}, async () => 'after'), 'after');
});
