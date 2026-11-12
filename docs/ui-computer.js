/** The rules behind a bot's Computer view, as plain functions with no DOM and no globals,
 * so Node tests import them (tests/ui-computer.test.js): scaling a click from the
 * displayed picture to the 1280x800 page, turning keys and the wheel into the events
 * `POST /api/browser-live/:bot/input` takes, joining typed letters, the line under the
 * page, the poll schedule and the site chip on a progress pill. The markup, timers and
 * events are in ui-computer-view.js.
 *
 * The numbers match agent/live-input.mjs, which is the one place the device checks an
 * event: a point is clamped to the page, text is at most 2000 characters and a wheel
 * turn at most 5000 pixels, so nothing built here can be refused for its size. */
import {hostOf} from './bot-browser.js?v=2c827d8a6b';

/** The page the owner sees, in CSS pixels. A frame carries its own size; this is the fallback. */
export const PAGE = {w: 1280, h: 800};
const MAX_TYPED = 2000, WHEEL_LIMIT = 5000;
/** The named keys the device presses. A letter is typed, not pressed. */
const KEY_NAMES = ['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'];
/** Keys with no keyboard of their own on a phone, and Tab, which a laptop keeps for moving focus out of the picture. */
export const KEY_CHIPS = [
  {key: 'PageUp', label: 'Page up', aria: 'Page up'}, {key: 'PageDown', label: 'Page down', aria: 'Page down'},
  {key: 'Tab', label: 'Tab', aria: 'Tab key'}, {key: 'Enter', label: 'Enter', aria: 'Enter key'},
  {key: 'Backspace', label: 'Backspace', aria: 'Backspace key'}, {key: 'Escape', label: 'Esc', aria: 'Escape key'},
];

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/* ---------- pointer and wheel ---------- */

/** Where a point on screen is on the page. `rect` is the displayed picture's box (getBoundingClientRect),
 * `at` the pointer's {x, y} in the same space, `size` the frame's {w, h}. Null for a picture with no size. */
export function pagePoint(rect, at, size = PAGE) {
  if (!rect || !(rect.width > 0) || !(rect.height > 0) || !at) return null;
  const x = ((at.x - rect.left) / rect.width) * size.w, y = ((at.y - rect.top) / rect.height) * size.h;
  return {x: Math.round(clamp(x, 0, size.w)), y: Math.round(clamp(y, 0, size.h))};
}

export function clickInput(rect, at, size = PAGE, double = false) {
  const p = pagePoint(rect, at, size);
  return p ? {type: 'click', x: p.x, y: p.y, ...(double ? {double: true} : {})} : null;
}

/** A wheel turn, in page pixels: the picture is usually smaller than the page, so a turn over it scrolls further. */
export function wheelInput(ev, rect, at, size = PAGE) {
  const p = pagePoint(rect, at, size);
  if (!p) return null;
  const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? rect.height : 1, scale = (size.w / rect.width) * unit;
  const turn = n => clamp(Math.round((Number(n) || 0) * scale), -WHEEL_LIMIT, WHEEL_LIMIT);
  return {type: 'scroll', x: p.x, y: p.y, dx: turn(ev.deltaX), dy: turn(ev.deltaY)};
}

/* ---------- keys ---------- */

/** A key press as an input event, or null when it is not the page's: a shortcut (Ctrl, Alt, Cmd),
 * a modifier on its own, or a key the device has no code for. AltGr types a character, so it passes. */
export function keyInput(ev) {
  if (!ev || typeof ev.key !== 'string') return null;
  if (ev.metaKey || ((ev.ctrlKey || ev.altKey) && !ev.altGraph)) return null;
  if (KEY_NAMES.includes(ev.key)) return {type: 'key', key: ev.key};
  return [...ev.key].length === 1 ? {type: 'type', text: ev.key} : null;
}

/** Join events that can travel as one, in order: letters typed in a row, and wheel turns in a row. */
export function coalesce(events) {
  const out = [];
  for (const e of events || []) {
    const last = out.at(-1);
    if (last && e.type === 'type' && last.type === 'type' && last.text.length + e.text.length <= MAX_TYPED) last.text += e.text;
    else if (last && e.type === 'scroll' && last.type === 'scroll') Object.assign(last, {x: e.x, y: e.y, dx: clamp(last.dx + e.dx, -WHEEL_LIMIT, WHEEL_LIMIT), dy: clamp(last.dy + e.dy, -WHEEL_LIMIT, WHEEL_LIMIT)});
    else out.push({...e});
  }
  return out;
}

