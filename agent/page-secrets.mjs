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
 *   clearSecrets(scope)      empties the secret text fields in `scope` (the page, when the owner hands back)
 *
 * `scrubTyped` is the one function here that runs in Node: it hides what the owner typed in secret from a result.
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

/** True for a control a person types text into: an input that is not a button, a hidden input, a checkbox, a radio, a file, a range
 * or a colour picker, a textarea, or a contenteditable. A page body, a wrapper that took the focus, a select or a
 * button is not. A secret is typed only into one of these, and only one of these is ever tagged secret. */
export function isTextEntry(el) {
  const tag = String(el.tagName || '').toUpperCase();
  const type = String(el.type || '').toLowerCase();
  if (tag === 'INPUT') return !['submit', 'button', 'reset', 'image', 'checkbox', 'radio', 'file', 'range', 'color', 'hidden'].includes(type);
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

/** The page's secret fields, as a page expression. It needs the whole `PAGE_SECRETS_JS` bundle in scope. A `select`
 * and a contenteditable count; `isSecretField` then keeps only a password, a one-time code, a card number or a
 * field the page's author tagged `data-agent-secret`. */
export const SECRET_FIELDS_JS = `Array.prototype.filter.call(document.querySelectorAll('input,textarea,select,[contenteditable],[data-agent-secret]'),isSecretField)`;

/** Empties the secret fields of the page: each text-entry field's `value` set to empty and its `value` attribute
 * removed, a contenteditable's text cleared, so a page that was told nothing has nothing left to echo and a later
 * read finds an empty field. Only a field a person types text into is wiped (`isTextEntry`, or a contenteditable):
 * a hidden, checkbox, radio, file or select input under a tagged container keeps what it holds, since its value is
 * not what the owner typed and a page may need it. Answers how many fields it wiped. Page code: embedded with the
 * bundle, never imported into it. It tells the page nothing: no event fires. */
export function clearSecrets(scope) {
  const found = scope.querySelectorAll ? Array.prototype.slice.call(scope.querySelectorAll('input,textarea,select,[contenteditable],[data-agent-secret]')) : [];
  if (scope.tagName) found.push(scope);
  const fields = found.filter(el => isSecretField(el) && (isTextEntry(el) || Boolean(el.isContentEditable)));
  fields.forEach(el => { if (typeof el.value === 'string') { el.value = ''; el.removeAttribute('value'); } else el.textContent = ''; });
  return fields.length;
}

/** When the owner hands back: every secret text field of the page, now. It is the only clearing: a clear after a
 * click or Enter was dropped, since it can blank a password before a slow or captcha submit has read it, or when
 * nothing was submitted, and a submit is not always a click on a button. What was typed stays out of every result
 * by `scrubTyped`, whether or not the page's fields were emptied. */
export const CLEAR_SECRETS_ON_HANDBACK_JS = `(()=>{${PAGE_SECRETS_JS};${clearSecrets};return clearSecrets(document)})()`;

/** How many typed strings a tab remembers: the most recent ones. A person types a handful of secrets in a takeover. */
export const MAX_REMEMBERED = 50;
/** Remember `text` in `typed` (a Set), most recent last, dropping the oldest past `MAX_REMEMBERED`. */
export function rememberTyped(typed, text) {
  typed.delete(text);
  typed.add(text);
  while (typed.size > MAX_REMEMBERED) typed.delete(typed.values().next().value);
}

/** The marker a hidden secret becomes (the same word `hideSecrets` writes in the page). */
const HIDDEN = '[hidden]';
/** What a site makes of a typed value inside an address: `encodeURIComponent`, and the form encoding a query uses
 * (a space is `+`, and `!'()*~` are written out). */
const urlForms = value => {
  const component = encodeURIComponent(value);
  return [component, component.replace(/[!'()*~]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`).replace(/%20/g, '+')];
};
/** Every string key that carries binary, not words: a picture is left alone, a match inside it would only damage it. */
const BINARY_KEYS = new Set(['image']);

/** `result` with every string in it scrubbed of what the owner typed in secret, as a deep copy; the input is never
 * changed. Each string in `typed` of 3 characters or more becomes `[hidden]`, in any letter case, and its
 * percent-encoded and form-encoded spellings do too, in every string: an address, or a sentence that quotes one
 * ("Redirecting to https://site/?pw=..."). A value with no special character spells the same either way. One pass per string: every match range
 * of every spelling is found (matches that overlap each other included), overlapping or touching ranges are
 * merged, and each merged range becomes one `[hidden]`, so no part of a secret is left and the marker is never
 * cut. Runs in Node, over a capture, an action result, a live view or a tab's status before it leaves. */
export function scrubTyped(result, typed) {
  const needles = [...new Set([...(typed || [])].filter(v => typeof v === 'string' && v.length >= 3))];
  const escape = v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const plain = needles.map(v => new RegExp(escape(v), 'gi'));
  const encoded = needles.flatMap(v => urlForms(v)).filter((v, i, all) => all.indexOf(v) === i && !needles.includes(v)).map(v => new RegExp(escape(v), 'gi'));
  const scrub = text => {
    if (!needles.length || !text) return text;
    const ranges = [];
    for (const found of [...plain, ...encoded]) {
      found.lastIndex = 0;
      for (let m = found.exec(text); m; m = found.exec(text)) { ranges.push([m.index, m.index + m[0].length]); found.lastIndex = m.index + 1; }
    }
    // A `[hidden]` already in the text is the page's own marker, never part of a match: a typed "hid" must not cut it.
    const marks = [];
    for (let at = text.indexOf(HIDDEN); at >= 0; at = text.indexOf(HIDDEN, at + HIDDEN.length)) marks.push([at, at + HIDDEN.length]);
    if (marks.length) for (let i = ranges.length - 1; i >= 0; i--) if (marks.some(([from, to]) => ranges[i][0] < to && ranges[i][1] > from)) ranges.splice(i, 1);
    if (!ranges.length) return text;
    ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    let out = '', at = 0;
    for (let i = 0; i < ranges.length;) {
      const start = ranges[i][0];
      let end = ranges[i][1];
      for (i++; i < ranges.length && ranges[i][0] <= end; i++) end = Math.max(end, ranges[i][1]);
      out += text.slice(at, start) + HIDDEN;
      at = end;
    }
    return out + text.slice(at);
  };
  const walk = (value, key) => {
    if (typeof value === 'string') return BINARY_KEYS.has(key) ? value : scrub(value);
    if (Array.isArray(value)) return value.map(item => walk(item, key));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]));
    return value;
  };
  return walk(result);
}
