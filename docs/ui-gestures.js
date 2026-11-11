/** Pin and reorder: the whole bot is the handle.
 *
 * On a laptop, press a bot and move to drag it (a long press works too), and
 * right-click for its options menu. On a phone, touch and hold: it lifts with a
 * short buzz, move to drag, or let go without moving to open the options sheet.
 * From the keyboard, the menu key or Shift+F10 opens the menu and Alt+arrows move
 * the focused bot. This is the Chats home only, on the phone's Bots page and in
 * the desktop sidebar: both draw the same rows (`.crow`) and pinned faces (`.pin`).
 *
 * What a drop means is decided by ui-reorder.js (pure, tested); this file reads
 * the page, moves a copy of the bot under the pointer and writes the result.
 * The copy (the "ghost") is fixed to the screen so a scrolling list cannot clip
 * it, and the real row stays in the list as the empty slot. Only transform and
 * opacity animate: the ghost lifts, grows 3%, leans with sideways speed and
 * springs into its slot; neighbours glide out of the way (FLIP); the list scrolls
 * itself near its edges. Reduced motion keeps the drag and drops every flourish.
 *
 * Pins and order are per person, saved through saveLocal (try/catch inside). */
import {primaryOf} from './company.js?v=ded1274e22';
import {store, changed, onChange, loadLocal, saveLocal, findBot, canWrite} from './ui-store.js?v=ded1274e22';
import {PINS_KEY, ORDER_KEY} from './ui-shell.js?v=ded1274e22';
import {openBotMenu, closeBotMenu, botMenuOpen, moveBot} from './ui-profile.js?v=ded1274e22';
import {pinned, withPin, withoutPin, pinSlot, slotAmong, mergeOrder, unitOf, stepUnit, stepPin, hitZone} from './ui-reorder.js?v=ded1274e22';

const ITEM = '.crow[data-action="open-bot"], .pin[data-action="open-bot"]';
const SURFACE = '#sidebar .rail-list, #main .hv[data-section="bots"]';
const HOLD = 420, SLOP = 6, EDGE = 56, TILT = 7;
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const live = text => { const node = document.getElementById('announce'); if (node) node.textContent = text; };
const items = surface => [...surface.querySelectorAll(ITEM)].filter(n => !n.classList.contains('gest-ghost'));
const rowsOf = surface => items(surface).filter(n => n.classList.contains('crow'));
const pinsOf = surface => items(surface).filter(n => n.classList.contains('pin'));
const idOf = node => node?.dataset.id;
const savedPins = () => {
  const primary = primaryOf(store.state);
  return pinned(loadLocal(PINS_KEY, null), primary ? [primary.id] : []);
};

/* ---------- gliding: first, last, invert, play ---------- */

const visual = nodes => new Map(nodes.map(n => [n, n.getBoundingClientRect()]));
/** Slide each node from where it was drawn to where it is now (transform only). A glide
 * already in flight is cancelled first, so the new one starts from where the node is. */
function glide(before, ms = 220) {
  if (calm()) return;
  for (const [node, was] of before) {
    if (!node.isConnected) continue;
    node.getAnimations().filter(a => a.id === 'glide').forEach(a => a.cancel());
    const now = node.getBoundingClientRect(), dx = was.left - now.left, dy = was.top - now.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    node.animate([{transform: `translate(${dx}px,${dy}px)`}, {transform: 'none'}], {duration: ms, easing: 'cubic-bezier(.2,.8,.2,1)'}).id = 'glide';
  }
}
/** The row's box ignoring any glide it is in the middle of, so a decision never
 * chases its own animation. */
function layoutRect(node) {
  const r = node.getBoundingClientRect(), m = getComputedStyle(node).transform;
  const t = !m || m === 'none' ? {e: 0, f: 0} : new DOMMatrix(m);
  return {left: r.left - t.e, top: r.top - t.f, right: r.right - t.e, bottom: r.bottom - t.f};
}
/** Where every bot is drawn right now, by id: take it before a change that repaints the list. */
const snapshot = surface => new Map(items(surface).filter(n => !n.classList.contains('gest-away')).map(n => [idOf(n), n.getBoundingClientRect()]));
/** After the repaint, glide each bot from its old place to its new one. */
function glideFrom(surface, was) {
  const before = new Map();
  for (const node of items(surface)) if (was.has(idOf(node))) before.set(node, was.get(idOf(node)));
  glide(before, 260);
}

