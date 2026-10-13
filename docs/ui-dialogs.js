/** Overlays: the toast, the bottom sheet (#modal) and its confirm/ask helpers.
 * Sheets replace `window.confirm`/`prompt` so a decision never leaves the chat's
 * visual language, and they hand focus back to whatever opened them. */
import {esc, btn, iconBtn} from './ui-kit.js?v=f0b0c2abd8';

const el = id => document.getElementById(id);
let toastTimer = null, lastFocus = null, settle = null;

export function toast(message, error = false) {
  const node = el('toast'); if (!node) return;
  node.textContent = message; node.classList.toggle('error', Boolean(error)); node.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.add('hidden'), 3800);
}

// Dialogs declare aria-modal, so they must hand focus back to the control that
// opened them; without this a keyboard user is dropped at the top of the page.
export function captureFocus() { lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null; }
export function restoreFocus() { const node = lastFocus; lastFocus = null; if (node && document.contains(node) && typeof node.focus === 'function') node.focus(); }

export const sheetOpen = () => !el('modal').classList.contains('hidden');

/** Show `html` as a sheet. `label` names the dialog for assistive tech. */
export function openSheet(html, {label, title = '', sub = ''} = {}) {
  if (!sheetOpen()) captureFocus();
  // A sheet opened over a pending confirm/ask answers that one as dismissed.
  const pending = settle; settle = null; if (pending) pending(null);
  const layer = el('modal');
  layer.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(label || title)}"><div class="sheet-grip" aria-hidden="true"></div>${title ? `<div class="sheet-head"><div><h2>${esc(title)}</h2>${sub ? `<p>${esc(sub)}</p>` : ''}</div>${iconBtn('x', 'Close', 'close-sheet')}</div>` : ''}${html}</div>`;
  layer.classList.remove('hidden');
  // Focus now, not on the next frame: a late frame would pull focus back here
  // after the user had already moved on, and their typing would land in the wrong field.
  (layer.querySelector('[autofocus]') || layer.querySelector('input,textarea,select,button.primary,button'))?.focus();
}
export function closeSheet(result = null) {
  if (!sheetOpen()) return;
  el('modal').classList.add('hidden'); el('modal').innerHTML = '';
  const done = settle; settle = null; if (done) done(result);
  restoreFocus();
}

/** Resolves true only when the user picks the confirming action. */
export function confirmSheet(message, {confirm = 'Confirm', danger = false, detail = ''} = {}) {
  return new Promise(resolve => {
    openSheet(`<div class="sheet-actions">${btn(confirm, 'sheet-confirm', {kind: danger ? 'danger' : 'primary', wide: true})}${btn('Cancel', 'close-sheet', {wide: true})}</div>`, {title: message, sub: detail});
    settle = value => resolve(value === true);
  });
}
/** Resolves the entered text, or null when dismissed. */
export function askSheet(title, {sub = '', placeholder = '', value = '', submit = 'Continue', readonly = false} = {}) {
  return new Promise(resolve => {
    openSheet(`<form id="ask-form"><textarea class="input" name="answer" rows="3" aria-label="${esc(title)}" placeholder="${esc(placeholder)}" ${readonly ? 'readonly' : ''} autofocus>${esc(value)}</textarea><div class="sheet-actions">${btn(submit, null, {kind: 'primary', type: 'submit', wide: true})}</div></form>`, {title, sub});
    settle = answer => resolve(typeof answer === 'string' ? answer : null);
  });
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
/** Keep Tab inside whichever aria-modal layer is open. */
export function trapTab(ev) {
  if (ev.key !== 'Tab') return;
  const layer = ['login-layer', 'modal', 'command'].map(el).find(node => node && !node.classList.contains('hidden'));
  if (!layer) return;
  const nodes = [...layer.querySelectorAll(FOCUSABLE)].filter(n => n.offsetParent !== null);
  if (!nodes.length) return;
  const first = nodes[0], last = nodes[nodes.length - 1], active = document.activeElement;
  if (ev.shiftKey && (active === first || !layer.contains(active))) { ev.preventDefault(); last.focus(); }
  else if (!ev.shiftKey && (active === last || !layer.contains(active))) { ev.preventDefault(); first.focus(); }
}
