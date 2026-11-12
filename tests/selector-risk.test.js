// Found by the real-model sweep: posting on X with selectors ([data-testid="tweetButtonInline"]) asked as a Send,
// and the card named the first click (the text box) instead of the button that posts. A selector's camelCase and
// underscores are read as words, and the card names the last click of that kind, which is the one that commits.
import test from 'node:test';
import assert from 'node:assert/strict';
import {browserNeeds} from '../shared/bot-browser.js';

const steps = [
  {op: 'click', selector: '[data-testid="tweetTextarea_0"]'},
  {op: 'type', selector: '[data-testid="tweetTextarea_0"]', text: 'hello'},
  {op: 'click', selector: '[data-testid="tweetButtonInline"]'},
];

test('a tweet button found by selector asks as a post', () => {
  const needs = browserNeeds({url: 'https://x.com/home', steps});
  assert.deepEqual(needs.map(n => n.action), ['post', 'browser.use']);
});

test('the post card names the button that posts', () => {
  const [post] = browserNeeds({url: 'https://x.com/home', steps});
  assert.match(post.detail, /tweetButtonInline/);
});

test('an unlabelled selector with no risk words is still at least a send', () => {
  const needs = browserNeeds({url: 'https://b.example/', steps: [{op: 'click', selector: '#go'}]});
  assert.equal(needs[0].action, 'send');
});
