/**
 * What is secret on a page, in the page. A password, a one-time code, a card number or anything the page's
 * author tagged `data-agent-secret` must never reach a model: not by the field's name, and not in page text.
 *
 * These functions run inside Chrome, embedded by `.toString()` the way `foldLabel` is (agent/browser.mjs),
 * so they are one self-contained unit: no imports, no module-level names, and they are only ever embedded
 * together as `PAGE_SECRETS_JS` (`labelOf` and `hideSecrets` call `isSecretField`).
 *
 *   isSecretField(el)         is this field secret?
 *   isTextEntry(el)           can a person type text into this control? The one rule for where a secret may go.
 *   labelOf(el)               the words that name a control for the model, never a secret field's content
 *   hideSecrets(text, fields) `text` with every secret field's content replaced by "[hidden]"
 */

/** True for a form field (an input that is not a button, a textarea, a select, a contenteditable) that is a
 * password field, whose autocomplete names a code or card, or that sits inside `data-agent-secret`. A button or
 * a link is never secret, so "Pay now" stays "Pay now". */
export function isSecretField(el) {
  const kinds = ['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year'];
  const tag = String(el.tagName || '').toUpperCase();
  const type = String(el.type || '').toLowerCase();
  const formField = (tag === 'INPUT' && !['submit', 'button', 'reset', 'image'].includes(type))
    || tag === 'TEXTAREA' || tag === 'SELECT' || Boolean(el.isContentEditable);
  if (!formField) return false;
  const tokens = String(el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
  return type === 'password' || tokens.some(t => kinds.includes(t)) || Boolean(el.closest('[data-agent-secret]'));
}

/** True for a control a person types text into: an input that is not a button, a checkbox, a radio, a file, a range
 * or a colour picker, a textarea, or a contenteditable. A page body, a wrapper that took the focus, a select or a
 * button is not. A secret is typed only into one of these, and only one of these is ever tagged secret. */
export function isTextEntry(el) {
  const tag = String(el.tagName || '').toUpperCase();
  const type = String(el.type || '').toLowerCase();
  if (tag === 'INPUT') return !['submit', 'button', 'reset', 'image', 'checkbox', 'radio', 'file', 'range', 'color'].includes(type);
  return tag === 'TEXTAREA' || Boolean(el.isContentEditable);
}

/** A control's name for the model. A secret field is named by aria-label, its first <label>, placeholder, name,
 * then "password field" / "secret field", never by its value or text; every other element keeps
 * innerText, value, aria-label, placeholder, name. Whitespace is collapsed. */
export function labelOf(el) {
  const clean = t => String(t || '').replace(/\s+/g, ' ').trim();
  const attr = n => el.getAttribute(n);
  const name = el.name || attr('name');
  if (!isSecretField(el)) return clean(el.innerText || el.value || attr('aria-label') || attr('placeholder') || name);
  const first = el.labels && el.labels[0];
  return clean(attr('aria-label')) || clean(first && (first.innerText || first.textContent))
    || clean(attr('placeholder')) || clean(name) || (String(el.type || '').toLowerCase() === 'password' ? 'password field' : 'secret field');
}

/** `text` with the content of each secret field in `fields` (its value, or the trimmed innerText of a
 * contenteditable) replaced by [hidden], when that content is at least 3 characters, in any letter case. One pass
 * over the original text: every match range of every value is found (the source is never lower-cased, so ranges
 * keep their length), overlapping or touching ranges are merged, and each merged
 * range becomes one [hidden], so a secret cannot match inside the marker and overlapping secrets leave no part. */
export function hideSecrets(text, fields) {
  const source = String(text == null ? '' : text);
  const ranges = [];
  for (const el of Array.prototype.slice.call(fields || [])) {
    if (!isSecretField(el)) continue;
    const v = typeof el.value === 'string' ? el.value : (el.isContentEditable ? String(el.innerText || '').trim() : '');
    if (v.length < 3) continue;
    // Every start is found, matches that overlap each other included ("aaaa" in "aaaaa" twice).
    const found = new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    for (let m = found.exec(source); m; m = found.exec(source)) { ranges.push([m.index, m.index + m[0].length]); found.lastIndex = m.index + 1; }
  }
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let out = '';
  let at = 0;
  for (let i = 0; i < ranges.length;) {
    const start = ranges[i][0];
    let end = ranges[i][1];
    for (i++; i < ranges.length && ranges[i][0] <= end; i++) end = Math.max(end, ranges[i][1]);
    out += source.slice(at, start) + '[hidden]';
    at = end;
  }
  return out + source.slice(at);
}

/** The functions as one script that declares them, to embed in a page expression. */
export const PAGE_SECRETS_JS = [isSecretField, isTextEntry, labelOf, hideSecrets].map(f => f.toString()).join(';');

/** Asks the page whether the focused element is a secret field (the takeover's question before it types). */
export const FOCUSED_IS_SECRET_JS = `(()=>{${PAGE_SECRETS_JS};const el=document.activeElement;return !!el&&isSecretField(el)})()`;

/** Tags the focused element `data-agent-secret` so the page hides it from every model, and answers `true`. It tags
 * only a text-entry field: the page body, the root, a wrapper an app focused (`<main tabindex=-1>`) or a button
 * would hide a whole page or the wrong control, so for those it tags nothing and answers `false`. */
export const TAG_FOCUSED_SECRET_JS = `(()=>{${PAGE_SECRETS_JS};const el=document.activeElement;if(!el||el===document.body||el===document.documentElement||!isTextEntry(el))return false;el.setAttribute('data-agent-secret','1');return true})()`;
