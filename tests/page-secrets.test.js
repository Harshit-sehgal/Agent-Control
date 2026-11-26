import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {isSecretField, labelOf, hideSecrets, PAGE_SECRETS_JS} from '../agent/page-secrets.mjs';

/** A fake page element with the few members the functions read. */
function field({tagName = 'INPUT', type = '', value, innerText, isContentEditable = false, labels, attrs = {}, taggedAncestor = false}) {
  const el = {
    tagName, type, isContentEditable, labels,
    getAttribute: name => (name in attrs ? attrs[name] : null),
    closest: sel => (sel === '[data-agent-secret]' && (taggedAncestor || 'data-agent-secret' in attrs) ? el : null),
  };
  if (value !== undefined) el.value = value;
  if (innerText !== undefined) el.innerText = innerText;
  return el;
}

test('password, code and card fields are secret; a tagged field and its children are secret', () => {
  assert.equal(isSecretField(field({tagName: 'INPUT', type: 'password'})), true);
  assert.equal(isSecretField(field({tagName: 'INPUT', type: 'text', attrs: {autocomplete: 'one-time-code'}})), true);
  assert.equal(isSecretField(field({tagName: 'INPUT', type: 'text', attrs: {autocomplete: 'billing cc-number'}})), true);
  assert.equal(isSecretField(field({tagName: 'INPUT', type: 'text', taggedAncestor: true})), true);
  assert.equal(isSecretField(field({tagName: 'INPUT', type: 'search'})), false);
  assert.equal(isSecretField(field({tagName: 'TEXTAREA'})), false);
});

test('every listed autocomplete token is secret, in any case, and others are not', () => {
  for (const token of ['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year']) {
    assert.equal(isSecretField(field({type: 'text', attrs: {autocomplete: token}})), true, token);
    assert.equal(isSecretField(field({type: 'text', attrs: {autocomplete: `Section-x ${token.toUpperCase()}`}})), true, `${token} upper`);
  }
  for (const token of ['off', 'email', 'username', 'cc-name', 'cc-type', 'name cc-given-name', '']) {
    assert.equal(isSecretField(field({type: 'text', attrs: {autocomplete: token}})), false, token);
  }
  // A token is matched whole: a longer word containing one is not a match.
  assert.equal(isSecretField(field({type: 'text', attrs: {autocomplete: 'not-cc-number'}})), false);
});

test('the tag marks the field itself and anything inside a tagged ancestor, including a contenteditable', () => {
  assert.equal(isSecretField(field({tagName: 'INPUT', type: 'text', attrs: {'data-agent-secret': ''}})), true);
  assert.equal(isSecretField(field({tagName: 'DIV', isContentEditable: true, taggedAncestor: true})), true);
  assert.equal(isSecretField(field({tagName: 'DIV', isContentEditable: true})), false);
});

test('a secret field is named by its label, never by what is in it', () => {
  assert.equal(labelOf(field({tagName: 'INPUT', type: 'password', value: 'hunter22', attrs: {'aria-label': 'Password'}})), 'Password');
  assert.equal(labelOf(field({tagName: 'INPUT', type: 'password', value: 'hunter22'})), 'password field');
  assert.equal(labelOf(field({tagName: 'INPUT', type: 'search', value: 'red shoes'})), 'red shoes');
  assert.equal(labelOf(field({tagName: 'INPUT', type: 'submit', value: 'Pay now'})), 'Pay now');
});

test('a secret field is named by aria-label, then its first label, then placeholder, then name, then a generic word', () => {
  const secret = {type: 'text', value: 'hunter22', innerText: 'hunter22', attrs: {autocomplete: 'one-time-code'}};
  const named = (extra, attrs = {}) => labelOf(field({...secret, ...extra, attrs: {...secret.attrs, ...attrs}}));
  const labels = [{innerText: '  Your   code\n'}, {innerText: 'Second'}];
  assert.equal(named({labels}, {'aria-label': 'Aria', placeholder: 'Ph', name: 'nm'}), 'Aria');
  assert.equal(named({labels}, {placeholder: 'Ph', name: 'nm'}), 'Your code');
  assert.equal(named({labels: []}, {placeholder: 'Ph', name: 'nm'}), 'Ph');
  assert.equal(named({}, {name: 'nm'}), 'nm');
  assert.equal(named({}), 'secret field');
  assert.equal(labelOf(field({type: 'password', value: 'hunter22', labels: []})), 'password field');
  // A tagged ordinary field is a secret field too, and never shows its value.
  assert.equal(labelOf(field({type: 'text', value: 'my diary', taggedAncestor: true})), 'secret field');
  assert.equal(labelOf(field({tagName: 'DIV', isContentEditable: true, innerText: 'my diary', taggedAncestor: true})), 'secret field');
});

test('other elements keep their naming: text, value, aria-label, placeholder, name', () => {
  assert.equal(labelOf(field({tagName: 'BUTTON', innerText: ' Save \n changes ', value: 'x'})), 'Save changes');
  assert.equal(labelOf(field({type: 'text', attrs: {'aria-label': 'Search', placeholder: 'Find'}})), 'Search');
  assert.equal(labelOf(field({type: 'text', attrs: {placeholder: 'Find', name: 'q'}})), 'Find');
  assert.equal(labelOf(field({type: 'text', attrs: {name: 'q'}})), 'q');
});