/** What the address box sends: a full http(s) address, or null. A bare `example.com` gets https. */
export function navigateAddress(text) {
  const raw = String(text ?? '').trim();
  if (!raw || raw.length > 2000 || /\s/.test(raw)) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && /^(javascript|data|file|about|mailto|blob|view-source|vbscript):/i.test(raw)) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    return /^https?:$/.test(url.protocol) && url.hostname ? url.href : null;
  } catch { return null; }
}

/* ---------- what the view says ---------- */

const STATES = ['idle', 'browsing', 'driving'];
const LABELS = {idle: 'Idle', browsing: 'Browsing', driving: 'You are driving'};
/** The profile row's value. */
export const rowLabel = state => LABELS[state] || LABELS.idle;
/** One bot's state out of `GET /api/browser-live`; idle when the list has nothing on it. */
export const statusOf = (list, botId) => (Array.isArray(list) ? list.find(e => e.botId === botId)?.state : null) || 'idle';

const ago = (at, now) => {
  const diff = now - Date.parse(at);
  if (!Number.isFinite(diff)) return '';
  const s = Math.max(0, Math.round(diff / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};

/** The line under the page. Plain text: the caller escapes it. */
export function stateLine({name = 'The bot', state, title, site, pages, now = Date.now()} = {}) {
  if (state === 'driving') return 'You have the browser';
  if (state === 'browsing') return title ? `${name} is on ${title}` : site ? `${name} is opening ${site}` : `${name} is browsing`;
  const when = ago((pages || []).at(-1)?.at, now);
  return when ? `Idle · last used ${when}` : 'Idle';
}

/** A notice from the device (a takeover that could not start), or ''. */
export const noteFor = reply => (typeof reply?.notice === 'string' ? reply.notice : '');

const IMAGE = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const size = n => (Number.isFinite(n) && n > 0 ? n : 0);
const text = (value, fallback) => (typeof value === 'string' ? value : fallback);

/** Fold one `GET /api/browser-live/:bot` reply into what the view shows. A reply with no new frame keeps the
 * last picture; no device clears it; a picture that is not an image data URL is never used. */
export function mergeView(prev, reply) {
  const p = prev || {}, r = reply || {};
  const agent = r.agent !== false;
  const state = STATES.includes(r.state) ? r.state : p.state || 'idle';
  const base = {agent, demo: r.demo === true, state, url: text(r.url, p.url || ''), title: text(r.title, p.title || ''), site: text(r.site, p.site || ''), notice: noteFor(r)};
  if (!agent) return {...base, seq: 0, image: '', w: p.w || PAGE.w, h: p.h || PAGE.h};
  const fresh = typeof r.image === 'string';
  return {
    ...base,
    seq: Number.isFinite(r.seq) ? r.seq : p.seq || 0,
    image: fresh ? (IMAGE.test(r.image) ? r.image : '') : p.image || '',
    w: size(r.w) || p.w || PAGE.w, h: size(r.h) || p.h || PAGE.h,
  };
}

/** What fills the picture's place until there is a picture: the demo's, a viewer's, the missing device's,
 * or the quiet start. `kind` is '' when a frame is showing. */
export function veilFor({name = 'The bot', view = {}, denied = false, state = view.state} = {}) {
  if (view.demo) return {kind: 'demo', title: 'The demo has no browser', text: 'In the full app a bot opens pages in one shared browser on the computer that runs the local agent, and you watch them here and can take over.'};
  if (denied) return {kind: 'viewer', title: 'Members only', text: 'Only members can watch a bot\'s browser, because it can show anything the owner is signed in to.'};
  if (view.agent === false) return {kind: 'offline', title: 'No device is running the shared browser', text: `A server on your own computer starts it by itself, so restarting the server brings it back. On another machine, start the agent with AGENT_BROWSER=1 set, and ${name}'s tab shows up here.`, code: 'AGENT_BROWSER=1 node agent/agent.mjs run'};
  if (view.image) return {kind: ''};
  if (state === 'driving') return {kind: 'empty', title: 'Opening the tab', text: 'The first picture is on its way.'};
  if (state === 'browsing') return {kind: 'empty', title: `Watching ${name}`, text: 'The first picture is on its way.'};
  return {kind: 'empty', title: 'Nothing open', text: `${name} opens pages here when a job needs the web. Sign-ins are shared by all bots.`};
}

/* ---------- polling ---------- */

/** Milliseconds until the next frame poll, or null to stop: quick while the view is visible, off while hidden,
 * slow with no device (it still looks, so a started agent shows up) and backing off after errors. */
export function frameDelay({visible, agent, failures = 0}) {
  if (!visible) return null;
  if (failures > 0) return Math.min(5000, 300 * 2 ** failures);
  return agent ? 300 : 3000;
}
/** The list that feeds the profile row and the pill: slowly, and not at all when hidden or refused. */
export const listDelay = ({visible, disabled = false}) => (visible && !disabled ? 5000 : null);
/** Whether anything on screen needs the list right now. */
export const wantsList = ({route, requests = [], live = []}) =>
  Boolean(route?.profile) || requests.some(r => r.status === 'dispatched') || live.some(e => e.state === 'driving');

/* ---------- the site chip and the pages list ---------- */

/** The chip a progress pill (or a bot chat's "is working" line) carries: the host of the page a bot of this
 * run has open. It reads the bot's `dispatched` request, which the snapshot already has, and falls back to the
 * live list's `site`. `driving` is set when the owner holds that bot, so the line can say so. */
export function chipFor({requests = [], live = [], runId = null, botId = null}) {
  const open = r => r.status === 'dispatched' && hostOf(r.url);
  const request = (runId && requests.find(r => r.runId === runId && open(r))) || (botId && requests.find(r => r.botId === botId && open(r))) || null;
  const entry = id => live.find(e => e.botId === id);
  if (request) return {botId: request.botId, site: hostOf(request.url), ...(entry(request.botId)?.state === 'driving' ? {driving: true} : {})};
  const e = botId && entry(botId);
  if (e && e.site && (e.state === 'browsing' || e.state === 'driving')) return {botId, site: e.site, ...(e.state === 'driving' ? {driving: true} : {})};
  return null;
}

/** The pages of this run, or of the last one, as rows: a title (else the host) and the host beside it. */
export const pagesRows = pages => (pages || []).filter(p => p && p.url).map(p => {
  const host = hostOf(p.url);
  return {text: p.title || host || p.url, host, url: p.url, at: p.at};
});

/* ---------- the full-screen view ---------- */

/** The part of `box` a picture of `size` fills when it is fitted whole and centred (object-fit: contain).
 * A click is mapped through this, not through the element's box, so the bars beside the picture are not page. */
export function containRect(box, size = PAGE) {
  if (!box || !(box.width > 0) || !(box.height > 0) || !(size?.w > 0) || !(size?.h > 0)) return null;
  const scale = Math.min(box.width / size.w, box.height / size.h);
  const width = Math.round(size.w * scale), height = Math.round(size.h * scale);
  return {left: Math.round(box.left + (box.width - width) / 2), top: Math.round(box.top + (box.height - height) / 2), width, height};
}

/** The one pill on the full-screen view: who holds the browser, and the switch that changes it.
 * `unavailable` is the words for a view with nothing to drive (the demo, no device, a viewer). */
export function controlPill({name = 'The bot', state = 'idle', unavailable = ''} = {}) {
  if (unavailable) return {who: unavailable, action: '', label: ''};
  if (state === 'driving') return {who: 'You are in control', action: 'back', label: 'Hand back control'};
  return {who: `${name} is in control`, action: 'take', label: 'Take control'};
}

/* ---------- the small live picture on a profile and a chat header ---------- */

/** What the thumbnail shows, or null for none: only while the bot's browser is in use (browsing, or the owner
 * driving), never in the demo or with no device. `state` and `site` are the list's; `view` is the last frame reply
 * (mergeView), fresher than the list when there is one. `label` is the button's words. */
export function thumbFor({state = 'idle', site = '', view = null, demo = false, name = 'the bot'} = {}) {
  if (demo || view?.demo || view?.agent === false) return null;
  const now = view && STATES.includes(view.state) ? view.state : state;
  if (now !== 'browsing' && now !== 'driving') return null;
  const where = view?.site || site || '';
  const label = now === 'driving' ? `You are driving ${name}'s browser${where ? `, on ${where}` : ''}` : `Watch ${name}${where ? ` on ${where}` : ''}`;
  return {state: now, site: where, image: view?.image || '', label};
}
/** Milliseconds until the thumbnail looks again, or null to stop: gently, only while it is on screen and active. */
export const thumbDelay = ({visible, active, failures = 0}) => (!visible || !active ? null : Math.min(15000, 2500 * 2 ** failures));
