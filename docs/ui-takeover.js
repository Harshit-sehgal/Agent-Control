/** Live takeover: a person drives the page a bot asked for.
 *
 * The bot's browser cannot solve a sign-in, a 2FA prompt or a challenge that
 * only a person can. This opens that page in a context the server keeps until
 * the person is done, shows them a picture of it, and lets them click, type and
 * navigate until they reach the page they wanted. Handing it back reads the
 * page as they left it and resumes the bot from it.
 *
 * It is a screenshot remote control, not a live stream: one JPEG per call. The
 * server enforces the same allowlist and the same X refusal as any other page,
 * so this is a way to sign in, never a way around the rules. */
import {esc, btn} from './ui-kit.js?v=85aac70d41';
import {takeoverControl} from './ui-model.js?v=85aac70d41';
import {api, sync, isStaticDemo} from './ui-store.js?v=85aac70d41';
import {openSheet, closeSheet, sheetOpen, toast} from './ui-dialogs.js?v=85aac70d41';

/** The open takeover: its session id on the server, the request it belongs to,
 * the last page the server sent, and the control the person is typing into. */
let live = null;

/** A session that is gone (timed out, another tab closed it) is not an error the
 * person can act on: close the sheet and say so. Anything else propagates. */
const gone = error => error && [404, 409].includes(error.status);

function controlChip(element) {
  const isField = takeoverControl(element).field;
  const on = live.selected === element.index;
  const label = `[${element.index}] ${element.tag}${element.text ? ` ${element.text}` : ''}`;
  return `<button type="button" class="takeover-control${on ? ' on' : ''}" data-action="takeover-control" data-index="${element.index}" aria-pressed="${on}" title="${esc(isField ? 'Type into this control' : 'Click this control')}">${esc(label)}</button>`;
}

function render() {
  const view = live.view || {};
  const elements = Array.isArray(view.elements) ? view.elements : [];
  const controls = elements.length
    ? `<div class="takeover-controls">${elements.slice(0, 80).map(controlChip).join('')}</div>`
    : '<p class="note">This page has no controls to tap. Use the address box to open another page.</p>';
  const selected = live.selected == null ? null : elements.find(e => e.index === live.selected);
  // A password or a code goes only into a text-entry control: the rows stay disabled for a select or a checkbox.
  const secretReady = Boolean(selected) && takeoverControl(selected).text;
  const page = `<div class="takeover-page">
    ${view.image ? `<img class="takeover-shot" src="${esc(view.image)}" alt="A picture of the page open in the browser">` : '<p class="note">Waiting for the page…</p>'}
    <p class="takeover-here">${view.title ? `<strong>${esc(view.title)}</strong> ` : ''}<a href="${esc(view.url || '#')}" target="_blank" rel="noopener noreferrer">${esc(view.url || '')}</a></p>
    ${Number(view.blockedRequests) ? `<p class="note warn">${Number(view.blockedRequests)} request${Number(view.blockedRequests) === 1 ? '' : 's'} on this page were blocked by the allowlist or the egress proxy.</p>` : ''}
  </div>`;
  const go = `<form id="takeover-go-form" class="takeover-go"><input class="input" name="url" type="url" inputmode="url" placeholder="https://… open another page" aria-label="Open another page"><button type="submit" class="btn quiet small">Open</button></form>`;
  const type = `<form id="takeover-form" class="takeover-type">
    <p class="field-label">${selected ? `Type into “${esc(selected.text || selected.tag)}”` : 'Tap a field above to choose what to type into'}</p>
    <input class="input" name="text" placeholder="${selected ? 'Type here, then Send' : 'No field chosen'}" aria-label="Text to type" ${selected ? 'autofocus' : 'disabled'}>
    <button type="submit" class="btn primary small" ${selected ? '' : 'disabled'}>Send</button>
  </form>`;
  // This sheet drives a page in the server's own browser, not a device, so it keeps its fields whatever a paired device
  // reports (`secret-input-v1` gates only the Computer view, which types through a device).
  // A password or a code is sent as a `secret`: the device tags the field first, and nothing here echoes it.
  const secretRow = (id, label, attrs) => `<form id="${id}" class="takeover-type" autocomplete="off">
    <input class="input" name="text" maxlength="2000" placeholder="${label}" aria-label="${label}" ${attrs} ${secretReady ? '' : 'disabled'}>
    <button type="submit" class="btn primary small" ${secretReady ? '' : 'disabled'}>Type</button>
  </form>`;
  const secrets = secretRow('takeover-password', 'Password', 'type="password" autocomplete="current-password"')
    + secretRow('takeover-code', 'Code', 'inputmode="numeric" autocomplete="one-time-code" spellcheck="false" autocapitalize="off"');
  const actions = `<div class="sheet-actions">
    ${btn('Refresh', 'takeover-refresh', {small: true})}
    ${btn('Hand back to the bot', 'takeover-handback', {kind: 'primary', wide: true})}
    ${btn('Close without handing back', 'takeover-close', {kind: 'quiet', small: true})}
  </div>`;
  openSheet(`${page}${go}${controls}${type}${secrets}${actions}<p class="note">Signing in is saved only for this takeover and thrown away when it ends.</p>`,
    {title: 'Take over the page', sub: 'Sign in or answer the challenge, then hand the page back to the bot.', onDismiss: releaseOnDismiss});
}

