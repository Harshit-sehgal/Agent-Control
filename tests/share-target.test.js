// Share to Agent Control: on a phone with the app installed, the system Share sheet lists it. What is shared
// (a link, some text, a page title) lands in the lead bot's message box and is never sent by itself: importing
// stays separate from acting.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {sharedDraft, withoutShareParams, SHARE_PARAMS} from '../shared/ui-model.js';

test('the manifest offers the app in the Share sheet, by GET, so nothing is posted', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../shared/manifest.webmanifest', import.meta.url), 'utf8'));
  assert.equal(manifest.share_target.method, 'GET');
  assert.equal(manifest.share_target.action, './');
  assert.deepEqual(manifest.share_target.params, {title: SHARE_PARAMS.title, text: SHARE_PARAMS.text, url: SHARE_PARAMS.url});
});

test('what was shared becomes one draft: title, text, then the link unless the text holds it', () => {
  const q = o => `?${new URLSearchParams(o)}`;
  assert.equal(sharedDraft(q({'share-title': 'Rust 2.0', 'share-url': 'https://blog.example/rust'})), 'Rust 2.0\nhttps://blog.example/rust');
  assert.equal(sharedDraft(q({'share-text': 'Look at https://x.com/a/1', 'share-url': 'https://x.com/a/1'})), 'Look at https://x.com/a/1');
  assert.equal(sharedDraft(q({'share-text': '  just words  '})), 'just words');
  assert.equal(sharedDraft(q({'share-title': 'Same', 'share-text': 'Same'})), 'Same', 'a title that repeats the text is said once');
  assert.equal(sharedDraft(''), null);
  assert.equal(sharedDraft(q({'share-text': '   '})), null);
  assert.equal(sharedDraft(q({other: 'x'})), null);
  assert.equal(sharedDraft(q({'share-text': 'a'.repeat(5000)})).length, 4000, 'no longer than the message box takes');
});

test('the shared words leave the address once read, and other parameters stay', () => {
  assert.equal(withoutShareParams('?share-text=hi&share-url=x&connect=connected'), '?connect=connected');
  assert.equal(withoutShareParams('?share-title=t'), '');
});
