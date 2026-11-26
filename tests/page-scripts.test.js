import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {SNAPSHOT, MAIN_TEXT, LOOK, actionExpression} from '../agent/browser.mjs';

const REFUSAL = 'This is a password or code field. The owner signs in; a bot never types there.';

/** A fake page element with the members the page scripts read. */
function el({tagName = 'INPUT', type = '', value, innerText, textContent, name, attrs = {}, secretTag = false}) {
  const self = {
    tagName, type, name, isContentEditable: false, disabled: false, form: null, labels: null,
    getAttribute: n => (n in attrs ? attrs[n] : null),
    setAttribute(n, v) { attrs[n] = v; },
    getBoundingClientRect: () => ({width: 10, height: 10}),
    // Only the selectors the scripts use: a tagged field is its own `[data-agent-secret]`; the rest find nothing.
    closest: sel => (sel === '[data-agent-secret]' ? (secretTag ? self : null) : (/^(form|a\[href\]|a\[target\])$/.test(sel) ? null : self)),
    matches: () => false,
    scrollIntoView() {}, click() {}, dispatchEvent() {},
  };
  if (value !== undefined) self.value = value;
  if (innerText !== undefined) self.innerText = innerText;
  self.textContent = textContent !== undefined ? textContent : (innerText || '');
  return self;
}

/** Page: pw (password hunter22), otp (tagged plain text 482913), q (search "red shoes"), pay (submit "Pay now"). */
function pagePieces(extra = {}) {
  const pw = el({type: 'password', value: 'hunter22', name: 'pw', ...extra.pw});
  const otp = el({type: 'text', value: '482913', name: 'otp', secretTag: true, attrs: {'data-agent-secret': ''}});
  const q = el({type: 'search', value: 'red shoes', name: 'q'});
  const pay = el({type: 'submit', value: 'Pay now'});
  const body = el({tagName: 'BODY', innerText: 'Signed in as ada. Code 482913 sent.'});
  return {all: [pw, otp, q, pay], body};
}

function run(script, {all, body}, {href = 'https://shop.example/pay', title = '', links = []} = {}) {
  body.querySelectorAll = () => links;
  const document = {
    title,
    body,
    querySelectorAll: () => all,
    querySelector: sel => {
      const m = /^\[data-agent-index="(\d+)"\]$/.exec(sel);
      if (m) return all[Number(m[1]) - 1] || null;
      return sel === 'body' ? body : null;
    },
  };
  return vm.runInNewContext(script, {document, getComputedStyle: () => ({visibility: 'visible', display: 'block'}), location: {origin: 'https://shop.example', href, pathname: new URL(href).pathname}, URL, Event: class { constructor(type) { this.type = type; } }});
}

test('the snapshot names secret fields by label and keeps ordinary values', () => {
  const {elements} = run(SNAPSHOT, pagePieces());
  const text = elements.map(e => e.text).join('|');
  assert.doesNotMatch(text, /hunter22|482913/);
  assert.match(text, /red shoes/);
  assert.match(text, /Pay now/);
  assert.equal(elements[0].text, 'pw', 'a password field is named by its name, not what is typed in it');
});

test('a secret field whose own label holds its value never shows that value', () => {
  const page = pagePieces({pw: {attrs: {'aria-label': 'Password hunter22'}}});
  const {elements} = run(SNAPSHOT, page);
  assert.equal(elements[0].text, 'Password [hidden]');
  assert.doesNotMatch(JSON.stringify(elements), /hunter22/);
  // The same label read by the click guard: the page's words still classify, but the reason hides the secret.
  page.all[0].getAttribute = n => ({'aria-label': 'Pay with hunter22'})[n] ?? null;
  const r = run(actionExpression({op: 'click', index: 1}, []), page);
  assert.equal(r.ok, false);
  assert.equal(r.risk, 'spend', 'hiding the secret in the reason does not hide the risk');
  assert.doesNotMatch(JSON.stringify(r), /hunter22/);
});

test('page text hides a secret wherever it appears', () => {
  assert.equal(run(MAIN_TEXT, pagePieces()), 'Signed in as ada. Code [hidden] sent.');
});

