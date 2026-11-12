/** What the owner may send to a tab they are driving, and how it is bounded.
 *
 * One normaliser for both ends: the server runs it before it queues an event for
 * the device, and the device runs it again before it touches the browser, so a
 * malformed or oversized event is refused wherever it came from. Pure: no
 * browser, no state. */
import {fail} from '../shared/errors.js';

/** The page the owner sees is this big (CSS pixels), so a click outside it is an error, not a guess. */
export const VIEWPORT = {width: 1280, height: 800};
export const MAX_TYPED = 2000;
const WHEEL_LIMIT = 5000;

/** The named keys a person can press. A letter is typed with `type`, not pressed. */
export const KEYS = {
  Enter: {code: 'Enter', vk: 13, text: '\r'}, Tab: {code: 'Tab', vk: 9}, Backspace: {code: 'Backspace', vk: 8}, Delete: {code: 'Delete', vk: 46},
  Escape: {code: 'Escape', vk: 27}, ArrowUp: {code: 'ArrowUp', vk: 38}, ArrowDown: {code: 'ArrowDown', vk: 40}, ArrowLeft: {code: 'ArrowLeft', vk: 37},
  ArrowRight: {code: 'ArrowRight', vk: 39}, Home: {code: 'Home', vk: 36}, End: {code: 'End', vk: 35}, PageUp: {code: 'PageUp', vk: 33}, PageDown: {code: 'PageDown', vk: 34},
};
export const INPUT_TYPES = ['click', 'key', 'type', 'scroll', 'navigate'];

const num = (value, name, min, max) => {
  const n = Number(value);
  if (value === null || value === '' || typeof value === 'boolean' || !Number.isFinite(n)) fail(`${name} must be a number.`, 400);
  return Math.round(Math.min(max, Math.max(min, n)));
};

/** One owner event, normalised, or a 400. Unknown fields are dropped. */
export function cleanInput(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) fail('An input event must be an object.', 400);
  switch (event.type) {
    case 'click': return {type: 'click', x: num(event.x, 'x', 0, VIEWPORT.width), y: num(event.y, 'y', 0, VIEWPORT.height), double: event.double === true};
    case 'scroll': return {type: 'scroll', x: num(event.x ?? VIEWPORT.width / 2, 'x', 0, VIEWPORT.width), y: num(event.y ?? VIEWPORT.height / 2, 'y', 0, VIEWPORT.height), dx: num(event.dx ?? 0, 'dx', -WHEEL_LIMIT, WHEEL_LIMIT), dy: num(event.dy ?? 0, 'dy', -WHEEL_LIMIT, WHEEL_LIMIT)};
    case 'type': {
      if (typeof event.text !== 'string' || !event.text) fail('Text to type is required.', 400);
      if (event.text.length > MAX_TYPED) fail(`At most ${MAX_TYPED} characters can be typed at once.`, 400);
      return {type: 'type', text: event.text};
    }
    case 'key':
      if (typeof event.key !== 'string' || !Object.hasOwn(KEYS, event.key)) fail(`A key is one of: ${Object.keys(KEYS).join(', ')}.`, 400);
      return {type: 'key', key: event.key};
    case 'navigate': {
      let url;
      try { url = new URL(String(event.url || '')); } catch { fail('Navigate needs a full http(s) address.', 400); }
      if (!/^https?:$/.test(url.protocol) || String(event.url).length > 2000) fail('Navigate needs a full http(s) address.', 400);
      return {type: 'navigate', url: url.href};
    }
    default: fail(`An input event is one of: ${INPUT_TYPES.join(', ')}.`, 400);
  }
}