test('every occurrence of a secret is hidden from page text, and short values are left alone', () => {
  const pw = field({tagName: 'INPUT', type: 'password', value: 'hunter22'});
  assert.equal(hideSecrets('Your password hunter22 was saved. hunter22', [pw]), 'Your password [hidden] was saved. [hidden]');
  assert.equal(hideSecrets('a b', [field({tagName: 'INPUT', type: 'password', value: 'a'})]), 'a b');
});

test('hiding reads a contenteditable secret from innerText, skips other fields, and hides the longest value first', () => {
  const code = field({tagName: 'DIV', isContentEditable: true, innerText: '123456', taggedAncestor: true});
  const plain = field({tagName: 'INPUT', type: 'text', value: 'red shoes'});
  assert.equal(hideSecrets('code 123456, search red shoes', [code, plain]), 'code [hidden], search red shoes');
  const short = field({type: 'password', value: 'abc'});
  const long = field({type: 'password', value: 'abcdef'});
  assert.equal(hideSecrets('abcdef and abc', [short, long]), '[hidden] and [hidden]');
  assert.equal(hideSecrets('ab', [field({type: 'password', value: 'ab'})]), 'ab');
  assert.equal(hideSecrets('abc', [field({type: 'password', value: 'abc'})]), '[hidden]');
  assert.equal(hideSecrets('nothing here', [field({type: 'password', value: ''}), field({type: 'password'})]), 'nothing here');
  assert.equal(hideSecrets('text', []), 'text');
});

test('the whole token matrix is secret to all three functions', () => {
  const kinds = ['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year'];
  const cases = [
    ...kinds.flatMap(k => [k, k.toUpperCase(), `section-a ${k}`].map(autocomplete => ({type: 'text', attrs: {autocomplete}}))),
    {type: 'PASSWORD', attrs: {}}, {type: 'password', attrs: {}}, {type: 'text', attrs: {'data-agent-secret': ''}},
  ];
  for (const c of cases) {
    const el = field({tagName: 'INPUT', value: 'secret-value', ...c});
    assert.equal(isSecretField(el), true, JSON.stringify(c));
    assert.doesNotMatch(labelOf(el), /secret-value/, JSON.stringify(c));
    assert.equal(hideSecrets('x secret-value x', [el]), 'x [hidden] x', JSON.stringify(c));
  }
  const plain = field({tagName: 'INPUT', type: 'text', value: 'secret-value'});
  assert.equal(labelOf(plain), 'secret-value');
  assert.equal(hideSecrets('x secret-value x', [plain]), 'x secret-value x');
});

test('only form fields can be secret: a button keeps its own label', () => {
  const pay = field({tagName: 'INPUT', type: 'submit', value: 'Pay now', attrs: {autocomplete: 'cc-csc'}});
  assert.equal(isSecretField(pay), false);
  assert.equal(labelOf(pay), 'Pay now');
  for (const type of ['button', 'reset', 'image']) assert.equal(isSecretField(field({type, attrs: {autocomplete: 'cc-csc'}})), false, type);
  const button = field({tagName: 'BUTTON', innerText: 'Pay now', taggedAncestor: true});
  assert.equal(isSecretField(button), false);
  assert.equal(labelOf(button), 'Pay now');
  assert.equal(hideSecrets('Pay now', [pay, button]), 'Pay now');
  for (const tagName of ['TEXTAREA', 'SELECT']) assert.equal(isSecretField(field({tagName, taggedAncestor: true})), true, tagName);
});

test('hiding is one pass: a secret cannot mangle the marker, and overlapping secrets leave nothing visible', () => {
  const pw = field({type: 'password', value: 'hunter22'});
  const hid = field({type: 'password', value: 'hid'});
  assert.equal(hideSecrets('hunter22 and hid', [pw, hid]), '[hidden] and [hidden]');
  assert.equal(hideSecrets('hunter22 and hid', [hid, pw]), '[hidden] and [hidden]');
  const a = field({type: 'password', value: 'abcd'});
  const b = field({type: 'password', value: 'cdef'});
  assert.equal(hideSecrets('is abcdef ok', [a, b]), 'is [hidden] ok');
  assert.equal(hideSecrets('is abcdef ok', [b, a]), 'is [hidden] ok');
  // One value found at overlapping places ("aaaa" twice in "aaaaa") is one hidden run.
  assert.equal(hideSecrets('x aaaaa y', [field({type: 'password', value: 'aaaa'})]), 'x [hidden] y');
});

test('a contenteditable secret is trimmed before matching, a password value is not', () => {
  const code = field({tagName: 'DIV', isContentEditable: true, innerText: '123456\n', taggedAncestor: true});
  assert.equal(hideSecrets('Code 123456 sent', [code]), 'Code [hidden] sent');
  const padded = field({type: 'password', value: ' abc '});
  assert.equal(hideSecrets('x abc y', [padded]), 'x[hidden]y');
  assert.equal(hideSecrets('x abc y', [field({type: 'password', value: 'abc'})]), 'x [hidden] y');
  assert.equal(hideSecrets('x  abc  y', [padded]), 'x [hidden] y');
});

test('the embedded bundle declares the three functions and they work together', () => {
  const ctx = {el: field({type: 'password', value: 'hunter22'})};
  vm.runInNewContext(`${PAGE_SECRETS_JS};this.ok=typeof isSecretField+typeof labelOf+typeof hideSecrets;this.a=isSecretField(el);this.b=labelOf(el);this.c=hideSecrets('pw hunter22',[el])`, ctx);
  assert.equal(ctx.ok, 'functionfunctionfunction');
  assert.deepEqual([ctx.a, ctx.b, ctx.c], [true, 'password field', 'pw [hidden]']);
});
