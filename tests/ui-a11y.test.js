// Accessibility invariants of the shared chrome that are provable from source:
// cascade order, announcement order, focus order and live-region roles. The
// browser-side behaviour behind each one is covered by the Playwright smokes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const shared = name => readFile(path.join(root, 'shared', name), 'utf8');
const [css, html, dialogs, sheets] = await Promise.all(['app.css', 'index.html', 'ui-dialogs.js', 'ui-sheets.js'].map(shared));

/** The body of an exported function, up to the next top-level export, with its
 * comments removed so a comment naming an API cannot be mistaken for a call. */
function body(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} must exist`);
  const rest = source.slice(start + signature.length);
  const end = rest.search(/\nexport /);
  const text = end < 0 ? rest : rest.slice(0, end);
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/* ---------- cascade: coarse-pointer sizes must come last ---------- */

test('the coarse-pointer block overrides every check-row it is meant to fix', () => {
  const coarse = css.indexOf('@media (pointer:coarse)');
  assert.ok(coarse >= 0, 'the coarse-pointer block must exist');
  // Same specificity as the rules it replaces, so it only wins by coming later
  // in the file. Both of these once declared a smaller target above this block.
  for (const rule of ['.contract-fieldset .check-row{', '.box>form .check-row{']) {
    const base = css.indexOf(rule);
    assert.ok(base >= 0, `${rule} must exist`);
    assert.ok(coarse > base, `@media (pointer:coarse) must come after ${rule} (a later same-specificity rule wins)`);
    // …and it must actually restate them, or moving the block bought nothing.
    assert.ok(css.slice(coarse).includes(`${rule}min-height:44px`), `the coarse block must set ${rule}min-height:44px`);
  }
});

test('pills and the evidence summary take a finger-sized target on a coarse pointer', () => {
  const block = css.slice(css.indexOf('@media (pointer:coarse)'));
  assert.match(block, /\.needs-pill\{height:44px;border-radius:22px\}/);
  assert.match(block, /\.evidence-panel summary\{min-height:44px\}/);
});

test('a narrow phone header drops the status-only pills, not the actionable one', () => {
  // The one that does something is a button with data-action; the rest are spans.
  assert.match(css, /@media\(max-width:520px\)\{[\s\S]{0,120}\.thread-head \.needs-pill:not\(\[data-action\]\)\{display:none\}/);
});

/* ---------- live regions ---------- */

test('a toast is shown before it is written, so the live region hears it', () => {
  const toast = body(dialogs, 'export function toast(');
  const shown = toast.indexOf("node.classList.remove('hidden')");
  const written = toast.indexOf('node.textContent = message');
  assert.ok(shown >= 0 && written >= 0, 'toast must reveal the node and set its text');
  // A mutation inside a display:none subtree never reaches the live region.
  assert.ok(shown < written, 'toast must remove .hidden before setting textContent');
  // The role is chosen per call and set while the node is still hidden, so the
  // region kind is right at the moment the text arrives.
  assert.ok(toast.indexOf("setAttribute('role'") < shown);
  assert.ok(toast.indexOf("setAttribute('aria-live'") < shown);
});

test('the in-flight bar is a status, not decoration', () => {
  assert.match(html, /<div id="progress"[^>]*role="status"/);
  assert.match(html, /id="progress"[\s\S]{0,160}sr-only/);
  // The bar itself is a moving gradient; under reduced motion it must become a
  // still, visible bar instead of a frozen stripe.
  const reduce = css.slice(css.indexOf('@media(prefers-reduced-motion:reduce)'));
  assert.match(reduce.slice(0, 600), /\.progress\{animation:none;background:var\(--brand\)\}/);
});

/* ---------- focus order ---------- */

test('a danger confirm opens with focus on Cancel, not on the destructive button', () => {
  const confirm = body(dialogs, 'export function confirmSheet(');
  const cancel = confirm.indexOf("'close-sheet'");
  const danger = confirm.indexOf("'sheet-confirm'");
  assert.ok(cancel >= 0 && danger >= 0, 'both buttons must keep the actions their handlers use');
  // openSheet focuses the first plain button when none is .primary, and a danger
  // button is not .primary: Cancel first is what keeps a stray Enter harmless.
  assert.ok(cancel < danger, 'the cancel button must precede the confirm button in the template');
  assert.match(confirm, /kind: danger \? 'danger' : 'primary'/, 'the confirm button keeps its kind');
});

test('Ctrl+K from inside a sheet returns focus to where the sheet was opened', () => {
  const palette = body(sheets, 'export function openCommandPalette(');
  const adopted = palette.indexOf('focusOrigin()');
  const closed = palette.indexOf('closeSheet()');
  assert.ok(adopted >= 0 && closed >= 0, 'the palette must read the origin and close the sheet');
  // closeSheet() restores and clears the origin, so it has to be read first.
  assert.ok(adopted < closed, 'the origin must be captured before closing the sheet');
  assert.match(palette, /captureFocus\(origin/);
  assert.match(dialogs, /export const focusOrigin/, 'ui-dialogs must expose the stored origin');
});
