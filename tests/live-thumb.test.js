/** The small live picture of a bot's screen on its profile and its chat header: the pure rules in
 * shared/ui-computer.js (when it shows, what it says, how often it looks again). */
import test from 'node:test';
import assert from 'node:assert/strict';
import {thumbFor, thumbDelay} from '../shared/ui-computer.js';

const IMG = 'data:image/jpeg;base64,AAAA';

test('no picture while the bot is idle, in the demo, or with no device', () => {
  assert.equal(thumbFor({state: 'idle'}), null);
  assert.equal(thumbFor({state: 'browsing', demo: true}), null);
  assert.equal(thumbFor({state: 'browsing', view: {demo: true, state: 'browsing'}}), null);
  assert.equal(thumbFor({state: 'browsing', view: {agent: false, state: 'browsing'}}), null);
});

test('while the bot browses it shows the latest frame and the site it is on', () => {
  assert.deepEqual(thumbFor({state: 'browsing', site: 'example.com', view: {agent: true, state: 'browsing', image: IMG, site: 'news.example.com'}}),
    {state: 'browsing', site: 'news.example.com', image: IMG, label: 'Watch the bot on news.example.com'});
  // Before the first frame: the site from the list, no picture yet.
  assert.deepEqual(thumbFor({state: 'browsing', site: 'example.com', name: 'Atlas'}), {state: 'browsing', site: 'example.com', image: '', label: 'Watch Atlas on example.com'});
});

test('the frame reply is fresher than the list: an idle reply hides it, a browsing one shows it', () => {
  assert.equal(thumbFor({state: 'browsing', view: {agent: true, state: 'idle', image: IMG}}), null);
  assert.equal(thumbFor({state: 'idle', view: {agent: true, state: 'browsing', image: IMG, site: 'a.example'}, name: 'Atlas'}).site, 'a.example');
});

test('while the owner drives it says so', () => {
  assert.equal(thumbFor({state: 'driving', site: 'a.example', name: 'Atlas'}).label, 'You are driving Atlas\'s browser, on a.example');
});

test('it looks again every 2.5 seconds, only while visible and active, and backs off after errors', () => {
  assert.equal(thumbDelay({visible: true, active: true}), 2500);
  assert.equal(thumbDelay({visible: false, active: true}), null);
  assert.equal(thumbDelay({visible: true, active: false}), null);
  assert.equal(thumbDelay({visible: true, active: true, failures: 1}), 5000);
  assert.equal(thumbDelay({visible: true, active: true, failures: 9}), 15000);
});
