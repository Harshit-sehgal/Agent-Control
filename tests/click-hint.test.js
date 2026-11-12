// A restaurant's outlet card is a control, not a link: the only way in is a click.
// The page read shows the bot the exact block that clicks it, so it does not stall.
import test from 'node:test';
import assert from 'node:assert/strict';
import {capturePageText} from '../shared/bot-browser.js';

const page = {
  finalUrl: 'https://www.eazydiner.com/delhi-ncr/restaurants/lazeez-affaire',
  text: 'Lazeez Affaire Restaurant Outlets in Delhi NCR. Lazeez Affaire - Outer Circle, Connaught Place, ₹1600 for two, 4.3',
  links: [{text: 'Contact Us', url: 'https://www.eazydiner.com/contact-us'}],
  elements: [{index: 2, tag: 'a', text: 'Contact Us'}, {index: 8, tag: 'div', text: 'Lazeez Affaire - Outer Circle'}],
};

test('a page with controls shows the block that clicks one that is not a link', () => {
  const text = capturePageText(page);
  assert.match(text, /\{"url":"https:\/\/www\.eazydiner\.com\/delhi-ncr\/restaurants\/lazeez-affaire","steps":\[\{"op":"click","index":8\}\]\}/);
});

test('a page with no controls has no click example', () => {
  assert.doesNotMatch(capturePageText({...page, elements: []}), /"op":"click"/);
});

test('a find that misses points at the control that matches it, with the block that clicks it', () => {
  const text = capturePageText({...page, elements: [{index: 3, tag: 'div', text: 'Blogs and food trends'}, ...page.elements]}, undefined, 'Lazeez Affaire Outer Circle book table 8 PM');
  const first = text.split('\n')[0];
  assert.match(first, /Control 8 \(Lazeez Affaire - Outer Circle\)/);
  assert.match(first, /"steps":\[\{"op":"click","index":8\}\]/);
});

test('the label an ask card shows comes from the Controls line, never from the click hint or page text', async () => {
  const {controlLabels} = await import('../shared/bot-browser.js');
  const shown = capturePageText({...page, text: `${page.text} Offer [5] days only`}, undefined, 'Lazeez Affaire Outer Circle book table');
  const state = {browserRequests: [{botId: 'atlas', chatKey: 'atlas', status: 'done', url: page.finalUrl, result: {finalUrl: page.finalUrl, page: shown}}]};
  // Labels are keyed to the page's origin: the request names the address its indices are for.
  const labels = controlLabels(state, 'atlas', 'atlas', page.finalUrl);
  assert.equal(labels.get(8), 'Lazeez Affaire - Outer Circle');
  assert.equal(labels.get(5), undefined);
});

test('a page with many links still shows its Book Now button, late on the page', () => {
  const elements = [...Array.from({length: 47}, (_, i) => ({index: i + 1, tag: 'a', text: `Nearby place ${i + 1}`})), {index: 48, tag: 'button', text: 'Book Now'}, {index: 49, tag: 'button', text: 'Pay Bill'}, {index: 58, tag: 'a', text: 'Table booking'}];
  const text = capturePageText({...page, elements});
  const controls = text.split('\n').find(l => l.startsWith('Controls: '));
  assert.match(controls, /\[48\] button Book Now/);
  assert.match(controls, /\[58\] a Table booking/);
  assert.match(controls, /\[1\] a Nearby place 1/);
});
