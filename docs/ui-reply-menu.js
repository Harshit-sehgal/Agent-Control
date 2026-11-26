/** The reply popover: hold a bot reply for 👍 / 👎, "Ask about this…" and its actions.
 *
 * A touch and hold (420 ms, cancelled by 9 px of movement, so a scroll never opens it), a right-click, or the menu
 * key / Shift+F10 on a focused reply opens a popover anchored at that reply: below it when it fits above the composer,
 * else above, inside a 12 px margin (`placePopover`). What it offers and the text it sends are decided by the pure
 * shared/reply-menu.js. Links keep the browser's own long press and right-click.
 *
 * It closes on Escape, a press outside, a real scroll of the chat (not the one a phone keyboard causes when the ask
 * box gets focus), a route change, and after an action; focus goes back to the reply. On open the first button has
 * focus, never the ask box, so a phone keyboard does not jump up uninvited. */
import {esc, icon} from './ui-kit.js?v=01cd03d88d';
import {menuItems, showFeedback, quoteText, askText, threadText, askedBefore, togglePin, isPinned, placePopover, PINS_MSG_KEY, HINT_KEY} from './reply-menu.js?v=01cd03d88d';
import {store, conversation, findBot, canWrite, api, sync, loadLocal, saveLocal, changed, onChange} from './ui-store.js?v=01cd03d88d';
import {sendChat, startThread, rerun} from './ui-chat.js?v=01cd03d88d';
import {retryTarget} from './ui-model.js?v=01cd03d88d';
import {botSettings} from './bot-settings.js?v=01cd03d88d';
import {toast} from './ui-dialogs.js?v=01cd03d88d';

const REPLY = '#cv-log .cv-bot';
const HOLD = 420, SLOP = 9, SCROLL_CLOSE = 24, SETTLE_MS = 600;
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const touchScreen = () => matchMedia('(hover: none)').matches;

let press = null, open = null, swallow = false, settledAt = 0;

/** The reply's words as the owner sees them, or the part of them they selected before opening. */
function wordsOf(reply) {
  const sel = getSelection?.();
  const inside = sel && !sel.isCollapsed && reply.contains(sel.anchorNode) && reply.contains(sel.focusNode);
  const all = reply.querySelector('.md')?.innerText?.trim() || '';
  const part = inside ? sel.toString().trim() : '';
  return {text: part || all, selected: Boolean(part)};
}

/** Everything one popover needs to know about the reply it was opened on. */
function contextOf(reply) {
  const conv = conversation(), id = reply.dataset.m;
  if (!conv || !id) return null;
  const messages = store.messages?.[conv.id] || store.state?.chats?.[conv.id] || [];
  const message = messages.find(m => m.id === id) || {id};
  const bot = conv.isTeam ? findBot(message.senderId) : conv.bot;
  const asked = askedBefore(messages, id);
  const run = conv.isTeam && message.runId ? (store.state?.groupRuns || []).find(r => r.id === message.runId) : null;
  return {conv, id, message, bot, asked, run, ...wordsOf(reply)};
}

function markup(ctx, touch) {
  const write = canWrite(), memoryOn = ctx.bot ? botSettings(ctx.bot).memory !== false : false;
  const items = menuItems({canWrite: write, touch, canRetry: Boolean(ctx.conv.isTeam ? ctx.run?.input : ctx.asked), canTemplate: Boolean(ctx.asked), pinned: isPinned(loadLocal(PINS_MSG_KEY, {}), ctx.conv.id, ctx.id)});
  const feedback = showFeedback({canWrite: write, memoryOn}) && ctx.bot ? `<div class="rm-fb">
      <button type="button" class="rm-thumb" data-rm="up" aria-label="Good reply">${icon('up', 18)}</button>
      <button type="button" class="rm-thumb" data-rm="down" aria-label="Not right">${icon('down', 18)}</button>
      <span class="rm-thanks" role="status"></span>
    </div>
    <form class="rm-why" hidden><input class="input" name="why" maxlength="600" placeholder="What was wrong?" aria-label="What was wrong?" autocomplete="off"><button type="submit" class="btn primary small">Send</button></form>` : '';
  const ask = write ? `<form class="rm-ask"><input class="input" name="ask" maxlength="3000" placeholder="Ask about this…" aria-label="Ask about this reply" autocomplete="off"><button type="submit" class="rm-send" aria-label="Send">${icon('send', 18)}</button></form>` : '';
  const rows = items.map(item => `<button type="button" role="menuitem" class="rm-row" data-rm="${esc(item.id)}">${icon(item.glyph, 18)}<span>${esc(item.label)}</span></button>`).join('');
  return `${ctx.selected ? '<p class="rm-about">About the selected part</p>' : ''}${feedback}${ask}<div class="rm-list" role="group">${rows}</div>`;
}

