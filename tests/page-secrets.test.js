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

test('the three functions agree on what is secret', () => {
  const cases = [
    field({type: 'password', value: 'secret-value'}),
    field({type: 'text', value: 'secret-value', attrs: {autocomplete: 'cc-csc'}}),
    field({type: 'text', value: 'secret-value', taggedAncestor: true}),
    field({type: 'text', value: 'secret-value'}),
    field({tagName: 'TEXTAREA', value: 'secret-value'}),
  ];
  for (const el of cases) {
    const secret = isSecretField(el);
    assert.equal(hideSecrets('x secret-value x', [el]) !== 'x secret-value x', secret);
    assert.equal(labelOf(el).includes('secret-value'), !secret);
  }
});

test('the embedded script declares the same functions', () => {
  const ctx = {}; vm.runInNewContext(`${PAGE_SECRETS_JS};this.ok=typeof isSecretField+typeof labelOf+typeof hideSecrets`, ctx);
  assert.equal(ctx.ok, 'functionfunctionfunction');
});

test('each function works alone, with nothing else from the module in scope', () => {
  const ctx = {el: field({type: 'password', value: 'hunter22'})};
  vm.runInNewContext(`this.a=(${isSecretField.toString()})(el);this.b=(${labelOf.toString()})(el);this.c=(${hideSecrets.toString()})('hunter22',[el])`, ctx);
  assert.deepEqual([ctx.a, ctx.b, ctx.c], [true, 'password field', '[hidden]']);
});
