/** A bot's Computer view: an address bar, the page as a picture, a line under it saying
 * what the bot is doing, Take over and Hand back, and the pages of this run. Ported from
 * mock v46, with the real thing in place of the mock's painted page: the picture is the
 * CDP screencast the local agent sends, polled from `GET /api/browser-live/:bot`.
 *
 * Also here, because they share the one list poll (`GET /api/browser-live`, about every
 * five seconds, only while something on screen needs it): the profile row's Idle /
 * Browsing / You are driving, and the site chip a progress pill carries.
 *
 * The rules (scaling a click, mapping keys, joining typed letters, the poll schedule) are
 * pure and tested in ui-computer.js; this file is markup, timers and events.
 *
 * Polling is what makes the device cast: the server tells the agent to stream a tab only
 * while somebody is looking, so the loop stops when the page is hidden or the view closes.
 * Input goes out in order, one request at a time, with typed letters joined. */
import {esc, icon} from './ui-kit.js?v=028bca98b3';
import {botColor} from './ui-face.js?v=028bca98b3';
import {store, api, findBot, canWrite, isAdmin, isStaticDemo, changed, onChange, go} from './ui-store.js?v=028bca98b3';
/** Driving the tab (Take over, Hand back, input) is an admin's, the role those routes need; the demo is its one owner. */
const canDrive = () => isStaticDemo() || isAdmin();
import {toast} from './ui-dialogs.js?v=028bca98b3';
import {
  PAGE, KEY_CHIPS, clickInput, wheelInput, keyInput, coalesce, navigateAddress, rowLabel, statusOf, stateLine, mergeView, veilFor, frameDelay, listDelay, wantsList,
  chipFor, pagesRows,
} from './ui-computer.js?v=028bca98b3';

const el = id => document.getElementById(id);
const raw = (path, method = 'GET', body) => window.AGENT_API(path, method, body);   // no progress bar: these run all the time

/* ---------- the list: the profile row, the pill's chip, the pages ---------- */

const list = {items: [], timer: null, busy: false, disabled: false, key: ''};
export const liveList = () => list.items;
const fingerprint = items => JSON.stringify((items || []).map(e => [e.botId, e.state, e.site, e.live, (e.pages || []).length, e.pages?.at(-1)?.title || '']));

/** Patch one bot's entry now (after Take over or Hand back), so the row and the pill do not wait for the poll. */
function patchLive(botId, patch) {
  const at = list.items.findIndex(e => e.botId === botId);
  list.items = at < 0 ? [...list.items, {botId, pages: [], ...patch}] : list.items.map((e, i) => (i === at ? {...e, ...patch} : e));
  list.key = fingerprint(list.items);
  paintRows(); paintSession(); changed('thread');
}

/** The profile row's value, as the list says it now. */
export const computerLabel = botId => rowLabel(statusOf(list.items, botId));
function paintRows() {
  for (const node of document.querySelectorAll('[data-computer-row]')) node.textContent = computerLabel(node.dataset.computerRow);
}

async function pollList() {
  list.timer = null;
  if (!store.state || !wantsList({route: store.route, requests: store.state.browserRequests || [], live: list.items}) || document.hidden) return;
  list.busy = true;
  try {
    const items = await raw('/api/browser-live');
    if (Array.isArray(items)) {
      const key = fingerprint(items);
      if (key !== list.key) { list.items = items; list.key = key; paintRows(); paintSession(); changed('thread'); }
    }
  } catch (error) {
    // A viewer or a signed-out session is refused every time; do not ask again until the page reloads.
    if (error?.status === 401 || error?.status === 403) list.disabled = true;
  }
  list.busy = false;
  kickList(listDelay({visible: !document.hidden, disabled: list.disabled}));
}
/** Start the list poll if something needs it and it is not already running. `delay` is for the next round. */
function kickList(delay = 0) {
  if (list.timer || list.busy || list.disabled || delay == null || !store.state || !canWrite()) return;
  if (!wantsList({route: store.route, requests: store.state.browserRequests || [], live: list.items})) return;
  list.timer = setTimeout(pollList, delay);
}

/** The site chip on a progress pill or a bot chat's "is working" line, or null. */
export function siteChip({runId = null, botId = null} = {}) {
  const chip = chipFor({requests: store.state?.browserRequests || [], live: list.items, runId, botId});
  if (!chip) return null;
  const name = findBot(chip.botId)?.name || 'The bot';
  return {
    driving: Boolean(chip.driving),
    html: `<button type="button" class="pchip" data-action="open-computer" data-id="${esc(chip.botId)}" aria-label="Watch ${esc(name)}'s browser, on ${esc(chip.site)}">${icon('monitor', 13)}<span>${esc(chip.site)}</span></button>`,
  };
}

