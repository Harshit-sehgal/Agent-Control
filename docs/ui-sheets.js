/** The two full-screen layers a signed-in person can still raise: sign-in (when the
 * session ends) and the change-password sheet. Everything else that used to be a
 * sheet here (new bot, new group, attach, scheduled task) is a page now (ui-profile.js). */
import {esc, btn, field} from './ui-kit.js?v=e0e04f8691';
import {openSheet} from './ui-dialogs.js?v=e0e04f8691';

const el = id => document.getElementById(id);

/* ---------- sign-in (Node build) ---------- */

export function showLogin(message = '', view = 'sign-in') {
  let layer = el('login-layer');
  // A repeated session-expiry notice must not rebuild the dialog: doing so would
  // clear a password the user is mid-way through typing.
  const visible = Boolean(layer) && !layer.classList.contains('hidden');
  if (!layer) { layer = document.createElement('div'); layer.id = 'login-layer'; layer.className = 'modal-layer'; document.body.appendChild(layer); }
  if (visible && (layer.dataset.view || 'sign-in') === view) { const err = el('login-error'); if (err && message) err.textContent = message; return; }
  layer.dataset.view = view;
  const back = btn('Back to sign in', 'login-back', {kind: 'ghost', wide: true});
  const head = view === 'forgot'
    ? `<h2>Reset password</h2><p>The server prints a one-time token in its log. The answer is the same if the address is unknown.</p>`
    : view === 'reset'
      ? `<h2>Choose a new password</h2><p>Paste the token from the server log. It works once, for one hour.</p>`
      : `<h2>Sign in</h2><p>Invited members use their email. The owner account can leave it blank.</p>`;
  const form = view === 'forgot'
    ? `<form id="forgot-form" class="form">${field('Email', `<input class="input" type="email" name="email" autocomplete="username" required autofocus>`)}${btn('Request token', null, {kind: 'primary', type: 'submit', wide: true})}<p class="note" id="login-error" role="alert">${esc(message)}</p></form>${back}`
    : view === 'reset'
      ? `<form id="reset-form" class="form">${field('Reset token', `<input class="input" name="token" autocomplete="one-time-code" required autofocus>`)}${field('New password', `<input class="input" type="password" name="password" autocomplete="new-password" required minlength="8">`, 'At least 8 characters.')}${btn('Update password', null, {kind: 'primary', type: 'submit', wide: true})}<p class="note" id="login-error" role="alert">${esc(message)}</p></form>${back}`
      : `<form id="login-form" class="form">${field('Email', `<input class="input" type="email" name="email" autocomplete="username" placeholder="owner@localhost">`, 'Needed for an invited account. The owner can omit it.')}${field('Dashboard password', `<input class="input" type="password" name="password" autocomplete="current-password" required autofocus>`)}${btn('Unlock', null, {kind: 'primary', type: 'submit', wide: true})}<p class="note" id="login-error" role="alert">${esc(message)}</p></form><div class="row-actions">${btn('Forgot password', 'login-forgot', {kind: 'ghost', small: true})}${btn('I have a token', 'login-reset', {kind: 'ghost', small: true})}</div>`;
  layer.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="Sign in"><div class="sheet-head"><div>${head}</div></div>${form}</div>`;
  layer.classList.remove('hidden');
  layer.querySelector('input[autofocus]')?.focus();
}
export const hideLogin = () => { const layer = el('login-layer'); if (layer) { layer.classList.add('hidden'); layer.innerHTML = ''; } };

export function changePasswordSheet() {
  openSheet(`<form id="password-form" class="form">
    ${field('Current password', `<input class="input" type="password" name="currentPassword" autocomplete="current-password" required autofocus>`)}
    ${field('New password', `<input class="input" type="password" name="newPassword" autocomplete="new-password" required minlength="8">`, 'At least 8 characters. Other sessions are signed out.')}
    ${btn('Update password', null, {kind: 'primary', type: 'submit', wide: true})}
  </form>`, {title: 'Change password'});
}
