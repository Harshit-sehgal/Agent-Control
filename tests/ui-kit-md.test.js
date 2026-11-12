/** Model replies are written in markdown; the chat shows them formatted, never raw `**`. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {md, plain} from '../shared/ui-kit.js';

test('bold, italic and code show formatted, not as raw markers', () => {
  assert.equal(md('Done — **Job scout** is on your *team*.'), '<p>Done — <strong>Job scout</strong> is on your <em>team</em>.</p>');
  assert.equal(md('run `npm **test**` now'), '<p>run <code>npm **test**</code> now</p>');
  assert.equal(md('__both__ and _one_'), '<p><strong>both</strong> and <em>one</em></p>');
});

test('html in a reply is escaped before anything is formatted', () => {
  assert.equal(md('**<img src=x onerror=alert(1)>**'), '<p><strong>&lt;img src=x onerror=alert(1)&gt;</strong></p>');
  assert.equal(md('`<script>`'), '<p><code>&lt;script&gt;</code></p>');
});

test('bullets and numbered lines become lists, headings become a bold line', () => {
  assert.equal(md('Two things:\n\n- **No permissions yet.** It exists\n- second'), '<p>Two things:</p><ul><li><strong>No permissions yet.</strong> It exists</li><li>second</li></ul>');
  assert.equal(md('1. **Listings** — pasted\n2. Your bar'), '<ol><li><strong>Listings</strong> — pasted</li><li>Your bar</li></ol>');
  assert.equal(md('## Plan\nstep one'), '<p class="md-h">Plan</p><p>step one</p>');
});

test('a paragraph keeps its line breaks', () => {
  assert.equal(md('line one\nline two\n\nnext'), '<p>line one<br>line two</p><p>next</p>');
});

test('only http and https links become links', () => {
  assert.equal(md('[docs](https://example.com/a?b=1&c=2)'), '<p><a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">docs</a></p>');
  assert.equal(md('[x](javascript:alert(1))'), '<p>[x](javascript:alert(1))</p>');
});

test('snake_case words and lone stars are left alone', () => {
  assert.equal(md('set max_tokens_limit to 5 * 3'), '<p>set max_tokens_limit to 5 * 3</p>');
});

test('plain drops the markers for one-line previews', () => {
  assert.equal(plain('Done — **Job scout** is on your *team*.\n- `a`'), 'Done — Job scout is on your team. a');
  assert.equal(plain('## Plan\n1. [docs](https://x.y)'), 'Plan docs');
});
