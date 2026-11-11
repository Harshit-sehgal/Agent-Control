import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PAGE, KEY_CHIPS, pagePoint, clickInput, wheelInput, keyInput, coalesce, navigateAddress, rowLabel, stateLine, mergeView, frameDelay, listDelay,
  statusOf, chipFor, pagesRows, noteFor, wantsList, veilFor,
} from '../shared/ui-computer.js';
import {cleanInput} from '../agent/live-input.mjs';

const rect = {left: 100, top: 50, width: 640, height: 400};   // half size of the 1280x800 page

// ---- coordinates ----

test('a click on the displayed image is scaled to 1280x800 page pixels', () => {
  assert.deepEqual(pagePoint(rect, {x: 100, y: 50}), {x: 0, y: 0});
  assert.deepEqual(pagePoint(rect, {x: 420, y: 250}), {x: 640, y: 400});
  assert.deepEqual(pagePoint(rect, {x: 740, y: 450}), {x: 1280, y: 800});
});

test('a point outside the image is clamped to the page, never past it', () => {
  assert.deepEqual(pagePoint(rect, {x: 10, y: 9999}), {x: 0, y: 800});
  assert.deepEqual(pagePoint(rect, {x: 9999, y: -5}), {x: 1280, y: 0});
});

test('the scale follows the frame size when the device sent a different one', () => {
  assert.deepEqual(pagePoint({left: 0, top: 0, width: 500, height: 500}, {x: 250, y: 250}, {w: 1000, h: 1000}), {x: 500, y: 500});
});

test('a zero-sized image gives no point instead of NaN', () => {
  assert.equal(pagePoint({left: 0, top: 0, width: 0, height: 0}, {x: 1, y: 1}), null);
  assert.equal(clickInput({left: 0, top: 0, width: 0, height: 400}, {x: 1, y: 1}), null);
});

test('every click and wheel event the view builds passes the device normaliser', () => {
  const edges = [[100, 50], [740, 450], [0, 0], [5000, 5000], [321.7, 99.2]];
  for (const [x, y] of edges) {
    assert.doesNotThrow(() => cleanInput(clickInput(rect, {x, y})));
    assert.doesNotThrow(() => cleanInput(wheelInput({deltaX: 1e9, deltaY: -1e9, deltaMode: 0}, rect, {x, y})));
  }
  assert.deepEqual(clickInput(rect, {x: 420, y: 250}), {type: 'click', x: 640, y: 400});
  assert.deepEqual(clickInput(rect, {x: 420, y: 250}, PAGE, true), {type: 'click', x: 640, y: 400, double: true});
});

test('the wheel scrolls the page by the page pixels under the displayed pixels', () => {
  assert.deepEqual(wheelInput({deltaX: 0, deltaY: 50, deltaMode: 0}, rect, {x: 420, y: 250}), {type: 'scroll', x: 640, y: 400, dx: 0, dy: 100});
  assert.equal(wheelInput({deltaX: 0, deltaY: 1, deltaMode: 1}, rect, {x: 420, y: 250}).dy, 32);
  assert.equal(wheelInput({deltaX: 0, deltaY: 1e9, deltaMode: 0}, rect, {x: 420, y: 250}).dy, 5000);
  assert.equal(wheelInput({deltaX: 0, deltaY: -1e9, deltaMode: 0}, rect, {x: 420, y: 250}).dy, -5000);
});

// ---- keys ----

test('named keys map to key events, letters to typed text', () => {
  assert.deepEqual(keyInput({key: 'Enter'}), {type: 'key', key: 'Enter'});
  assert.deepEqual(keyInput({key: 'ArrowLeft'}), {type: 'key', key: 'ArrowLeft'});
  assert.deepEqual(keyInput({key: 'PageDown', shiftKey: true}), {type: 'key', key: 'PageDown'});
  assert.deepEqual(keyInput({key: 'a'}), {type: 'type', text: 'a'});
  assert.deepEqual(keyInput({key: 'A', shiftKey: true}), {type: 'type', text: 'A'});
  assert.deepEqual(keyInput({key: ' '}), {type: 'type', text: ' '});
  assert.deepEqual(keyInput({key: 'é'}), {type: 'type', text: 'é'});
  assert.deepEqual(keyInput({key: '😀'}), {type: 'type', text: '😀'});
});