/* ---------- the view ---------- */

const KEYS_ON = '[data-keys="on"]';
/** True when a key press landed on the page while the owner drives: Esc then belongs to the page, not to the app. */
export const keysOwned = target => Boolean(target?.closest?.(KEYS_ON));

let session = null;
const INIT = {agent: true, demo: false, seq: 0, image: '', w: PAGE.w, h: PAGE.h, state: 'idle', url: '', title: '', site: '', notice: ''};
const alive = s => session === s && s.root.isConnected;
const entryOf = botId => list.items.find(e => e.botId === botId);

/** The page for `#profile/<id>/computer`. `faceOf(state)` draws the bot's face for the line under the page. */
export function computerPage(bot, {faceOf}) {
  const write = canDrive();
  setTimeout(() => mount(bot.id, faceOf), 0);
  const keys = KEY_CHIPS.map(c => `<button type="button" class="pc-key" data-action="computer-key" data-id="${esc(bot.id)}" data-text="${esc(c.key)}" aria-label="${esc(c.aria)}">${esc(c.label)}</button>`).join('');
  return `<div class="pc" id="pc" data-bot="${esc(bot.id)}" data-state="idle" style="--t:${esc(botColor(bot))}">
    <div class="pc-win">
      <form class="pc-bar" id="computer-go" data-bot="${esc(bot.id)}" autocomplete="off">
        <span class="pc-dot" data-pc="dot"></span>
        <input class="pc-url" name="url" data-pc="url" readonly tabindex="-1" aria-label="Address" placeholder="about:blank" maxlength="2000" spellcheck="false" autocapitalize="off" inputmode="url">
        <button type="submit" class="pc-go" data-pc="go" hidden>Go</button>
      </form>
      <div class="pc-notice" data-pc="notice" role="status" hidden></div>
      <div class="pc-screen" data-pc="stage" style="aspect-ratio:${PAGE.w}/${PAGE.h}" role="group" aria-label="${esc(bot.name)}'s browser tab">
        <img class="pc-img" data-pc="img" alt="Live picture of ${esc(bot.name)}'s browser tab" draggable="false" hidden>
        <div class="pc-veil" data-pc="veil"></div>
      </div>
      <div class="pc-now" role="status" aria-live="polite"><span class="pc-face" data-pc="face"></span><span class="pc-line" data-pc="line">Idle</span></div>
    </div>
    ${write ? `<div class="pc-act"><button type="button" class="pill-btn" data-pc="hold" data-action="computer-takeover" autofocus data-id="${esc(bot.id)}">Take over</button></div>
    <div class="pc-tools" data-pc="tools" hidden>
      <form class="pc-type" id="computer-type" data-bot="${esc(bot.id)}" autocomplete="off"><input class="input" name="text" maxlength="2000" placeholder="Type into the page" aria-label="Type into the page"><button type="submit" class="btn">Type</button></form>
      <div class="pc-keys" role="group" aria-label="Keys">${keys}</div>
      <p class="pr-note">Click the page, then type or scroll. Tab moves on to the next control here, and the Tab button sends it to the page.</p>
    </div>` : ''}
    <p class="pr-note">Sending, posting, deleting and paying still ask you first.</p>
    <div class="pc-pages" data-pc="pages"></div>
  </div>`;
}

function mount(botId, faceOf) {
  const root = el('pc');
  if (session) end(session);
  if (!root || root.dataset.bot !== botId || !store.state) return;
  const q = name => root.querySelector(`[data-pc="${name}"]`);
  const s = session = {
    botId, root, faceOf, view: {...INIT}, failures: 0, timer: null, denied: false, queue: [], flush: null, sending: false, lastHint: 0, shown: -1, faceState: '',
    stage: q('stage'), img: q('img'), veil: q('veil'), url: q('url'), go: q('go'), dot: q('dot'), notice: q('notice'), line: q('line'), face: q('face'), hold: q('hold'), tools: q('tools'), pages: q('pages'),
  };
  if (!canWrite()) s.denied = true;
  wireStage(s);
  paintSession();
  if (!s.denied) tick(s);
  kickList();
}

function end(s) {
  clearTimeout(s.timer); clearTimeout(s.flush);
  s.timer = s.flush = null;
  if (session === s) session = null;
}