test('read hides secrets and riskGuard still sees Pay now as a payment', () => {
  const page = pagePieces();
  page.body.textContent = 'Signed in as ada. Code 482913 sent.';
  const read = run(actionExpression({op: 'read', selector: 'body'}), page);
  assert.doesNotMatch(JSON.stringify(read), /482913/);
  assert.equal(read.text, 'Signed in as ada. Code [hidden] sent.');
  const r = run(actionExpression({op: 'click', index: 4}, []), page);
  assert.equal(r.ok, false);
  assert.equal(r.risk, 'spend');
  assert.doesNotMatch(r.reason, /hunter22|482913/);
});

test('a bot cannot type into a secret field, whatever was approved', () => {
  for (const approved of [[], ['send@https://shop.example', 'post@https://shop.example', 'spend@https://shop.example']]) {
    for (const index of [1, 2]) {
      const r = run(actionExpression({op: 'type', index, text: 'guess'}, approved), pagePieces());
      assert.equal(r.ok, false);
      assert.equal(r.reason, REFUSAL);
    }
  }
});

test('a bot still types into an ordinary field, and a person into a secret one', () => {
  const page = pagePieces();
  const ok = run(actionExpression({op: 'type', index: 3, text: 'blue shoes'}, ['send@https://shop.example']), page);
  assert.equal(ok.ok, true);
  assert.equal(page.all[2].value, 'blue shoes');
  const person = run(actionExpression({op: 'type', index: 1, text: 'new-pass'}, [], {person: true}), page);
  assert.equal(person.ok, true, 'a person typing is not a bot, so the owner may sign in');
  assert.equal(page.all[0].value, 'new-pass');
});

test('a caller that leaves out who is acting gets the bot rules, not the person ones', () => {
  for (const args of [[], [undefined], [null], [[]], [[], {}], [[], {person: false}], [[], {person: 'yes'}]]) {
    const page = pagePieces();
    const r = run(actionExpression({op: 'type', index: 1, text: 'guess'}, ...args), page);
    assert.equal(r.ok, false, JSON.stringify(args));
    assert.equal(r.reason, REFUSAL, JSON.stringify(args));
    assert.equal(page.all[0].value, 'hunter22', 'nothing was written');
  }
  // A click with no argument is also a bot's: a payment nobody approved is refused.
  const pay = run(actionExpression({op: 'click', index: 4}), pagePieces());
  assert.equal(pay.ok, false);
  assert.equal(pay.risk, 'spend');
});

const OWNER = {person: true};
const NEEDS_FIELD = 'Choose a text field first.';

test('a secret type into a button, a checkbox or anything that is not text entry is refused before anything is written', () => {
  for (const c of [{type: 'submit', value: 'Pay now'}, {type: 'button', value: 'Go'}, {type: 'reset', value: 'Clear'}, {type: 'image', value: 'Pay'}, {type: 'checkbox', value: 'on'}, {type: 'radio', value: 'a'}]) {
    const attrs = {};
    const target = el({...c, attrs});
    const page = {...pagePieces(), all: [target]};
    const r = run(actionExpression({op: 'type', index: 1, text: 'hunter22', secret: true}, [], OWNER), page);
    assert.equal(r.ok, false, c.type);
    assert.equal(r.reason, NEEDS_FIELD, c.type);
    assert.doesNotMatch(JSON.stringify(r), /hunter22/);
    assert.equal(target.value, c.value, `${c.type}: its value is unchanged`);
    assert.equal('data-agent-secret' in attrs, false, `${c.type}: and it is not tagged`);
  }
  // A div that is not editable has no value to type into either.
  const div = el({tagName: 'DIV', innerText: 'Hello'});
  const r = run(actionExpression({op: 'type', index: 1, text: 'x', secret: true}, [], OWNER), {...pagePieces(), all: [div]});
  assert.deepEqual([r.ok, r.reason], [false, NEEDS_FIELD]);
  assert.equal(div.textContent, 'Hello');
});