/* ---------- saving ---------- */

const savePins = pins => { saveLocal(PINS_KEY, pins); };
const saveOrder = ids => { saveLocal(ORDER_KEY, mergeOrder(loadLocal(ORDER_KEY, []), ids)); };
const nameOf = id => findBot(id)?.name || 'The bot';

/* ---------- the drag ---------- */

let press = null, drag = null, swallow = false;
export const gesturesBusy = () => Boolean(press?.armed || drag);

const stopScroll = ev => { if (ev.cancelable) ev.preventDefault(); };
function endPress() {
  if (!press) return;
  clearTimeout(press.timer); press.item.classList.remove('gest-armed');
  document.removeEventListener('touchmove', stopScroll);
  press = null;
}

function arm() {
  if (!press) return;
  press.armed = true;
  press.item.classList.add('gest-armed');
  if (press.touch) { navigator.vibrate?.(12); document.addEventListener('touchmove', stopScroll, {passive: false}); }
  else startDrag(press.x, press.y);
}

function startDrag(x, y) {
  const {item} = press, surface = item.closest(SURFACE); if (!surface) return endPress();
  closeBotMenu({restore: false});
  const from = item.classList.contains('pin') ? 'shelf' : 'list';
  const meta = rowsOf(surface).map(n => ({id: idOf(n), team: n.dataset.team || null, node: n}));
  const unit = from === 'list' ? unitOf(meta, idOf(item)) : [idOf(item)];
  const box = item.getBoundingClientRect(), ghost = item.cloneNode(true), was = snapshot(surface);
  ghost.classList.remove('on', 'gest-armed'); ghost.classList.add('gest-ghost');
  for (const attr of ['data-action', 'aria-current']) ghost.removeAttribute(attr);
  ghost.setAttribute('aria-hidden', 'true'); ghost.tabIndex = -1;
  Object.assign(ghost.style, {left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px`});
  item.parentElement.append(ghost);
  item.classList.remove('gest-armed'); item.classList.add('gest-hole');
  meta.filter(r => unit.includes(r.id) && r.node !== item).forEach(r => r.node.classList.add('gest-away'));
  // No pins yet: a "Drop to pin" area shows for as long as something is being dragged.
  const zoneEl = surface.querySelector('.shelf') ? null : document.createElement('div');
  if (zoneEl) {
    zoneEl.className = 'shelf pin-zone'; zoneEl.innerHTML = '<span>Drop to pin</span>';
    (surface.querySelector('.crows') || surface).before(zoneEl);
  }
  glideFrom(surface, was);
  try { item.setPointerCapture(press.pointerId); } catch { /* the pointer may already be gone */ }
  document.body.dataset.dragging = '1';
  drag = {item, ghost, surface, from, id: idOf(item), team: item.dataset.team || null, unit, zoneEl, ox: x, oy: y, x, y, px: NaN, py: NaN, vx: 0, scale: 1, zone: {kind: 'none'}, slot: null, scrollTop: -1, raf: 0};
  clearTimeout(press.timer); press = null;      // the touch scroll lock stays until the drop
  requestAnimationFrame(() => ghost.classList.add('lift'));
  drag.raf = requestAnimationFrame(frame);
}

const shelfOf = d => d.zoneEl || d.surface.querySelector('.shelf');
function rectOf(node, pad = 0) { const r = node.getBoundingClientRect(); return {left: r.left - pad, top: r.top - pad, right: r.right + pad, bottom: r.bottom + pad}; }

function autoscroll(d) {
  const r = d.surface.getBoundingClientRect(), up = d.y - (r.top + EDGE), down = d.y - (r.bottom - EDGE);
  if (up < 0) d.surface.scrollTop -= Math.min(16, Math.round(-up / 4) + 2);
  else if (down > 0) d.surface.scrollTop += Math.min(16, Math.round(down / 4) + 2);
}

/** Where the pointer is, and what the list should look like for it. */
function steer(d) {
  const shelf = shelfOf(d), sr = d.surface.getBoundingClientRect(), shelfBox = shelf ? rectOf(shelf, 8) : null;
  const list = {left: sr.left, right: sr.right, top: shelfBox ? shelfBox.bottom : sr.top, bottom: sr.bottom};
  const rows = rowsOf(d.surface).filter(n => !d.unit.includes(idOf(n))).map(n => ({id: idOf(n), team: n.dataset.team || null, manager: n.dataset.manager === 'true' && canWrite(), ...layoutRect(n)}));
  const zone = hitZone({shelf: shelfBox, list, rows, from: d.from, id: d.id, team: d.team, inside: d.unit, x: d.x, y: d.y});
  const mark = (node, on) => node?.classList.toggle('drop-on', on);
  mark(shelf, zone.kind === 'pin' || zone.kind === 'pins');
  rowsOf(d.surface).forEach(n => mark(n, zone.kind === 'team' && idOf(n) === zone.team));
  d.item.classList.toggle('gest-out', zone.kind === 'unpin');
  if (zone.kind === 'pin') d.slot = pinSlot(pinBoxes(d), d);
  else if (zone.kind === 'pins') reorderPins(d);
  else if (zone.kind === 'rows') reorderRows(d);
  d.zone = zone;
}
const pinBoxes = d => pinsOf(d.surface).filter(n => n !== d.item).map(n => ({id: idOf(n), ...layoutRect(n)}));

/** The pinned faces: the empty slot moves to where the pointer is among the others. */
function reorderPins(d) {
  const peers = pinsOf(d.surface).filter(n => n !== d.item), slot = pinSlot(pinBoxes(d), d), shelf = d.item.parentElement;
  const nowSlot = peers.filter(n => n.compareDocumentPosition(d.item) & Node.DOCUMENT_POSITION_FOLLOWING).length;
  if (slot === nowSlot) return;
  const was = snapshot(d.surface);
  shelf.insertBefore(d.item, slot < peers.length ? peers[slot] : peers[peers.length - 1].nextSibling);
  glideFrom(d.surface, was);
}

/** The rows: among the bots on the same team, the slot is the number of blocks (a bot and its reports)
 * whose middle is above the pointer. A block only moves among its own team. */
function reorderRows(d) {
  const meta = rowsOf(d.surface).map(n => ({id: idOf(n), team: n.dataset.team || null, node: n}));
  const peers = meta.filter(r => r.team === d.team && !d.unit.includes(r.id));
  if (!peers.length) return;
  const blocks = peers.map(p => {
    const ids = unitOf(meta, p.id), boxes = meta.filter(r => ids.includes(r.id)).map(r => layoutRect(r.node));
    return {last: meta.find(r => r.id === ids[ids.length - 1]).node, top: Math.min(...boxes.map(r => r.top)), bottom: Math.max(...boxes.map(r => r.bottom))};
  });
  const slot = slotAmong(blocks, d.y), nowSlot = peers.filter(p => p.node.compareDocumentPosition(d.item) & Node.DOCUMENT_POSITION_FOLLOWING).length;
  if (slot === nowSlot) return;
  const was = snapshot(d.surface), parent = d.item.parentElement;
  const anchor = slot < peers.length ? peers[slot].node : blocks[blocks.length - 1].last.nextSibling;
  meta.filter(r => d.unit.includes(r.id)).forEach(r => parent.insertBefore(r.node, anchor));
  glideFrom(d.surface, was);
}

function frame() {
  const d = drag; if (!d) return;
  autoscroll(d);
  if (d.x !== d.px || d.y !== d.py || d.surface.scrollTop !== d.scrollTop) { steer(d); d.scrollTop = d.surface.scrollTop; }
  // Lean with sideways speed; ease so it sways rather than snaps.
  const lean = calm() ? 0 : Math.max(-TILT, Math.min(TILT, (d.x - d.px || 0) * 0.9));
  d.vx += (lean - d.vx) * 0.18;
  d.scale += ((calm() ? 1 : 1.03) - d.scale) * 0.3;
  d.px = d.x; d.py = d.y;
  d.ghost.style.transform = `translate3d(${d.x - d.ox}px,${d.y - d.oy}px,0) scale(${d.scale}) rotate(${d.vx}deg)`;
  d.raf = requestAnimationFrame(frame);
}

function cleanup(d) {
  cancelAnimationFrame(d.raf);
  d.surface.querySelectorAll('.drop-on').forEach(n => n.classList.remove('drop-on'));
  d.surface.querySelectorAll('.gest-away').forEach(n => n.classList.remove('gest-away'));
  d.item.classList.remove('gest-hole', 'gest-out');
  d.zoneEl?.remove();
}

/** Fly the ghost into `node` with a slight overshoot, then drop it. */
function land(ghost, node) {
  const finish = () => { ghost.remove(); node?.classList.remove('gest-wait'); };
  if (!node || calm()) return finish();
  const now = getComputedStyle(ghost).transform, to = node.getBoundingClientRect();
  const dx = to.left - parseFloat(ghost.style.left), dy = to.top - parseFloat(ghost.style.top);
  ghost.classList.remove('lift');
  ghost.animate([{transform: now}, {transform: `translate3d(${dx}px,${dy}px,0)`}], {duration: 360, easing: 'cubic-bezier(.34,1.45,.64,1)', fill: 'forwards'}).onfinish = finish;
}

async function drop(cancel = false) {
  const d = drag; if (!d) return;
  drag = null; swallow = true;
  setTimeout(() => { swallow = false; delete document.body.dataset.dragging; }, 60);
  document.removeEventListener('touchmove', stopScroll);
  const {surface, ghost, id, zone} = d, kind = cancel ? 'none' : zone.kind, was = snapshot(surface);
  let team = null;
  if (kind === 'pin') savePins(withPin(savedPins(), id, d.slot ?? savedPins().length));
  else if (kind === 'unpin') savePins(withoutPin(savedPins(), id));
  else if (kind === 'pins') savePins(mergeOrder(savedPins(), pinsOf(surface).map(idOf)));
  else if (kind === 'rows') saveOrder(rowsOf(surface).map(idOf));
  else if (kind === 'team') team = zone.team;
  cleanup(d);
  // Repaint from what was saved, then bring the ghost to the bot's place. A team move lands back
  // where it was and then moves when the server has it.
  changed();
  const home = items(surface).find(n => idOf(n) === id) || null;
  glideFrom(surface, was);
  if (home) { home.classList.add('gest-wait'); home.parentElement.append(ghost); }
  land(ghost, home);
  if (kind === 'pin') live(`${nameOf(id)} pinned`);
  else if (kind === 'unpin') live(`${nameOf(id)} unpinned`);
  if (!team) return;
  const moved = snapshot(surface);
  try { await moveBot(id, team); glideFrom(surface, moved); }
  catch (error) { live(error?.message || 'That did not move.'); }
}

/* ---------- pointer wiring ---------- */

function onMove(ev) {
  if (ev.pointerId !== press?.pointerId && !drag) return;
  if (drag) { drag.x = ev.clientX; drag.y = ev.clientY; return; }
  const far = Math.hypot(ev.clientX - press.x, ev.clientY - press.y) > (press.touch && !press.armed ? 9 : SLOP);
  if (!far) return;
  if (press.touch && !press.armed) return endPress();   // a swipe is scrolling the page, not a press
  press.moved = true;
  startDrag(press.x, press.y);
  drag.x = ev.clientX; drag.y = ev.clientY;
}
function onUp(ev) {
  document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', onUp); document.removeEventListener('pointercancel', onUp);
  if (drag) return drop(ev.type === 'pointercancel');
  const p = press, wasTouchHold = p?.armed && p.touch && !p.moved;
  endPress();
  if (wasTouchHold && ev.type === 'pointerup') { swallow = true; setTimeout(() => { swallow = false; }, 60); openBotMenu(idOf(p.item), {opener: p.item, touch: true}); }
}

function onDown(ev) {
  // While the search box filters the list, what is on screen is not the whole order.
  if (press || drag || ev.button > 0 || !store.state || store.listQuery.trim()) return;
  const item = ev.target.closest?.(ITEM);
  if (!item || !item.closest(SURFACE)) return;
  press = {item, x: ev.clientX, y: ev.clientY, pointerId: ev.pointerId, touch: ev.pointerType === 'touch' || ev.pointerType === 'pen', armed: false, moved: false, timer: setTimeout(arm, HOLD)};
  document.addEventListener('pointermove', onMove); document.addEventListener('pointerup', onUp); document.addEventListener('pointercancel', onUp);
}

/* ---------- keyboard ---------- */

/** Alt+arrows: left and right move a pinned face; up and down move a row among its team, and past the
 * top of the list pins it (down on a pinned face unpins it). The page glides the same way a drag does. */
function nudge(item, key) {
  const surface = item.closest(SURFACE), id = idOf(item), dir = key === 'ArrowUp' || key === 'ArrowLeft' ? -1 : 1;
  if (item.classList.contains('pin')) {
    const pins = savedPins();
    if (key === 'ArrowDown') { savePins(withoutPin(pins, id)); return {text: `${nameOf(id)} unpinned`}; }
    const next = key === 'ArrowUp' ? null : stepPin(pins, id, dir);
    if (!next) return null;
    savePins(next); return {text: `${nameOf(id)} moved ${dir < 0 ? 'left' : 'right'}, ${next.indexOf(id) + 1} of ${next.length}`};
  }
  if (key === 'ArrowLeft' || key === 'ArrowRight') return null;
  const rows = rowsOf(surface).map(n => ({id: idOf(n), team: n.dataset.team || null})), next = stepUnit(rows, id, dir);
  if (!next) {
    if (key !== 'ArrowUp' || rows[0]?.id !== id) return null;
    const pins = savedPins(); savePins(withPin(pins, id, pins.length));
    return {text: `${nameOf(id)} pinned`};
  }
  saveOrder(next);
  return {text: `${nameOf(id)} moved ${dir < 0 ? 'up' : 'down'}, ${next.indexOf(id) + 1} of ${next.length}`};
}

function onKey(ev) {
  if (drag && ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); return drop(true); }
  const item = ev.target.closest?.(ITEM); if (!item || !item.closest(SURFACE)) return;
  if (ev.key === 'ContextMenu' || (ev.shiftKey && ev.key === 'F10')) {
    ev.preventDefault();
    return botMenuOpen() ? closeBotMenu() : openBotMenu(idOf(item), {opener: item});
  }
  if (!ev.altKey || ev.ctrlKey || ev.metaKey || !/^Arrow(Up|Down|Left|Right)$/.test(ev.key)) return;
  ev.preventDefault();   // Alt+Left is the browser's Back
  const surface = item.closest(SURFACE), done = nudge(item, ev.key);
  if (!done) return;
  const was = snapshot(surface);
  changed(); glideFrom(surface, was);
  live(done.text);
}

/** Document-level wiring. Called once from app.js. */
export function wireGestures() {
  document.addEventListener('pointerdown', onDown);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('contextmenu', ev => {
    const item = ev.target.closest?.(ITEM); if (!item || !item.closest(SURFACE)) return;
    ev.preventDefault();
    // A long press on a touch screen is handled above; only a real right-click opens the menu here.
    if (press?.touch || drag || ev.pointerType === 'touch') return;
    openBotMenu(idOf(item), {opener: item, x: ev.clientX, y: ev.clientY, touch: false});
  });
  // The click that ends a drag or a long press must not also open the chat.
  document.addEventListener('click', ev => { if (swallow) { ev.preventDefault(); ev.stopPropagation(); } }, true);
  window.addEventListener('blur', () => { if (drag) drop(true); });
  onChange(scope => { if (scope === 'route' && drag) { cleanup(drag); drag.ghost.remove(); drag = null; delete document.body.dataset.dragging; } });
}