async function tick(s) {
  s.timer = null;
  if (!alive(s)) return end(s);
  if (document.hidden) return;   // the visibility listener starts it again
  try {
    const reply = await raw(`/api/browser-live/${encodeURIComponent(s.botId)}?after=${s.view.seq}`);
    if (!alive(s)) return end(s);
    s.failures = 0;
    s.view = mergeView(s.view, reply);
    paintSession();
  } catch (error) {
    if (!alive(s)) return end(s);
    if (error?.status === 401 || error?.status === 403) { s.denied = true; paintSession(); return; }
    s.failures += 1;
  }
  const wait = frameDelay({visible: !document.hidden, agent: s.view.agent && !s.view.demo, failures: s.failures});
  if (wait != null && !s.view.demo) s.timer = setTimeout(() => tick(s), wait);
}

/** The state the view shows: what the frame endpoint said, unless the list (which Take over patches at once) knows better. */
const stateOf = s => (s.view.demo ? 'idle' : s.view.state);

/** Repaint the open view in place, so the picture and the focus never reset. */
function paintSession() {
  const s = session;
  if (!s || !alive(s)) return;
  const bot = findBot(s.botId), name = bot?.name || 'The bot', state = stateOf(s), driving = state === 'driving';
  const entry = entryOf(s.botId) || {};
  s.root.dataset.state = state;
  s.dot.className = `pc-dot${driving ? ' you' : state === 'browsing' ? ' live' : ''}`;
  // The address: read-only while the bot drives, a field you can use while you do. Never overwrite what is being typed.
  s.url.readOnly = !driving; s.url.tabIndex = driving ? 0 : -1; s.go.hidden = !driving;
  if (document.activeElement !== s.url || s.url.readOnly) s.url.value = s.view.url || entry.url || '';
  s.url.placeholder = driving ? 'Type an address and press Go' : 'about:blank';
  // The picture, or the words in its place.
  const veil = veilFor({name, view: s.view, denied: s.denied, state});
  if (s.view.image && !veil.kind) {
    if (s.shown !== s.view.seq || !s.img.src) { s.img.src = s.view.image; s.shown = s.view.seq; }
    s.img.hidden = false;
    s.stage.style.aspectRatio = `${s.view.w}/${s.view.h}`;
  } else { s.img.hidden = true; s.img.removeAttribute('src'); s.shown = -1; }
  s.veil.hidden = !veil.kind;
  s.veil.innerHTML = veil.kind ? `<strong>${esc(veil.title)}</strong><span>${esc(veil.text)}</span>${veil.code ? `<code>${esc(veil.code)}</code>` : ''}` : '';
  s.veil.dataset.kind = veil.kind;
  s.stage.classList.toggle('idle', state === 'idle' && Boolean(s.view.image));
  s.stage.classList.toggle('drive', driving);
  s.stage.dataset.keys = driving ? 'on' : 'off';
  s.stage.tabIndex = driving ? 0 : -1;
  s.stage.setAttribute('aria-label', driving ? `${name}'s browser tab. You are driving: keys you press go to the page.` : `${name}'s browser tab`);
  // A notice from the device, as it came.
  s.notice.hidden = !s.view.notice; s.notice.textContent = s.view.notice;
  // What the bot is doing.
  const unavailable = s.view.demo || s.denied || s.view.agent === false;
  const line = unavailable ? (s.view.demo ? 'No browser in the demo' : s.denied ? 'Members only' : 'No browser running') : stateLine({name, state, title: s.view.title || '', site: s.view.site || entry.site || '', pages: entry.pages});
  if (s.line.textContent !== line) { s.line.textContent = line; s.line.classList.remove('enter'); void s.line.offsetWidth; s.line.classList.add('enter'); }
  const faceState = driving ? 'waiting' : state === 'browsing' ? 'working' : 'awake';
  if (s.faceState !== faceState && bot) { s.faceState = faceState; s.face.innerHTML = s.faceOf(faceState); }
  // The buttons.
  if (s.hold) {
    s.hold.hidden = s.view.demo || s.denied;
    s.hold.textContent = driving ? 'Hand back' : 'Take over';
    s.hold.dataset.action = driving ? 'computer-handback' : 'computer-takeover';
    s.tools.hidden = !driving;
  }
  paintPages(s, entry, state);
}

function paintPages(s, entry, state) {
  const rows = pagesRows(entry.pages);
  const html = rows.length ? `<h2 class="pc-h">${state === 'idle' ? 'Last run' : 'This run'}</h2><div class="cd"><ul class="pc-trail">${rows.map(r => `<li><span>${esc(r.text)}</span>${r.host && r.host !== r.text ? `<small>${esc(r.host)}</small>` : ''}</li>`).join('')}</ul></div>` : '';
  if (s.pagesHtml !== html) { s.pagesHtml = html; s.pages.innerHTML = html; }
}

/* ---------- the owner's input ---------- */

