/**
 * What is secret on a page, in the page. A password, a one-time code, a card number or anything the page's
 * author tagged `data-agent-secret` must never reach a model: not by the field's name, and not in page text.
 *
 * These three functions run inside Chrome, embedded by `.toString()` the way `foldLabel` is (agent/browser.mjs),
 * so each one is fully self-contained: no imports, no module-level names. The few lines that decide "is this
 * secret" are therefore repeated in each; a test checks that all three agree.
 *
 *   isSecretField(el)         is this field secret?
 *   labelOf(el)               the words that name a control for the model, never a secret field's content
 *   hideSecrets(text, fields) `text` with every secret field's content replaced by "[hidden]"
 */

/** True for a password field, a field whose autocomplete names a code or card, or one inside `data-agent-secret`. */
export function isSecretField(el) {
  const kinds = ['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year'];
  const type = String(el.type || '').toLowerCase();
  const tokens = String(el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
  return type === 'password' || tokens.some(t => kinds.includes(t)) || Boolean(el.closest('[data-agent-secret]'));
}

/** A control's name for the model. A secret field is named by aria-label, its first <label>, placeholder, name,
 * then "password field" / "secret field", never by its value or text; every other element keeps
 * innerText, value, aria-label, placeholder, name. Whitespace is collapsed. */
export function labelOf(el) {
  const kinds = ['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year'];
  const type = String(el.type || '').toLowerCase();
  const tokens = String(el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
  const secret = type === 'password' || tokens.some(t => kinds.includes(t)) || Boolean(el.closest('[data-agent-secret]'));
  const clean = t => String(t || '').replace(/\s+/g, ' ').trim();
  const attr = n => el.getAttribute(n);
  const name = el.name || attr('name');
  if (!secret) return clean(el.innerText || el.value || attr('aria-label') || attr('placeholder') || name);
  const first = el.labels && el.labels[0];
  return clean(attr('aria-label')) || clean(first && (first.innerText || first.textContent))
    || clean(attr('placeholder')) || clean(name) || (type === 'password' ? 'password field' : 'secret field');
}

/** `text` with the content of each secret field in `fields` (its value, or innerText for a contenteditable)
 * replaced everywhere by [hidden], when that content is at least 3 characters. Longest first, so a value that
 * contains another is hidden whole. */
export function hideSecrets(text, fields) {
  const kinds = ['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year'];
  const values = [];
  for (const el of Array.prototype.slice.call(fields || [])) {
    const type = String(el.type || '').toLowerCase();
    const tokens = String(el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
    if (!(type === 'password' || tokens.some(t => kinds.includes(t)) || el.closest('[data-agent-secret]'))) continue;
    const v = typeof el.value === 'string' ? el.value : (el.isContentEditable ? el.innerText : '');
    if (typeof v === 'string' && v.length >= 3 && !values.includes(v)) values.push(v);
  }
  values.sort((a, b) => b.length - a.length);
  return values.reduce((out, v) => out.split(v).join('[hidden]'), String(text == null ? '' : text));
}

/** The three functions as one script that declares them, to embed in a page expression. */
export const PAGE_SECRETS_JS = [isSecretField, labelOf, hideSecrets].map(f => f.toString()).join(';');