test('a secret type into a text field tags it before the value is written, in the same evaluation', () => {
  for (const c of [{tagName: 'INPUT', type: 'text', value: ''}, {tagName: 'TEXTAREA', value: ''}, {tagName: 'INPUT', type: 'search', value: ''}]) {
    const attrs = {}, writes = [];
    const target = el({...c, attrs});
    let stored = '';
    Object.defineProperty(target, 'value', {get: () => stored, set: v => { writes.push('data-agent-secret' in attrs); stored = v; }, enumerable: true});
    const r = run(actionExpression({op: 'type', index: 1, text: '482913', secret: true}, [], OWNER), {...pagePieces(), all: [target]});
    assert.equal(r.ok, true);
    assert.equal(stored, '482913');
    assert.deepEqual(writes, [true], 'the tag was already there when the value went in');
    assert.equal(attrs['data-agent-secret'], '1');
  }
  // A contenteditable has no value: its text is written, after the tag.
  const attrs = {};
  const editable = el({tagName: 'DIV', innerText: '', attrs});
  editable.isContentEditable = true;
  let written = null;
  Object.defineProperty(editable, 'textContent', {get: () => '', set: v => { written = ['data-agent-secret' in attrs, v]; }});
  assert.equal(run(actionExpression({op: 'type', index: 1, text: '482913', secret: true}, [], OWNER), {...pagePieces(), all: [editable]}).ok, true);
  assert.deepEqual(written, [true, '482913']);
});

test('a plain type into a field that is already secret keeps it tagged, and into any other field tags nothing', () => {
  const page = pagePieces();
  assert.equal(run(actionExpression({op: 'type', index: 1, text: 'new-pass'}, [], OWNER), page).ok, true);
  assert.equal(page.all[0].getAttribute('data-agent-secret'), '1', 'a password field is tagged for good');
  const other = run(actionExpression({op: 'type', index: 3, text: 'blue shoes'}, [], OWNER), page);
  assert.equal(other.ok, true);
  assert.equal(page.all[2].getAttribute('data-agent-secret'), null);
  // A plain type into a button is the owner's business and stays as it was: nothing is tagged.
  const attrs = {};
  const button = el({type: 'submit', value: 'Pay now', attrs});
  assert.equal(run(actionExpression({op: 'type', index: 1, text: 'x'}, [], OWNER), {...pagePieces(), all: [button]}).ok, true);
  assert.equal('data-agent-secret' in attrs, false);
});

test('a bot step carries no tag logic and cannot ask for one', () => {
  const page = pagePieces();
  const r = run(actionExpression({op: 'type', index: 3, text: 'blue', secret: true}, ['send@https://shop.example']), page);
  assert.equal(r.ok, true);
  assert.equal(page.all[2].getAttribute('data-agent-secret'), null, 'secret:true from a bot step is ignored');
});

test('the page read hides a secret in the title, the links, the address and the page text', () => {
  const links = [
    {innerText: 'Reset password hunter22 now', href: 'https://shop.example/reset?pw=hunter22'},
    {innerText: 'Plain link about shoes', href: 'https://shop.example/shoes'},
  ];
  const href = 'https://shop.example/pay?token=482913&x=1';
  const page = pagePieces();
  const out = JSON.parse(run(LOOK, page, {href, title: 'Welcome hunter22', links}));
  const shown = JSON.stringify({title: out.title, links: out.links, shown: out.shown, text: out.text, snapshot: out.snapshot});
  assert.doesNotMatch(shown, /hunter22|482913/);
  assert.equal(out.title, 'Welcome [hidden]');
  assert.equal(out.shown, 'https://shop.example/pay?token=[hidden]&x=1', 'the address stays an address, with only the value hidden');
  assert.deepEqual(out.links, [{text: 'Reset password [hidden] now', url: 'https://shop.example/reset?pw=[hidden]'}, {text: 'Plain link about shoes', url: 'https://shop.example/shoes'}]);
  assert.equal(out.url, href, 'the real address is kept for the device to decide with, and is not sent on');
  assert.match(out.text, /Code \[hidden\] sent/);
  assert.ok(Array.isArray(out.snapshot.elements));
});

test('the click guard hides a secret in the link address it quotes', () => {
  const page = pagePieces();
  const link = el({tagName: 'A', innerText: 'Go on', attrs: {href: '/unsubscribe?pw=hunter22'}});
  link.href = 'https://shop.example/unsubscribe?pw=hunter22';
  link.closest = sel => (sel === 'a[href]' ? link : (sel === '[data-agent-secret]' || sel === 'form' || sel === 'a[target]' ? null : link));
  page.all.push(link);
  const r = run(actionExpression({op: 'click', index: page.all.length}, []), page);
  assert.equal(r.ok, false);
  assert.match(r.reason, /This link goes to/);
  assert.doesNotMatch(JSON.stringify(r), /hunter22/);
  assert.match(r.reason, /pw=\[hidden\]/);
});
