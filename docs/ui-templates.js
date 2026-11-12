/** Task templates on screen: the chips under an empty chat and the new thread box, the composer's Templates button
 * and its sheet (use one, save what you typed, delete a saved one), and the Daily briefing sheet that picks the
 * morning time. A chip fills the composer and the owner edits before sending; only the briefing makes a schedule.
 * The lists and rules are pure (shared/templates.js, shared/briefing.js); this file is markup and events. */
import {templateChips} from './templates.js?v=691b5cf293';
import {briefingTaskBody} from './briefing.js?v=691b5cf293';
import {esc, icon, btn, field} from './ui-kit.js?v=691b5cf293';
import {store, api, sync, canWrite, findBot} from './ui-store.js?v=691b5cf293';
import {openSheet, closeSheet, toast} from './ui-dialogs.js?v=691b5cf293';
import {primaryOf} from './company.js?v=691b5cf293';

const box = () => document.querySelector('#chat-form textarea[name="message"], #new-thread-form textarea[name="message"]');
const chip = t => `<button type="button" data-action="use-template" data-id="${esc(t.id)}"${t.action === 'briefing' ? ' class="tp-brief"' : ''}>${t.action === 'briefing' ? icon('clock', 14) : ''}${esc(t.title)}</button>`;

/** The chips row for an empty chat or the new thread page; nothing for a viewer. */
export function templateChipsHtml() {
  if (!canWrite() || !store.state) return '';
  const chips = templateChips(store.state);
  return chips.length ? `<div class="nv-chips tp-chips" aria-label="Templates">${chips.map(chip).join('')}</div>` : '';
}

/** The composer's button that opens the templates sheet. */
export const templateButton = () => (canWrite() ? `<button type="button" class="cv-tpl" data-action="open-templates" aria-label="Templates" title="Templates: start from one, or save this message as one">${icon('note', 19)}</button>` : '');

function templatesSheet() {
  const chips = templateChips(store.state);
  const rows = chips.map(t => `<div class="tp-row">${btn(t.title, 'use-template', {id: t.id, glyph: t.action === 'briefing' ? 'clock' : null, wide: true})}${t.saved ? `<button type="button" class="memo-x" data-action="delete-template" data-id="${esc(t.id)}" aria-label="Delete the template ${esc(t.title)}">${icon('trash', 16)}</button>` : ''}</div>`).join('');
  openSheet(`<div class="tp-list">${rows}</div><div class="sheet-actions">${btn('Save what you typed as a template', 'save-template', {kind: 'primary', wide: true})}</div>`,
    {title: 'Templates', sub: 'Tap one to put it in the message box, then edit it before you send.'});
}

function briefingSheet() {
  const primary = primaryOf(store.state), name = primary?.name || 'Your primary bot';
  openSheet(`<form id="briefing-form" autocomplete="off">${field('Every morning at', '<input class="input" name="at" type="time" value="08:00" required autofocus>')}<div class="sheet-actions">${btn('Turn on the briefing', null, {kind: 'primary', type: 'submit', wide: true})}</div></form>`,
    {title: 'Daily briefing', sub: `${name} writes to you each morning: what finished yesterday, what waits on you, what is coming up, and anything that failed.`});
}

function fill(text) {
  closeSheet();
  const node = box();
  if (!node) { toast('Open a chat first, then pick a template.', true); return; }
  node.value = text;
  node.dispatchEvent(new Event('input', {bubbles: true}));
  node.focus();
  node.setSelectionRange(node.value.length, node.value.length);
}

export const templateActions = {
  'open-templates': () => templatesSheet(),
  'use-template': b => {
    const t = templateChips(store.state).find(x => x.id === b.dataset.id);
    if (!t) { toast('That template is gone.', true); return; }
    if (t.action === 'briefing') return briefingSheet();
    fill(t.text);
  },
  'save-template': async () => {
    const text = box()?.value.trim();
    if (!text) { toast('Type the message first, then save it as a template.', true); return; }
    await api('/api/templates', 'POST', {text});
    await sync();
    templatesSheet();
    toast('Saved as a template.');
  },
  'delete-template': async b => {
    await api(`/api/templates/${encodeURIComponent(b.dataset.id)}`, 'DELETE');
    await sync();
    templatesSheet();
    toast('Template deleted.');
  },
};

export const templateForms = {
  'briefing-form': async (form, f) => {
    const body = briefingTaskBody(store.state, {at: f.at});
    await api('/api/tasks', 'POST', body);
    await sync();
    closeSheet();
    // A page painted once (the new thread page) still shows the chip; it is on now, so it goes.
    document.querySelectorAll('.tp-brief').forEach(node => node.remove());
    toast(`Daily briefing is on, every day at ${body.payload.at}. ${findBot(body.payload.botId)?.name || 'The bot'}'s Schedule page can stop it.`);
  },
};