/** Open the popover on one reply. `point` is where a right-click happened. */
export function openReplyMenu(reply, {point = null, touch = touchScreen()} = {}) {
  closeReplyMenu({restore: false});
  const ctx = contextOf(reply);
  if (!ctx) return;
  const node = document.createElement('div');
  node.className = 'rmenu'; node.setAttribute('role', 'menu'); node.setAttribute('aria-label', `Options for ${ctx.bot?.name || 'this'} reply`);
  node.innerHTML = markup(ctx, touch);
  document.body.append(node);
  reply.classList.add('cv-held');
  open = {node, reply, ctx, point};
  place();
  node.addEventListener('click', onMenuClick);
  node.addEventListener('submit', onMenuSubmit);
  node.addEventListener('focusin', () => { settledAt = Date.now(); });
  node.querySelector('button')?.focus({preventScroll: true});
  settledAt = Date.now();
  // The tip has done its job once the person has opened a popover.
  if (!loadLocal(HINT_KEY, false)) { saveLocal(HINT_KEY, true); changed('thread'); }
}

function place() {
  if (!open) return;
  const {node, reply, point} = open;
  const bubble = (reply.querySelector('.cv-body') || reply).getBoundingClientRect();
  const view = {w: window.visualViewport?.width || innerWidth, h: window.visualViewport?.height || innerHeight};
  const composer = document.getElementById('chat-form')?.getBoundingClientRect().top ?? view.h;
  const at = placePopover({top: bubble.top, bottom: bubble.bottom, left: bubble.left, right: bubble.right}, {w: node.offsetWidth, h: node.offsetHeight}, view, composer, point);
  node.style.left = `${at.left}px`; node.style.top = `${at.top}px`;
  node.dataset.side = at.below ? 'below' : 'above';
}

export function closeReplyMenu({restore = true} = {}) {
  if (!open) return;
  const {node, reply} = open;
  open = null;
  node.remove();
  reply.classList.remove('cv-held');
  if (restore && document.contains(reply)) reply.focus({preventScroll: true});
}

export const replyMenuOpen = () => Boolean(open);

/* ---------- actions ---------- */

async function copy(text, done = 'Copied.') {
  try { await navigator.clipboard.writeText(text); toast(done); }
  catch { toast('This browser did not allow copying. Select the words and copy them instead.', true); }
}

const thanks = node => { const said = node.querySelector('.rm-thanks'); if (said) said.textContent = 'Thanks, noted'; };

async function feedback(kind, note = '') {
  const {ctx, node} = open;
  await api('/api/memory/feedback', 'POST', {bot: ctx.bot.id, chat: ctx.conv.id, message: ctx.id, kind, ...(note ? {note} : {})});
  node.querySelectorAll('.rm-thumb').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.rm === kind)));
  thanks(node);
}

const ACTIONS = {
  copy: ctx => copy(ctx.text),
  retry: ctx => ctx.conv.isTeam
    ? rerun(ctx.run.groupId, {message: ctx.run.input, ...retryTarget(ctx.conv.group, ctx.run)})
    : sendChat(ctx.conv.id, ctx.asked),
  share: async ctx => {
    if (navigator.share) {
      try { await navigator.share({text: ctx.text}); }
      catch (error) { if (error?.name !== 'AbortError') await copy(ctx.text, 'Copied. Paste it where you want to share it.'); }
      return;
    }
    await copy(ctx.text, 'Copied. Paste it where you want to share it.');
  },
  pin: ctx => {
    const pins = togglePin(loadLocal(PINS_MSG_KEY, {}), ctx.conv.id, ctx.id);
    if (!saveLocal(PINS_MSG_KEY, pins)) return toast('This browser did not keep the pin.', true);
    toast(isPinned(pins, ctx.conv.id, ctx.id) ? 'Pinned. It shows at the top of this chat.' : 'Unpinned.');
    changed('thread');
  },
  thread: ctx => startThread(threadText(quoteText(ctx.text), document.querySelector('.rmenu [name=ask]')?.value || '')),
  template: async ctx => {
    await api('/api/templates', 'POST', {text: ctx.asked});
    await sync();
    toast('Saved. It shows in the composer\'s Templates.');
  },
  select: ctx => {
    const reply = document.querySelector(`${REPLY}[data-m="${CSS.escape(ctx.id)}"]`);
    if (!reply) return;
    reply.classList.add('cv-select');
    const done = ev => { if (!reply.contains(ev.target)) { reply.classList.remove('cv-select'); document.removeEventListener('pointerdown', done, true); } };
    document.addEventListener('pointerdown', done, true);
  },
};

async function onMenuClick(ev) {
  const button = ev.target.closest('[data-rm]');
  if (!button || !open) return;
  ev.preventDefault();
  const {ctx, node} = open, what = button.dataset.rm;
  try {
    if (what === 'up') return await feedback('up');
    if (what === 'down') {
      const why = node.querySelector('.rm-why');
      why.hidden = false; why.querySelector('input').focus();
      return;
    }
    const run = ACTIONS[what];
    if (!run) return;
    // Select text hands the reply back for selecting, so focus stays off it.
    closeReplyMenu({restore: what !== 'select'});
    await run(ctx);
  } catch (error) { toast(error?.message || 'That did not work.', true); }
}