test('shortcuts, modifiers and keys the device does not know are not forwarded', () => {
  for (const ev of [{key: 'c', ctrlKey: true}, {key: 'l', metaKey: true}, {key: 'f', altKey: true}, {key: 'F5'}, {key: 'Shift'}, {key: 'Control'}, {key: 'Dead'}, {key: 'Process'}, {key: 'Unidentified'}, {}]) {
    assert.equal(keyInput(ev), null, JSON.stringify(ev));
  }
});

test('every key the view can send is one the device accepts', () => {
  for (const key of ['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']) {
    assert.doesNotThrow(() => cleanInput(keyInput({key})), key);
  }
  for (const chip of KEY_CHIPS) assert.doesNotThrow(() => cleanInput({type: 'key', key: chip.key}), chip.key);
  assert.ok(KEY_CHIPS.every(c => c.label && c.aria));
});

// ---- coalescing ----

test('typed letters that follow each other become one event, in order', () => {
  const out = coalesce([{type: 'type', text: 'h'}, {type: 'type', text: 'i'}, {type: 'key', key: 'Enter'}, {type: 'type', text: '!'}]);
  assert.deepEqual(out, [{type: 'type', text: 'hi'}, {type: 'key', key: 'Enter'}, {type: 'type', text: '!'}]);
});

test('coalesced text never passes the 2000 character limit', () => {
  const out = coalesce([{type: 'type', text: 'a'.repeat(1500)}, {type: 'type', text: 'b'.repeat(1500)}]);
  assert.equal(out.length, 2);
  for (const e of out) assert.doesNotThrow(() => cleanInput(e));
  assert.equal(out.map(e => e.text).join(''), 'a'.repeat(1500) + 'b'.repeat(1500));
});

test('wheel turns add up, keep the newest place and stay inside the limit', () => {
  const out = coalesce([{type: 'scroll', x: 1, y: 2, dx: 0, dy: 100}, {type: 'scroll', x: 3, y: 4, dx: 5, dy: 4950}, {type: 'click', x: 1, y: 1}]);
  assert.deepEqual(out, [{type: 'scroll', x: 3, y: 4, dx: 5, dy: 5000}, {type: 'click', x: 1, y: 1}]);
});

test('a click between two typed runs keeps them apart', () => {
  const out = coalesce([{type: 'type', text: 'a'}, {type: 'click', x: 1, y: 1}, {type: 'type', text: 'b'}]);
  assert.equal(out.length, 3);
});

test('coalesce leaves its input alone', () => {
  const input = [{type: 'type', text: 'a'}, {type: 'type', text: 'b'}];
  coalesce(input);
  assert.deepEqual(input, [{type: 'type', text: 'a'}, {type: 'type', text: 'b'}]);
});

// ---- the address box ----

test('a typed address becomes a full http(s) address or nothing', () => {
  assert.equal(navigateAddress('example.com'), 'https://example.com/');
  assert.equal(navigateAddress('  mail.google.com/mail/u/0  '), 'https://mail.google.com/mail/u/0');
  assert.equal(navigateAddress('http://example.com/a?b=1'), 'http://example.com/a?b=1');
  assert.equal(navigateAddress('https://example.com'), 'https://example.com/');
  assert.equal(navigateAddress('localhost:3000'), 'https://localhost:3000/');
});

test('an address that is not a web address is refused', () => {
  for (const text of ['', '   ', 'javascript:alert(1)', 'file:///etc/passwd', 'ftp://x.com', 'data:text/html,hi', 'two words', 'a'.repeat(2100)]) assert.equal(navigateAddress(text), null, text);
});

