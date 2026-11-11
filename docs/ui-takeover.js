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
import {esc, btn} from './ui-kit.js?v=2d8fb27009';
import {api, sync, isStaticDemo} from './ui-store.js?v=2d8fb27009';
import {openSheet, closeSheet, sheetOpen, toast} from './ui-dialogs.js?v=2d8fb27009';

/** The open takeover: its session id on the server, the request it belongs to,
 * the last page the server sent, and the control the person is typing into. */
let live = null;

/** A session that is gone (timed out, another tab closed it) is not an error the
 * person can act on: close the sheet and say so. Anything else propagates. */
const gone = error => error && [404, 409].includes(error.status);

function controlChip(element) {
  const isField = ['input', 'textarea', 'select'].includes(element.tag);
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
  const actions = `<div class="sheet-actions">
    ${btn('Refresh', 'takeover-refresh', {small: true})}
    ${btn('Hand back to the bot', 'takeover-handback', {kind: 'primary', wide: true})}
    ${btn('Close without handing back', 'takeover-close', {kind: 'quiet', small: true})}
  </div>`;
  openSheet(`${page}${go}${controls}${type}${actions}<p class="note">Signing in is saved only for this takeover and thrown away when it ends. X refuses click and type, and the final Post stays yours.</p>`,
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
    if (['input', 'textarea', 'select'].includes(element.tag)) {
      live.selected = live.selected === index ? null : index;
      render();
      return;
    }
    return act({op: 'click', index});
  },
  'takeover-handback': () => handBack(),
  'takeover-close': () => closeHeld(),
};

export const takeoverForms = {
  'takeover-form': async (form, values) => {
    if (!live || live.selected == null) return;
    await act({op: 'type', index: live.selected, text: String(values.text ?? '')});
  },
  'takeover-go-form': async (form, values) => {
    const url = String(values.url || '').trim();
    if (url) await act({op: 'navigate', url});
  },
};
