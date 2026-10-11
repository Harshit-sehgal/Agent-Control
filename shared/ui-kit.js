/** Presentation primitives for the chat UI: escaping, icons, avatars, time labels
 * and the handful of repeated row/field shapes. Pure string builders with no DOM
 * or app state, so they are safe to unit-test under Node. */

export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

const ICONS = {
  back: '<path d="m15 18-6-6 6-6"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  send: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  search: '<circle cx="10" cy="10" r="7"/><path d="m15 15 6 6"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  checks: '<path d="m1 12 4 4L15 6M11 16 21 6"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  dots: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  pin: '<path d="M12 17v5M8 3h8l-1 6 3 4H6l3-4z"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.700-5.700l-1 1M14 10a4 4 0 0 0-5.700 0l-3 3a4 4 0 0 0 5.700 5.700l1-1"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  people: '<circle cx="9" cy="9" r="3.5"/><path d="M2.500 19c.6-3 3.200-5 6.500-5s5.900 2 6.500 5M16 5.500a3.500 3.500 0 0 1 0 7M18.500 14.500c1.700.7 2.800 2.300 3 4.500"/>',
  bot: '<rect x="4" y="8" width="16" height="12" rx="4"/><path d="M12 8V4M9 14h.01M15 14h.01"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2m3 0-1 15H6L5 6m5 4v7m4-7v7"/>',
  spark: '<path d="m12 3 1.600 6.400L20 11l-6.400 1.600L12 19l-1.600-6.400L4 11l6.400-1.600z"/>',
};
export const icon = (name, size = 20) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.spark}</svg>`;

// Each bot gets one of six tints. The class sets --tile and --tint from the
// active theme (app.css), so avatars and sender names recolour with it, the way
// a messenger tells group members apart.
export const TINT_COUNT = 6;
export const tintClass = index => `t${Math.abs(Number(index) || 0) % TINT_COUNT}`;

// Every bot is a small character, not a letter in a circle. The face is drawn
// from the bot's tint index, so the same bot always looks the same: three head
// tops and three mouths give nine combinations across the six tints. CSS makes
// it blink and glance (each bot on its own beat) and look up while it thinks.
const TOPS = [
  '<path d="M24 11V6" fill="none" stroke="currentColor" stroke-width="2.200" stroke-linecap="round"/><circle cx="24" cy="5" r="2.400"/>',
  '<path d="M17.500 11 15 6.500M30.500 11 33 6.500" fill="none" stroke="currentColor" stroke-width="2.200" stroke-linecap="round"/><circle cx="14.500" cy="5.500" r="2"/><circle cx="33.500" cy="5.500" r="2"/>',
  '<path d="M17 10.500 20 6l4 4 4-4 3 4.500" fill="none" stroke="currentColor" stroke-width="2.200" stroke-linecap="round" stroke-linejoin="round"/>',
];
const MOUTHS = [
  '<path d="M19.500 31q4.500 4 9 0" fill="none" stroke="currentColor" stroke-width="2.200" stroke-linecap="round"/>',
  '<path d="M20 30.500q4 5.500 8 0z"/>',
  '<ellipse cx="24" cy="32" rx="2.400" ry="2"/>',
];
export function avatar(name, index = 0, size = 48) {
  const i = Math.abs(Number(index) || 0), beat = ((i * 1.7) % 5).toFixed(1);
  return `<span class="avatar face ${tintClass(i)}" style="width:${size}px;height:${size}px;--beat:-${beat}s" aria-hidden="true"><svg viewBox="0 0 48 48" fill="currentColor"><g class="top">${TOPS[i % 3]}</g><circle class="cheek" cx="11.500" cy="29.500" r="3"/><circle class="cheek" cx="36.500" cy="29.500" r="3"/><g class="look"><g class="eyes"><ellipse class="eye" cx="17.500" cy="23" rx="2.800" ry="3.800"/><ellipse class="eye" cx="30.500" cy="23" rx="2.800" ry="3.800"/></g></g><g class="mouth">${MOUTHS[Math.floor(i / 3) % 3]}</g><text class="zz" x="37" y="12">z</text><text class="zz zz2" x="42" y="6">z</text></svg></span>`;
}
/** A group shows its first two members overlapped, like a group chat photo. */
export function groupAvatar(members, size = 48) {
  if (members.length < 2) return `<span class="avatar avatar-plain" style="width:${size}px;height:${size}px" aria-hidden="true">${icon('people', Math.round(size * 0.46))}</span>`;
  const small = Math.round(size * 0.62);
  return `<span class="avatar-pair" style="width:${size}px;height:${size}px" aria-hidden="true">${members.slice(0, 2).map(m => avatar(m.name, m.tint, small)).join('')}</span>`;
}

/** The app's mascot: a small bot that blinks. Colours and motion come from CSS. */
export const mascot = () => `<svg class="mascot face" viewBox="0 0 96 96" aria-hidden="true"><g class="antenna"><path d="M48 22V10" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><circle cx="48" cy="8" r="5" fill="currentColor"/></g><rect x="12" y="22" width="72" height="60" rx="24" fill="currentColor"/><rect class="face" x="22" y="34" width="52" height="36" rx="16"/><g class="look"><g class="eyes"><circle class="eye" cx="38" cy="50" r="5" fill="currentColor"/><circle class="eye" cx="58" cy="50" r="5" fill="currentColor"/></g></g><circle class="cheek" cx="29" cy="59" r="3.500"/><circle class="cheek" cx="67" cy="59" r="3.500"/><path d="M43 60q5 5 10 0" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>`;

const dayStart = date => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
export const clock = value => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString(undefined, {hour: 'numeric', minute: '2-digit'}) : '';
};
/** Chat-list timestamp: time today, "Yesterday", weekday this week, else a date. */
export function stamp(value, now = new Date()) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return '';
  const days = Math.round((dayStart(now) - dayStart(date)) / 86400000);
  if (days <= 0) return clock(date);
  if (days === 1) return 'Yesterday';
  if (days < 7) return date.toLocaleDateString(undefined, {weekday: 'short'});
  return date.toLocaleDateString(undefined, {month: 'short', day: 'numeric'});
}
/** Thread day divider. */
export function dayLabel(value, now = new Date()) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const days = Math.round((dayStart(now) - dayStart(date)) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return date.toLocaleDateString(undefined, {weekday: 'long', month: 'short', day: 'numeric'});
}
export const fullDate = value => value ? new Date(value).toLocaleString(undefined, {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}) : '';

const attrs = map => Object.entries(map || {}).filter(([, v]) => v !== undefined && v !== null && v !== false).map(([k, v]) => ` ${k}="${esc(v)}"`).join('');

/** `kind`: primary | quiet (default) | danger | good | ghost. `data` becomes data-* attributes. */
export function btn(label, action, {kind = 'quiet', id, data = {}, glyph, type = 'button', small = false, wide = false} = {}) {
  const dataset = Object.fromEntries(Object.entries({...data, id}).map(([k, v]) => [`data-${k}`, v]));
  return `<button type="${type}" class="btn ${kind}${small ? ' small' : ''}${wide ? ' wide' : ''}"${action ? ` data-action="${esc(action)}"` : ''}${attrs(dataset)}>${glyph ? icon(glyph, 17) : ''}<span>${esc(label)}</span></button>`;
}
export const iconBtn = (glyph, label, action, {id, data = {}, cls = ''} = {}) => `<button type="button" class="icon-btn ${cls}" data-action="${esc(action)}" aria-label="${esc(label)}" title="${esc(label)}"${attrs(Object.fromEntries(Object.entries({...data, id}).map(([k, v]) => [`data-${k}`, v])))}>${icon(glyph, 22)}</button>`;

/** A settings-style row. With `action` it is a button; otherwise static text. */
export function row({title, sub = '', right = '', lead = '', action, id, data = {}, tone = ''}) {
  const body = `${lead}<span class="row-main"><span class="row-title">${title}</span>${sub ? `<span class="row-sub">${sub}</span>` : ''}</span>${right ? `<span class="row-right ${tone}">${right}</span>` : ''}`;
  const cls = `row${tone ? ` tone-${tone}` : ''}`;
  if (!action) return `<div class="${cls}">${body}</div>`;
  const dataset = Object.fromEntries(Object.entries({...data, id}).map(([k, v]) => [`data-${k}`, v]));
  return `<button type="button" class="${cls}" data-action="${esc(action)}"${attrs(dataset)}>${body}${icon('chevron', 16)}</button>`;
}
export const box = (inner, label = '') => `${label ? `<h3 class="box-label">${esc(label)}</h3>` : ''}<div class="box">${inner}</div>`;
export const field = (label, control, help = '') => `<label class="field"><span class="field-label">${esc(label)}</span>${control}${help ? `<small class="field-help">${esc(help)}</small>` : ''}</label>`;
export const note = (text, tone = '') => `<p class="note ${tone}">${text}</p>`;
export const empty = (title, text = '') => `<div class="empty"><strong>${esc(title)}</strong>${text ? `<span>${esc(text)}</span>` : ''}</div>`;
export const tag = (text, tone = '') => `<span class="tag ${tone}">${esc(text)}</span>`;
/** Header for a drill-in page inside a pane. */
export const pageHead = (title, {sub = '', back = 'back', right = ''} = {}) => `<header class="pane-head">${back ? iconBtn('back', 'Back', back, {cls: 'back'}) : ''}<div class="pane-head-text"><h2 tabindex="-1">${esc(title)}</h2>${sub ? `<p>${esc(sub)}</p>` : ''}</div>${right}</header>`;