// ---- what the view says ----

test('the profile row says Idle, Browsing or You are driving', () => {
  assert.equal(rowLabel('idle'), 'Idle');
  assert.equal(rowLabel('browsing'), 'Browsing');
  assert.equal(rowLabel('driving'), 'You are driving');
  assert.equal(rowLabel(undefined), 'Idle');
  assert.equal(rowLabel('nonsense'), 'Idle');
});

test('statusOf reads one bot out of the list and defaults to idle', () => {
  const list = [{botId: 'a', state: 'browsing'}, {botId: 'b', state: 'driving'}];
  assert.equal(statusOf(list, 'a'), 'browsing');
  assert.equal(statusOf(list, 'b'), 'driving');
  assert.equal(statusOf(list, 'c'), 'idle');
  assert.equal(statusOf(null, 'c'), 'idle');
});

test('the line under the page says what the bot is doing', () => {
  assert.equal(stateLine({name: 'Mailroom', state: 'driving'}), 'You have the browser');
  assert.equal(stateLine({name: 'Mailroom', state: 'browsing', title: 'Inbox', site: 'mail.google.com'}), 'Mailroom is on Inbox');
  assert.equal(stateLine({name: 'Mailroom', state: 'browsing', title: '', site: 'mail.google.com'}), 'Mailroom is opening mail.google.com');
  assert.equal(stateLine({name: 'Mailroom', state: 'browsing'}), 'Mailroom is browsing');
  assert.equal(stateLine({name: 'Mailroom', state: 'idle'}), 'Idle');
});

test('an idle bot says when it last used the browser', () => {
  const now = Date.parse('2026-11-11T12:00:00Z');
  assert.equal(stateLine({name: 'M', state: 'idle', pages: [{at: '2026-11-11T11:00:00Z'}, {at: '2026-11-11T11:58:00Z'}], now}), 'Idle · last used 2 min ago');
  assert.equal(stateLine({name: 'M', state: 'idle', pages: [{at: '2026-11-11T11:59:50Z'}], now}), 'Idle · last used just now');
  assert.equal(stateLine({name: 'M', state: 'idle', pages: [{at: '2026-11-11T09:00:00Z'}], now}), 'Idle · last used 3 h ago');
  assert.equal(stateLine({name: 'M', state: 'idle', pages: [{at: 'not a date'}], now}), 'Idle');
});

test('the line is plain text, never markup from a page title', () => {
  assert.equal(stateLine({name: 'M', state: 'browsing', title: '<img src=x onerror=1>'}), 'M is on <img src=x onerror=1>');
});

test('a notice from the device is shown as it came', () => {
  assert.equal(noteFor({notice: 'The takeover could not start.'}), 'The takeover could not start.');
  assert.equal(noteFor({}), '');
  assert.equal(noteFor(null), '');
  assert.equal(noteFor({notice: 7}), '');
});

// ---- polling ----

test('the frame poll is quick while visible, off while hidden', () => {
  assert.equal(frameDelay({visible: true, agent: true, failures: 0}), 300);
  assert.equal(frameDelay({visible: false, agent: true, failures: 0}), null);
  assert.equal(frameDelay({visible: false, agent: false, failures: 0}), null);
});

test('with no device the poll slows down but keeps looking, so a started agent is noticed', () => {
  assert.equal(frameDelay({visible: true, agent: false, failures: 0}), 3000);
});

test('failures back off and stop at five seconds', () => {
  const delays = [1, 2, 3, 4, 8].map(failures => frameDelay({visible: true, agent: true, failures}));
  assert.deepEqual(delays, [600, 1200, 2400, 4800, 5000]);
});

test('the list poll is about five seconds, only when somebody needs it and the tab is visible', () => {
  assert.equal(listDelay({visible: true}), 5000);
  assert.equal(listDelay({visible: false}), null);
  assert.equal(listDelay({visible: true, failures: 3}), 5000);
  assert.equal(listDelay({visible: true, disabled: true}), null);
});