async function onMenuSubmit(ev) {
  ev.preventDefault();
  if (!open) return;
  const form = ev.target, {ctx} = open;
  try {
    if (form.classList.contains('rm-why')) {
      const note = form.elements.why.value.trim();
      await feedback('down', note);
      form.hidden = true;
      return;
    }
    if (form.classList.contains('rm-ask')) {
      const words = form.elements.ask.value.trim();
      if (!words) { form.elements.ask.focus(); return; }
      closeReplyMenu();
      await sendChat(ctx.conv.id, askText(quoteText(ctx.text), words));
    }
  } catch (error) { toast(error?.message || 'That did not work.', true); }
}

/* ---------- opening it ---------- */

const replyAt = target => {
  const reply = target?.closest?.(REPLY);
  // A link keeps the browser's own long press and right-click (open in a new tab, copy link).
  if (!reply || target.closest('a, button, input, textarea, select, summary')) return null;
  return reply;
};

function endPress() { if (press) clearTimeout(press.timer); press = null; document.removeEventListener('pointermove', onMove); }
function onMove(ev) {
  if (!press || ev.pointerId !== press.pointerId) return;
  if (Math.hypot(ev.clientX - press.x, ev.clientY - press.y) > SLOP) endPress();   // a scroll, not a hold
}
function onDown(ev) {
  if (open && !open.node.contains(ev.target)) closeReplyMenu({restore: false});
  if (ev.pointerType === 'mouse' || ev.button > 0) return;
  const reply = replyAt(ev.target);
  if (!reply || reply.classList.contains('cv-select')) return;
  endPress();
  press = {reply, x: ev.clientX, y: ev.clientY, pointerId: ev.pointerId, timer: setTimeout(() => {
    const {reply: held} = press || {};
    endPress();
    if (!held) return;
    swallow = true; setTimeout(() => { swallow = false; }, 700);
    navigator.vibrate?.(8);
    openReplyMenu(held, {touch: true});
  }, HOLD)};
  document.addEventListener('pointermove', onMove);
}

function onContext(ev) {
  const reply = replyAt(ev.target);
  if (!reply || reply.classList.contains('cv-select')) return;
  ev.preventDefault();
  // A touch hold opens from its own timer; the context menu a long press also fires is only kept from showing.
  if (ev.pointerType === 'touch' || open?.reply === reply || press) return;
  openReplyMenu(reply, {point: {x: ev.clientX, y: ev.clientY}, touch: false});
}

function onKey(ev) {
  if (open && ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); return closeReplyMenu(); }
  if (open && ev.key === 'Tab' && open.node.contains(ev.target)) {
    // Tab stays inside the popover while it is open.
    const stops = [...open.node.querySelectorAll('button, input')].filter(n => !n.closest('[hidden]') && !n.disabled);
    const first = stops[0], last = stops.at(-1);
    if (ev.shiftKey && ev.target === first) { ev.preventDefault(); last?.focus(); }
    else if (!ev.shiftKey && ev.target === last) { ev.preventDefault(); first?.focus(); }
    return;
  }
  const reply = ev.target?.matches?.(REPLY) ? ev.target : null;
  if (reply && (ev.key === 'ContextMenu' || (ev.shiftKey && ev.key === 'F10'))) { ev.preventDefault(); openReplyMenu(reply, {touch: false}); }
}

/** A real scroll of the chat closes it; the jump a phone keyboard causes right after focus does not. */
function onScroll(ev) {
  if (!open || !ev.target?.id || ev.target.id !== 'cv-scroll') return;
  const top = ev.target.scrollTop;
  open.scrollFrom ??= top;
  if (Date.now() - settledAt < SETTLE_MS) { open.scrollFrom = top; return; }
  if (Math.abs(top - open.scrollFrom) > SCROLL_CLOSE) closeReplyMenu({restore: false});
}

/** Document-level wiring. Called once from app.js. */
export function wireReplyMenu() {
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('pointerup', endPress, true);
  document.addEventListener('pointercancel', endPress, true);
  document.addEventListener('contextmenu', onContext);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('scroll', onScroll, true);
  // The click that ends a hold must not also act on the reply (a link, a card button).
  document.addEventListener('click', ev => { if (swallow && ev.target?.closest?.(REPLY)) { ev.preventDefault(); ev.stopPropagation(); } }, true);
  window.visualViewport?.addEventListener('resize', () => { settledAt = Date.now(); place(); });
  window.addEventListener('resize', () => { settledAt = Date.now(); place(); });
  // A live chat repaints while the popover is open: it follows its reply into the new paint, and closes only when
  // the chat changed or the reply is gone.
  onChange(scope => {
    if (!open) return;
    if (scope === 'route') return closeReplyMenu({restore: false});
    queueMicrotask(() => {
      if (!open || document.contains(open.reply)) return;
      const again = document.querySelector(`${REPLY}[data-m="${CSS.escape(open.ctx.id)}"]`);
      if (!again) return closeReplyMenu({restore: false});
      open.reply = again; again.classList.add('cv-held'); place();
    });
  });
}
