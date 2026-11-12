// Found by the real-model sweep: a phone photo over 5 MB is named to the model instead of shown, so "describe this
// photo" got no answer. The composer now sends a smaller JPEG copy of a still image that big; this is its rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import {shrinkTarget, MODEL_IMAGE_BYTES, shrunkName} from '../shared/attachments.js';

test('a small image, a GIF and a text file are sent as they are', () => {
  assert.equal(shrinkTarget({type: 'image/png', size: 1e6, width: 4000, height: 3000}), null);
  assert.equal(shrinkTarget({type: 'image/gif', size: 8e6, width: 4000, height: 3000}), null, 'a GIF may be animated');
  assert.equal(shrinkTarget({type: 'text/csv', size: 8e6}), null);
});

test('a big photo is scaled so its long side is at most 2560 pixels, keeping its shape', () => {
  assert.deepEqual(shrinkTarget({type: 'image/jpeg', size: MODEL_IMAGE_BYTES + 1, width: 4032, height: 3024}), {width: 2560, height: 1920});
  assert.deepEqual(shrinkTarget({type: 'image/png', size: 9e6, width: 1000, height: 3000}), {width: 853, height: 2560});
  assert.deepEqual(shrinkTarget({type: 'image/webp', size: 9e6, width: 2000, height: 1500}), {width: 2000, height: 1500}, 'already small enough in pixels: re-encoded only');
});

test('the copy is a JPEG named after the original', () => {
  assert.equal(shrunkName('IMG_2041.HEIC.png'), 'IMG_2041.HEIC.jpg');
  assert.equal(shrunkName('photo'), 'photo.jpg');
});

test('a photo over the 10 MB upload limit is shrunk too, but one too big to decode is not', async () => {
  const {MAX_FILE_BYTES, SHRINK_MAX_INPUT} = await import('../shared/attachments.js');
  assert.ok(shrinkTarget({type: 'image/png', size: MAX_FILE_BYTES + 3e6, width: 3000, height: 2250}));
  assert.equal(shrinkTarget({type: 'image/png', size: SHRINK_MAX_INPUT + 1, width: 9000, height: 9000}), null);
});
