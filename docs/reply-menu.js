/** The reply popover's rules (pure: no DOM, no globals, so Node tests import it).
 *
 * Holding a bot reply opens a popover at it (shared/ui-reply-menu.js): 👍 / 👎, an "Ask about this…" box, then
 * Copy, Try again, Share, Pin, Start a thread, Save as template and, on a touch screen, Select text. This module says
 * which of those a person gets, what text a quote, an ask and a new thread send, which question a reply answered,
 * how message pins are kept (per person, `ac-msg-pins`), where the popover sits, and which reply carries the
 * one-time hint. The pins strip and the hint are drawn here too, so the chat view needs no import of the popover. */
import {esc, plain, icon, stamp} from './ui-kit.js?v=0311e05212';

export const MAX_MSG_PINS = 20;
/** Per-person keys (saveLocal, never sent): pinned replies per chat, and whether the hold tip was seen. */
export const PINS_MSG_KEY = 'ac-msg-pins';
export const HINT_KEY = 'ac-hold-hint';
/** Room kept between the popover and the viewport's edges (and the composer). */
export const MARGIN = 12;
const GAP = 8, MAX_QUOTE = 1200;

/** The actions a person gets, in order. A viewer gets what changes nothing: Copy, Share, Pin (theirs alone) and
 * Select text. Try again and Save as template need the question the reply answered. */
export function menuItems({canWrite = false, touch = false, canRetry = false, canTemplate = false, pinned = false} = {}) {
  const all = [
    {id: 'copy', label: 'Copy', glyph: 'copy'},
    canWrite && canRetry && {id: 'retry', label: 'Try again', glyph: 'retry'},
    {id: 'share', label: 'Share', glyph: 'share'},
    {id: 'pin', label: pinned ? 'Unpin' : 'Pin', glyph: 'pin'},
    canWrite && {id: 'thread', label: 'Start a thread', glyph: 'people'},
    canWrite && canTemplate && {id: 'template', label: 'Save as template', glyph: 'note'},
    touch && {id: 'select', label: 'Select text', glyph: 'cursor'},
  ];
  return all.filter(Boolean);
}

/** 👍 / 👎 teach the bot, so they show only to someone who may write, for a bot whose memory is on. */
export const showFeedback = ({canWrite = false, memoryOn = true} = {}) => Boolean(canWrite && memoryOn);

/** The reply (or the selected part of it) as a Markdown blockquote, cut with an ellipsis when long. */
export function quoteText(text) {
  let body = String(text ?? '').trim();
  if (body.length > MAX_QUOTE) body = `${body.slice(0, MAX_QUOTE).trimEnd()}…`;
  return body.split('\n').map(line => (line.trim() ? `> ${line}` : '>')).join('\n');
}

/** What Ask about this sends: the quote, then the owner's words. */
export const askText = (quoted, words) => [quoted, String(words ?? '').trim()].filter(Boolean).join('\n\n');
/** What Start a thread opens with: the quote, then the owner's words or a plain ask to follow up. */
export const threadText = (quoted, words) => askText(quoted, String(words ?? '').trim() || 'Follow up on this.');

/** The owner line a reply answered: the nearest one before it in time (the browser can hold a sent line after the
 * run's lines that synced in first, so the list is put in time order as the feed is). A thread's helpers speak in
 * the same run first, so a line of the reply's own run is passed over; any other reply in between means this one
 * answered nothing new. */
export function askedBefore(messages, messageId) {
  const ms = m => { const t = Date.parse(m?.at); return Number.isFinite(t) ? t : 0; };
  const list = (Array.isArray(messages) ? messages : []).map((m, order) => ({m, order}))
    .sort((a, b) => ms(a.m) - ms(b.m) || a.order - b.order).map(x => x.m);
  const at = list.findIndex(m => m?.id === messageId);
  if (at < 0) return '';
  const runId = list[at].runId;
  for (let i = at - 1; i >= 0; i--) {
    const m = list[i];
    if (!m || m.role === 'system') continue;
    if (m.role === 'user') return String(m.text ?? '').trim();
    if (runId && m.runId === runId) continue;
    return '';
  }
  return '';
}

const pinList = (pins, chatKey) => (pins && typeof pins === 'object' && Array.isArray(pins[chatKey]) ? pins[chatKey].filter(id => typeof id === 'string') : []);
export const isPinned = (pins, chatKey, id) => pinList(pins, chatKey).includes(id);
/** Pin a reply (newest first, at most 20 per chat) or, if it is pinned, unpin it. Returns a new object. */
export function togglePin(pins, chatKey, id) {
  const list = pinList(pins, chatKey), next = list.includes(id) ? list.filter(x => x !== id) : [id, ...list].slice(0, MAX_MSG_PINS);
  return {...(pins && typeof pins === 'object' ? pins : {}), [chatKey]: next};
}
/** The pins of one chat whose replies are still there. */
export const pinsOf = (pins, chatKey, ids) => { const live = new Set(ids || []); return pinList(pins, chatKey).filter(id => live.has(id)); };

/** Where the popover goes. At a pointer (a right-click) when one is given; otherwise below the reply when it fits
 * above the composer, else above it. Always inside the margins. */
export function placePopover(anchor, size, view, composerTop = view.h, point = null) {
  const floor = Math.min(view.h, composerTop) - MARGIN;
  const clampX = x => Math.max(MARGIN, Math.min(x, view.w - size.w - MARGIN));
  const clampY = y => Math.max(MARGIN, Math.min(y, floor - size.h));
  if (point) return {left: clampX(point.x), top: clampY(point.y), below: true};
  const under = anchor.bottom + GAP;
  if (under + size.h <= floor) return {left: clampX(anchor.left), top: under, below: true};
  const over = anchor.top - GAP - size.h;
  return {left: clampX(anchor.left), top: clampY(over), below: false};
}

/** The reply that carries the one-time "hold a reply" tip: the first one that answers the owner. */
export function hintFor(entries, seen) {
  if (seen) return null;
  let asked = false;
  for (const entry of entries || []) {
    if (entry?.kind === 'me') asked = true;
    else if (entry?.kind === 'bot' && asked && entry.message?.id) return entry.message.id;
  }
  return null;
}

/** The strip under a chat's header: how many replies are pinned, and (opened) each one's first line and time. */
export function pinsStripHtml(items) {
  if (!items?.length) return '';
  const rows = items.map(m => `<button type="button" class="cv-pin-row" data-action="pin-jump" data-m="${esc(m.id)}"><span>${esc(plain(String(m.text ?? '').split('\n')[0]).slice(0, 120))}</span><small>${esc(stamp(m.at))}</small></button>`).join('');
  return `<div class="cv-pins"><button type="button" class="cv-pins-head" data-action="pins-toggle" aria-expanded="false"><span>📌 ${items.length} pinned</span></button><div class="cv-pins-list" hidden>${rows}</div></div>`;
}

/** The one-time tip under the first reply that answers the owner. */
export const hintHtml = () => `<div class="cv-hint" role="note"><span>Tip: hold a reply for more. On a computer, right-click it.</span><button type="button" class="cv-hint-x" data-action="hint-close" aria-label="Hide this tip">${icon('x', 14)}</button></div>`;