test('the list is wanted on a profile, while a page request is out, or while the owner drives', () => {
  const quiet = {route: {bot: 'a'}, requests: [], live: []};
  assert.equal(wantsList(quiet), false);
  assert.equal(wantsList({...quiet, route: {profile: 'a'}}), true);
  assert.equal(wantsList({...quiet, requests: [{status: 'dispatched'}]}), true);
  assert.equal(wantsList({...quiet, requests: [{status: 'done'}]}), false);
  assert.equal(wantsList({...quiet, live: [{botId: 'a', state: 'driving'}]}), true);
  assert.equal(wantsList({...quiet, live: [{botId: 'a', state: 'idle'}]}), false);
});

// ---- merging a poll ----

const fresh = {agent: true, seq: 0, image: '', w: 1280, h: 800, state: 'idle', url: '', title: '', site: '', notice: ''};

test('a new frame replaces the picture and moves the cursor of the poll', () => {
  const next = mergeView(fresh, {agent: true, seq: 4, changed: true, w: 1280, h: 800, image: 'data:image/jpeg;base64,AAA', state: 'browsing', url: 'https://a.test/', title: 'A', site: 'a.test'});
  assert.equal(next.image, 'data:image/jpeg;base64,AAA');
  assert.equal(next.seq, 4);
  assert.equal(next.state, 'browsing');
  assert.equal(next.title, 'A');
});

test('a poll with no new frame keeps the last picture', () => {
  const had = {...fresh, seq: 4, image: 'data:image/jpeg;base64,AAA'};
  const next = mergeView(had, {agent: true, seq: 4, changed: false, state: 'browsing', url: 'https://a.test/'});
  assert.equal(next.image, 'data:image/jpeg;base64,AAA');
  assert.equal(next.seq, 4);
  assert.equal(next.url, 'https://a.test/');
});

test('without a device there is no picture to show, and the notice stays', () => {
  const had = {...fresh, seq: 4, image: 'data:image/jpeg;base64,AAA'};
  const next = mergeView(had, {agent: false, seq: 0, changed: false, state: 'idle', notice: 'No Chrome here.'});
  assert.equal(next.agent, false);
  assert.equal(next.image, '');
  assert.equal(next.seq, 0);
  assert.equal(next.notice, 'No Chrome here.');
});

test('a picture that is not an image data url is never used', () => {
  const next = mergeView(fresh, {agent: true, seq: 1, changed: true, image: 'https://evil.test/x.png'});
  assert.equal(next.image, '');
  const js = mergeView(fresh, {agent: true, seq: 1, changed: true, image: 'javascript:alert(1)'});
  assert.equal(js.image, '');
});

test('the frame size follows the reply and falls back to 1280x800', () => {
  assert.equal(mergeView(fresh, {agent: true, w: 1000, h: 600}).w, 1000);
  assert.equal(mergeView(fresh, {agent: true, w: 'x', h: -1}).w, PAGE.w);
  assert.equal(mergeView(fresh, {agent: true, w: 'x', h: -1}).h, PAGE.h);
});

// ---- the site chip ----

const live = [{botId: 'mail', state: 'browsing', site: 'mail.google.com'}, {botId: 'plan', state: 'driving', site: 'calendar.google.com'}, {botId: 'idle', state: 'idle', site: null}];

test('the chip is the host of the page a bot of this run has open', () => {
  const requests = [{id: 'r1', botId: 'mail', runId: 'run1', status: 'dispatched', url: 'https://Mail.Google.com/mail/u/0/#inbox'}];
  assert.deepEqual(chipFor({requests, live: [], runId: 'run1', botId: 'atlas'}), {botId: 'mail', site: 'mail.google.com'});
});

