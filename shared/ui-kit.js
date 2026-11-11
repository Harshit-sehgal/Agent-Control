/** Presentation primitives for the chat UI: escaping, icons, avatars, time labels
 * and the handful of repeated row/field shapes. Pure string builders with no DOM
 * or app state, so they are safe to unit-test under Node. */

export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

/* Markdown, the small part models write: **bold**, *italic*, `code`, [links](https://…),
 * bullet and numbered lists, # headings. Everything is escaped first, so the only
 * tags in the result are the ones made here. */
const LIST = /^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/;
const HEAD = /^\s*#{1,6}\s+(.*)$/;
const UNESC = s => s.replace(/&amp;/g, '&');
function inline(text) {
  const codes = [];
  let s = esc(text).replace(/`([^`\n]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => `<a href="${esc(UNESC(url))}" target="_blank" rel="noopener noreferrer">${label}</a>`)
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*|__(?=\S)(.+?)(?<=\S)__/g, (_, a, b) => `<strong>${a ?? b}</strong>`)
    .replace(/(^|[^\w*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?!\w)|(^|[^\w])_(?=\S)(.+?)(?<=\S)_(?!\w)/g, (_, p1, a, p2, b) => `${p1 ?? p2}<em>${a ?? b}</em>`);
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}
export function md(text) {
  const out = [];
  let para = [], list = null;
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    if (list) out.push(`<${list.tag}>${list.items.map(i => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
    para = []; list = null;
  };
  for (const line of String(text ?? '').split('\n')) {
    const item = LIST.exec(line), head = HEAD.exec(line);
    if (!line.trim()) flush();
    else if (head) { flush(); out.push(`<p class="md-h">${inline(head[1])}</p>`); }
    else if (item) {
      const tag = item[1] ? 'ol' : 'ul';
      if (para.length || (list && list.tag !== tag)) flush();
      (list ||= {tag, items: []}).items.push(item[2]);
    } else if (list && /^\s{2,}\S/.test(line)) list.items[list.items.length - 1] += ` ${line.trim()}`;
    else { if (list) flush(); para.push(line); }
  }
  flush();
  return out.join('');
}
/** The same text with its markdown markers dropped, on one line, for previews. */
export const plain = text => String(text ?? '')
  .replace(/`([^`\n]+)`/g, '$1').replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1')
  .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => a ?? b).replace(/(^|[^\w*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?!\w)/g, '$1$2')
  .replace(/^\s*(?:#{1,6}|[-*•]|\d+[.)])\s+/gm, '').replace(/\s+/g, ' ').trim();

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
  note: '<path d="M6 3.5h12v17l-6-4-6 4z"/>',
  pulse: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
  shield: '<path d="M12 3 4.500 6v5.500c0 4.400 3.100 8.300 7.500 9.500 4.400-1.200 7.500-5.100 7.500-9.500V6z"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2.500V6M15 2.500V6M9 18v3.500M15 18v3.500M2.500 9H6M2.500 15H6M18 9h3.500M18 15h3.500"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.500v3M12 18.500v3M2.500 12h3M18.500 12h3M5.300 5.300l2.100 2.100M16.600 16.600l2.100 2.100M5.300 18.700l2.100-2.100M16.600 7.400l2.100-2.100"/>',
  half: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m10.800 12.200 8.700-8.700M17 6l2.500 2.500M14.500 8.500 17 11"/>',
  plug: '<path d="M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0zM12 16v5"/>',
  chart: '<path d="M5 20V12M10 20V6M15 20v-9M20 20V4"/>',
  spark: '<path d="m12 3 1.600 6.400L20 11l-6.400 1.600L12 19l-1.600-6.400L4 11l6.400-1.600z"/>',
};
export const icon = (name, size = 20) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.spark}</svg>`;

/** How many colours a bot can be (settings.tint indexes ui-face COLORS, which has this many). */
export const TINT_COUNT = 10;

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
/** A text input. `value` and every other attribute are escaped here, so callers
 * pass raw user text and never a pre-escaped string. */
export const textInput = (name, {type = 'text', value = '', ...rest} = {}) => {
  const extra = Object.entries(rest).map(([k, v]) => (v === true ? ` ${k}` : ` ${k}="${esc(v)}"`)).join('');
  return `<input class="input" name="${esc(name)}" type="${esc(type)}" value="${esc(value)}"${extra}>`;
};
/** A model dropdown from `modelChoices` rows, and the box Other… opens (hidden and disabled until then, so it
 * never posts by accident). The change handler `model-pick` shows it. */
export const modelSelect = (rows, {label = 'Model'} = {}) => `<select class="input" name="model" data-action="model-pick" aria-label="${esc(label)}">${rows.map(r => `<option value="${esc(r.value)}"${r.selected ? ' selected' : ''}>${esc(r.label)}</option>`).join('')}</select><input class="input model-other" name="modelOther" type="text" placeholder="Type a model id" maxlength="120" autocomplete="off" spellcheck="false" aria-label="Model id" hidden disabled>`;
/** One model dropdown for every connected provider, from `botModelChoices`: the workspace default, then an
 * optgroup per provider. Its "Another … model…" rows open the same typed-id box as `modelSelect`. */
export const groupedModelSelect = ({top, groups}, {label = 'Model'} = {}) => {
  const option = r => `<option value="${esc(r.value)}"${r.selected ? ' selected' : ''}>${esc(r.label)}</option>`;
  return `<select class="input" name="model" data-action="model-pick" aria-label="${esc(label)}">${option(top)}${groups.map(g => `<optgroup label="${esc(g.label)}">${g.rows.map(option).join('')}</optgroup>`).join('')}</select><input class="input model-other" name="modelOther" type="text" placeholder="Type the model id, e.g. gpt-5-mini" maxlength="120" autocomplete="off" spellcheck="false" aria-label="Model id" hidden disabled>`;
};
/** How hard the model thinks: four pills (Default, Low, Medium, High) from `effortChoices`, native radios so the
 * keyboard works, each with its hint as a tooltip and one line of help under them. */
export const effortPicker = (rows, {help = 'Higher effort thinks longer: better on hard work, slower and costs more. Models that do not support it ignore it.'} = {}) =>
  `<fieldset class="cn-via ef-pick"><legend class="field-label">Effort</legend><div class="st-seg" role="radiogroup" aria-label="Effort">${rows.map(r => `<label title="${esc(r.hint)}"><input type="radio" name="effort" value="${esc(r.value)}"${r.selected ? ' checked' : ''}><span>${esc(r.label)}</span></label>`).join('')}</div><small class="field-help">${esc(help)}</small></fieldset>`;
export const field = (label, control, help = '') => `<label class="field"><span class="field-label">${esc(label)}</span>${control}${help ? `<small class="field-help">${esc(help)}</small>` : ''}</label>`;
export const note = (text, tone = '') => `<p class="note ${tone}">${text}</p>`;
export const empty = (title, text = '') => `<div class="empty"><strong>${esc(title)}</strong>${text ? `<span>${esc(text)}</span>` : ''}</div>`;
export const tag = (text, tone = '') => `<span class="tag ${tone}">${esc(text)}</span>`;
/** A round 44px button with an icon, named for assistive tech. */
export const roundBtn = (glyph, label, action, {id, cls = ''} = {}) => `<button type="button" class="rbtn${cls ? ` ${cls}` : ''}" data-action="${esc(action)}"${id === undefined ? '' : ` data-id="${esc(id)}"`} aria-label="${esc(label)}">${icon(glyph, 20)}</button>`;
/** An on/off switch. `extra` is trusted attribute markup the caller has already escaped. */
export const switchBtn = (checked, label, extra = '') => `<button type="button" role="switch" class="swt" aria-checked="${checked ? 'true' : 'false'}" aria-label="${esc(label)}"${extra}><span class="knob" aria-hidden="true"></span></button>`;