/** Closing the sheet for any reason (Escape, Back) must not leave the server
 * holding a browser page: the bot would be blocked until it timed out. */
function releaseOnDismiss() {
  if (!live) return;
  const id = live.id;
  live = null;
  void api(`/api/browser-sessions/${id}`, 'DELETE').catch(() => {});
}

/** Open the page a bot asked for and show it. */
export async function startTakeover(requestId) {
  if (isStaticDemo()) throw new Error('Live takeover needs the Node build; this demo cannot open pages.');
  const view = await api('/api/browser-sessions', 'POST', {requestId});
  // A sheet may already be open (a stale takeover). render() installs its own
  // onDismiss, so close the old one first rather than let it hold a page.
  if (sheetOpen()) closeSheet();
  live = {id: view.id, requestId: view.requestId || requestId, view, selected: null};
  render();
}

function goneSheet(error) {
  live = null;
  closeSheet();
  toast(error?.message || 'That takeover is no longer open.', true);
}

async function act(body) {
  if (!live) return;
  try {
    const view = await api(`/api/browser-sessions/${live.id}/act`, 'POST', body);
    live.view = {...live.view, ...view};
    // A click may have landed on a new page; a type lands in the control just
    // chosen, which stays chosen so a second Send needs no re-tap.
    if (body.op === 'click') live.selected = null;
    render();
    if (view.ok === false && view.reason) toast(view.reason, true);
  } catch (error) {
    if (!gone(error)) throw error;
    goneSheet(error);
  }
}

async function refresh() {
  if (!live) return;
  try {
    live.view = await api(`/api/browser-sessions/${live.id}`);
    render();
  } catch (error) {
    if (!gone(error)) throw error;
    goneSheet(error);
  }
}

async function handBack() {
  if (!live) return;
  const id = live.id;
  let result;
  try { result = await api(`/api/browser-sessions/${id}/handback`, 'POST', {}); }
  catch (error) {
    if (!gone(error)) throw error;
    goneSheet(error);
    return;
  }
  live = null;
  closeSheet();
  toast(result?.handedBack ? 'Handed the page back to the bot.' : (result?.reason || 'Takeover closed.'));
  await sync();
}

async function closeHeld() {
  if (!live) { closeSheet(); return; }
  const id = live.id;
  live = null;
  closeSheet();
  try { await api(`/api/browser-sessions/${id}`, 'DELETE'); } catch { /* Already gone. */ }
  toast('Takeover closed. The bot is not resumed.');
}

export const takeoverActions = {
  'takeover-browser': b => startTakeover(b.dataset.id),
  'takeover-refresh': () => refresh(),
  'takeover-control': b => {
    if (!live) return;
    const index = Number(b.dataset.index);
    const element = (live.view.elements || []).find(e => e.index === index);
    if (!element) return;
    // A field is chosen for typing; anything else is a click.
    if (takeoverControl(element).field) {
      live.selected = live.selected === index ? null : index;
      render();
      return;
    }
    return act({op: 'click', index});
  },
  'takeover-handback': () => handBack(),
  'takeover-close': () => closeHeld(),
};

/** The text leaves the box before it is sent, so a refused or failed send never leaves a password sitting in it. */
async function typeSecret(form, values) {
  const text = String(values.text ?? '');
  form.reset();
  const chosen = live && live.selected != null ? (live.view.elements || []).find(e => e.index === live.selected) : null;
  if (!chosen || !takeoverControl(chosen).text || !text) return;
  await act({op: 'type', index: live.selected, text, secret: true});
}

export const takeoverForms = {
  'takeover-form': async (form, values) => {
    if (!live || live.selected == null) return;
    await act({op: 'type', index: live.selected, text: String(values.text ?? '')});
  },
  'takeover-password': (form, values) => typeSecret(form, values),
  'takeover-code': (form, values) => typeSecret(form, values),
  'takeover-go-form': async (form, values) => {
    const url = String(values.url || '').trim();
    if (url) await act({op: 'navigate', url});
  },
};
