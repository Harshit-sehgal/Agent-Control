// Found by the real-model sweep: a subscription CLI still said it could not see an attached invoice. The agent's
// runner handled images, but the server's model.run payload check rebuilt the payload without them (and without
// the effort), so neither ever reached the paired computer.
import test from 'node:test';
import assert from 'node:assert/strict';
import {validateModelRun} from '../src/agent.js';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64');

test('a model.run keeps its images and its effort', () => {
  const p = validateModelRun({engine: 'claude', model: 'haiku', input: 'What is in this?', effort: 'low', images: [{type: 'image/png', data: png, extra: 'dropped'}]});
  assert.deepEqual(p.images, [{type: 'image/png', data: png}]);
  assert.equal(p.effort, 'low');
});

test('a model.run with no images carries none', () => {
  const p = validateModelRun({engine: 'claude', input: 'hi'});
  assert.equal('images' in p, false);
  assert.equal('effort' in p, false);
});

test('bad images and a bad effort are refused before they are queued', () => {
  for (const images of ['x', [{type: 'text/html', data: png}], [{type: 'image/png', data: '%%%'}], Array.from({length: 11}, () => ({type: 'image/png', data: png}))]) {
    assert.throws(() => validateModelRun({engine: 'claude', input: 'hi', images}), e => e.status === 400, JSON.stringify(images).slice(0, 60));
  }
  assert.throws(() => validateModelRun({engine: 'claude', input: 'hi', effort: '--yolo'}), e => e.status === 400);
});