test('a finished or waiting request gives no chip', () => {
  for (const status of ['done', 'pending', 'denied', 'failed']) {
    assert.equal(chipFor({requests: [{botId: 'mail', runId: 'run1', status, url: 'https://a.test/'}], live: [], runId: 'run1', botId: 'mail'}), null, status);
  }
});

test('with no run match the working bot own request is used', () => {
  const requests = [{botId: 'mail', status: 'dispatched', url: 'https://mail.google.com/'}, {botId: 'plan', status: 'dispatched', url: 'https://calendar.google.com/'}];
  assert.deepEqual(chipFor({requests, live: [], botId: 'plan'}), {botId: 'plan', site: 'calendar.google.com'});
  assert.equal(chipFor({requests, live: [], botId: 'nobody'}), null);
});

test('the live list fills in when the workspace snapshot has not caught up', () => {
  assert.deepEqual(chipFor({requests: [], live, botId: 'mail'}), {botId: 'mail', site: 'mail.google.com'});
  assert.equal(chipFor({requests: [], live, botId: 'idle'}), null);
});

test('a chip says driving when the owner holds that bot', () => {
  assert.deepEqual(chipFor({requests: [], live, botId: 'plan'}), {botId: 'plan', site: 'calendar.google.com', driving: true});
  const requests = [{botId: 'plan', status: 'dispatched', url: 'https://calendar.google.com/'}];
  assert.equal(chipFor({requests, live, botId: 'plan'}).driving, true);
});

test('a url with no host gives no chip', () => {
  assert.equal(chipFor({requests: [{botId: 'a', status: 'dispatched', url: 'about:blank'}], live: [], botId: 'a'}), null);
});

// ---- the pages list ----

test('the pages list shows a title, else the host, with the host beside it', () => {
  const rows = pagesRows([{url: 'https://mail.google.com/mail/u/0/#inbox', title: 'Inbox', at: '2026-11-11T10:00:00Z'}, {url: 'https://www.example.com/a', title: null, at: 'x'}]);
  assert.deepEqual(rows.map(r => [r.text, r.host]), [['Inbox', 'mail.google.com'], ['www.example.com', 'www.example.com']]);
  assert.deepEqual(pagesRows(null), []);
  assert.deepEqual(pagesRows([{url: 'about:blank'}]).map(r => r.text), ['about:blank']);
});

// ---- the placeholder in the picture's place ----

test('the demo says it has no browser, and that wins over everything', () => {
  const v = veilFor({name: 'Mailroom', view: {demo: true, agent: false}, denied: true});
  assert.equal(v.kind, 'demo');
  assert.match(v.text, /full app/);
});

test('a viewer is told watching needs a member', () => {
  assert.equal(veilFor({name: 'M', view: {agent: true}, denied: true}).kind, 'viewer');
});

test('with no device the view explains how to start the local agent', () => {
  const v = veilFor({name: 'Mailroom', view: {agent: false}});
  assert.equal(v.kind, 'offline');
  assert.match(v.text, /AGENT_BROWSER=1/);
  assert.match(v.text, /Mailroom/);
  assert.equal(v.code, 'AGENT_BROWSER=1 node agent/agent.mjs run');
});

test('a frame on screen needs no placeholder', () => {
  assert.equal(veilFor({name: 'M', view: {agent: true, image: 'data:image/jpeg;base64,AAA', state: 'browsing'}}).kind, '');
});

test('before the first frame the placeholder follows the state', () => {
  assert.match(veilFor({name: 'Mailroom', view: {agent: true, state: 'idle'}}).text, /Mailroom opens pages here/);
  assert.match(veilFor({name: 'Mailroom', view: {agent: true, state: 'browsing'}}).title, /Watching Mailroom/);
  assert.equal(veilFor({name: 'M', view: {agent: true, state: 'driving'}}).title, 'Opening the tab');
});

test('the demo flag survives a merge', () => {
  assert.equal(mergeView(fresh, {agent: false, demo: true}).demo, true);
  assert.equal(mergeView(fresh, {agent: true}).demo, false);
});
