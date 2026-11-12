/** Task templates: a small built-in set of starters, plus messages the owner saved (`state.templates`, one list per
 * workspace, stored server-side through POST and DELETE /api/templates). A chip either fills the composer for the
 * owner to edit before sending (`fill`) or turns on the daily briefing (`briefing`, shared/briefing.js).
 * Browser-safe and Node-tested (tests/templates.test.js); the add and remove rules are shared by the server and
 * the Pages demo. */
import {fail} from './errors.js?v=969de23b28';
import {briefingSchedule} from './briefing.js?v=969de23b28';

export const MAX_TEMPLATES = 30;
const MAX_TEXT = 4000, TITLE = 40;

export const BUILT_IN_TEMPLATES = [
  {id: 'daily-briefing', title: 'Daily briefing', action: 'briefing', text: ''},
  {id: 'inbox', title: 'Summarise my inbox', action: 'fill', needs: 'mail', text: 'Summarise my unread email from the last day in five lines: who wrote, what they want, and which ones need a reply from me.'},
  {id: 'watch-page', title: 'Watch a page for changes', action: 'fill', text: 'Every day, check this page and tell me only when something on it has changed: '},
  {id: 'research-digest', title: 'Weekly research digest', action: 'fill', text: 'Every Monday, find the most important new things about [topic] from the past week and send me a short digest, each with its link.'},
  {id: 'draft-reply', title: 'Draft a reply', action: 'fill', text: 'Draft a reply to the message below. Keep it short and friendly, and do not send it.\n\n'},
];

/** True when a mail app is connected and ready: Gmail (Google), or a connector named for mail. */
export const hasMailApp = state => (state?.connectors || []).some(c => (c.status || 'ready') === 'ready'
  && (c.kind === 'google' || c.app === 'google' || /\b(mail|gmail|outlook|inbox)\b/i.test(String(c.name || ''))));

/** The chips to show, in order: the built-ins that fit (the inbox one needs a mail app, the briefing one goes
 * once it is on), then the saved templates. */
export function templateChips(state) {
  const fits = t => (t.needs !== 'mail' || hasMailApp(state)) && (t.action !== 'briefing' || !briefingSchedule(state));
  const builtIn = BUILT_IN_TEMPLATES.filter(fits).map(({id, title, text, action}) => ({id, title, text, action}));
  const saved = (state?.templates || []).map(t => ({id: t.id, title: t.title, text: t.text, action: 'fill', saved: true}));
  return [...builtIn, ...saved];
}

/** The first few words of a message, as a chip's title. */
export function titleOf(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= TITLE) return flat;
  const cut = flat.slice(0, TITLE), space = cut.lastIndexOf(' ');
  return `${(space > 10 ? cut.slice(0, space) : cut).trim()}…`;
}

/** Save a message as a template. The same text twice keeps the first. Mutates `state`; returns the template. */
export function addTemplate(state, {title, text} = {}, {makeId = () => crypto.randomUUID(), now = new Date().toISOString()} = {}) {
  const body = typeof text === 'string' ? text.trim() : '';
  if (!body) fail('A template needs some text.');
  if (body.length > MAX_TEXT) fail(`A template is at most ${MAX_TEXT} characters.`);
  state.templates = Array.isArray(state.templates) ? state.templates : [];
  const same = state.templates.find(t => t.text === body);
  if (same) return same;
  if (state.templates.length >= MAX_TEMPLATES) fail(`You can keep ${MAX_TEMPLATES} templates. Delete one first.`, 409);
  const name = typeof title === 'string' && title.trim() ? titleOf(title) : titleOf(body);
  const template = {id: makeId(), title: name, text: body, createdAt: now};
  state.templates.push(template);
  return template;
}

/** Delete a saved template. A built-in is not stored, so it is not found either. */
export function removeTemplate(state, id) {
  const list = Array.isArray(state.templates) ? state.templates : [];
  if (!list.some(t => t.id === id)) fail('Template not found.', 404);
  state.templates = list.filter(t => t.id !== id);
  return {ok: true};
}