const push = (s, event) => {
  if (!event || !alive(s) || stateOf(s) !== 'driving') return;
  s.queue.push(event);
  if (!s.flush) s.flush = setTimeout(() => flush(s), 30);
};
async function flush(s) {
  s.flush = null;
  if (s.sending) return;
  const batch = coalesce(s.queue.splice(0));
  s.sending = true;
  try { for (const event of batch) await raw(`/api/browser-live/${encodeURIComponent(s.botId)}/input`, 'POST', event); }
  catch (error) {
    s.queue.length = 0;
    toast(error?.message || 'That did not reach the page.', true);
    // The hold was dropped (the device restarted, or a long pause): look again at once.
    if (error?.status === 409 && alive(s)) { clearTimeout(s.timer); tick(s); }
  } finally { s.sending = false; if (s.queue.length && alive(s)) s.flush = setTimeout(() => flush(s), 30); }
}

const rectOf = s => s.img.getBoundingClientRect();
const sizeOf = s => ({w: s.view.w, h: s.view.h});

function tap(s, ev) {
  const box = s.stage.getBoundingClientRect(), ring = document.createElement('span');
  ring.className = 'pc-tap'; ring.style.left = `${ev.clientX - box.left}px`; ring.style.top = `${ev.clientY - box.top}px`;
  s.stage.append(ring);
  setTimeout(() => ring.remove(), 600);
}

function wireStage(s) {
  s.stage.addEventListener('click', ev => {
    if (stateOf(s) !== 'driving') {
      // Clicking a picture that does not answer is a question: say what to press, but not on every click.
      if (s.view.image && Date.now() - s.lastHint > 4000 && canDrive()) { s.lastHint = Date.now(); toast('Press Take over to click and type in this page.'); }
      return;
    }
    s.stage.focus({preventScroll: true});
    if (s.img.hidden) return;
    const event = clickInput(rectOf(s), {x: ev.clientX, y: ev.clientY}, sizeOf(s));
    if (event) { tap(s, ev); push(s, event); }
  });
  s.stage.addEventListener('wheel', ev => {
    if (stateOf(s) !== 'driving' || s.img.hidden) return;
    ev.preventDefault();
    push(s, wheelInput(ev, rectOf(s), {x: ev.clientX, y: ev.clientY}, sizeOf(s)));
  }, {passive: false});
  s.stage.addEventListener('keydown', ev => {
    if (stateOf(s) !== 'driving' || ev.target !== s.stage) return;
    // Tab is how a keyboard leaves the picture; the Tab button sends it to the page.
    const event = ev.key === 'Tab' ? null : keyInput({key: ev.key, ctrlKey: ev.ctrlKey, metaKey: ev.metaKey, altKey: ev.altKey, altGraph: ev.getModifierState?.('AltGraph') === true});
    if (!event) return;
    ev.preventDefault(); ev.stopPropagation();
    push(s, event);
  });
}

/* ---------- what the buttons do ---------- */

const botName = id => findBot(id)?.name || 'The bot';
async function hold(botId, action) {
  const reply = await api(`/api/browser-live/${encodeURIComponent(botId)}/${action}`, 'POST', {});
  const state = reply?.state || (action === 'takeover' ? 'driving' : 'idle');
  if (session?.botId === botId) session.view = {...session.view, state};
  patchLive(botId, {state});
  return state;
}

export const computerActions = {
  'open-computer': b => go({profile: b.dataset.id, sub: 'computer'}),
  'computer-takeover': async b => {
    await hold(b.dataset.id, 'takeover');
    // Keys go to the page from here: put focus where they are caught.
    if (session?.botId === b.dataset.id) session.stage.focus({preventScroll: true});
    toast(`You are driving ${botName(b.dataset.id)}'s browser.`);
  },
  'computer-handback': async b => {
    await hold(b.dataset.id, 'handback');
    toast(`${botName(b.dataset.id)} has the browser back.`);
  },
  'computer-key': b => { if (session?.botId === b.dataset.id) push(session, {type: 'key', key: b.dataset.text}); },
};

export const computerForms = {
  'computer-go': async form => {
    const url = navigateAddress(form.elements.url.value);
    if (!url) throw new Error('Type a web address, like example.com.');
    await raw(`/api/browser-live/${encodeURIComponent(form.dataset.bot)}/input`, 'POST', {type: 'navigate', url});
    form.elements.url.value = url;
    session?.stage.focus({preventScroll: true});
  },
  'computer-type': (form, f) => {
    const text = String(f.text ?? '');
    if (!text || session?.botId !== form.dataset.bot) return;
    push(session, {type: 'type', text});
    form.reset();
  },
};

/** Called once from app.js: the list poll follows what is on screen, and both polls pause with the tab. */
export function wireComputer() {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    kickList();
    if (session && alive(session) && !session.timer && !session.denied && !session.view.demo) tick(session);
  });
  onChange(() => kickList());
}
