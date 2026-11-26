import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {SNAPSHOT, MAIN_TEXT, actionExpression} from '../agent/browser.mjs';

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

function run(script, {all, body}) {
  const document = {
    body,
    querySelectorAll: () => all,
    querySelector: sel => {
      const m = /^\[data-agent-index="(\d+)"\]$/.exec(sel);
      if (m) return all[Number(m[1]) - 1] || null;
      return sel === 'body' ? body : null;
    },
  };
  return vm.runInNewContext(script, {document, getComputedStyle: () => ({visibility: 'visible', display: 'block'}), location: {origin: 'https://shop.example', href: 'https://shop.example/pay', pathname: '/pay'}, URL, Event: class { constructor(type) { this.type = type; } }});
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

test('a bot still types into an ordinary field, and a person (no approvals) into a secret one', () => {
  const page = pagePieces();
  const ok = run(actionExpression({op: 'type', index: 3, text: 'blue shoes'}, ['send@https://shop.example']), page);
  assert.equal(ok.ok, true);
  assert.equal(page.all[2].value, 'blue shoes');
  const person = run(actionExpression({op: 'type', index: 1, text: 'new-pass'}), page);
  assert.equal(person.ok, true, 'a person typing is not a bot, so the owner may sign in');
  assert.equal(page.all[0].value, 'new-pass');
});
