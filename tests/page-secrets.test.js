import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {isSecretField, isTextEntry, labelOf, hideSecrets, PAGE_SECRETS_JS, scrubTyped, clearSecrets, CLEAR_SECRETS_AFTER_CLICK_JS, CLEAR_SECRETS_AFTER_ENTER_JS, CLEAR_SECRETS_ON_HANDBACK_JS, clearAfterSubmitJS} from '../agent/page-secrets.mjs';

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

test('hiding matches whatever case the page echoes, and keeps the page\'s own letters elsewhere', () => {
  const pw = field({type: 'password', value: 'Hunter22'});
  assert.equal(hideSecrets('Echo: HUNTER22 and hunter22 and Hunter22, but Hunters stay', [pw]), 'Echo: [hidden] and [hidden] and [hidden], but Hunters stay');
  // A value with regex characters is matched as the letters it is, not as a pattern.
  const odd = field({type: 'password', value: 'a.c+(d)'});
  assert.equal(hideSecrets('abc and A.C+(D) and a.c+(d)', [odd]), 'abc and [hidden] and [hidden]');
  // A character whose upper case is longer must not shift the ranges.
  const sharp = field({type: 'password', value: 'straße-1'});
  assert.equal(hideSecrets('x straße-1 y', [sharp]), 'x [hidden] y');
});

test('only a text-entry control can be typed into as a secret', () => {
  const yes = [{tagName: 'INPUT', type: 'text'}, {tagName: 'INPUT', type: 'password'}, {tagName: 'INPUT', type: ''}, {tagName: 'INPUT', type: 'search'},
    {tagName: 'INPUT', type: 'email'}, {tagName: 'INPUT', type: 'number'}, {tagName: 'TEXTAREA'}, {tagName: 'DIV', isContentEditable: true}];
  const no = [...['submit', 'button', 'reset', 'image', 'checkbox', 'radio', 'file', 'range', 'color'].map(type => ({tagName: 'INPUT', type})),
    {tagName: 'SELECT'}, {tagName: 'DIV'}, {tagName: 'MAIN'}, {tagName: 'BUTTON'}, {tagName: 'A'}, {tagName: 'BODY'}];
  for (const c of yes) assert.equal(isTextEntry(field(c)), true, JSON.stringify(c));
  for (const c of no) assert.equal(isTextEntry(field(c)), false, JSON.stringify(c));
  assert.equal(isTextEntry(field({tagName: 'INPUT', type: 'SUBMIT'})), false, 'type is read in lower case');
  // It is one of the functions the page receives.
  assert.match(PAGE_SECRETS_JS, /function isTextEntry/);
});

/* What the owner typed is scrubbed from every result by value: it runs in Node over plain objects. */

test('scrubTyped hides a typed string in any letter case, and leaves everything else alone', () => {
  const out = scrubTyped({title: 'Welcome HUNTER22', text: 'hunter22 and Hunter22 and hunters', note: 'nothing'}, ['hunter22']);
  assert.deepEqual(out, {title: 'Welcome [hidden]', text: '[hidden] and [hidden] and hunters', note: 'nothing'});
});

test('scrubTyped hides the percent-encoded and form-encoded spellings, in an address or a sentence that quotes one', () => {
  const typed = ['p@ss word!'];
  const url = 'https://site.example/login?err=1&user_pw=p%40ss%20word!&again=p%40ss+word%21';
  assert.equal(scrubTyped({url}, typed).url, 'https://site.example/login?err=1&user_pw=[hidden]&again=[hidden]');
  assert.equal(scrubTyped({finalUrl: '/next?x=P%40SS%20WORD!'}, typed).finalUrl, '/next?x=[hidden]', 'a relative address and any hex case');
  assert.equal(scrubTyped({text: 'Redirecting to https://s.example/?pw=p%40ss%20word! now', readText: 'p%40ss+word%21'}, typed).text, 'Redirecting to https://s.example/?pw=[hidden] now');
  assert.equal(scrubTyped({readText: 'p%40ss+word%21'}, typed).readText, '[hidden]');
  assert.equal(scrubTyped({text: 'p@ss word!'}, typed).text, '[hidden]');
});

test('scrubTyped ignores a value under 3 characters, empty values and things that are not strings', () => {
  const input = {text: 'ab 12 abc'};
  assert.deepEqual(scrubTyped(input, ['ab', '12', '', null, undefined, 7, {}]), input);
  assert.deepEqual(scrubTyped(input, ['abc']), {text: 'ab 12 [hidden]'});
  assert.deepEqual(scrubTyped(input, undefined), input);
  assert.deepEqual(scrubTyped(input, new Set()), input);
  assert.equal(scrubTyped('abc', ['abc']), '[hidden]', 'a bare string too');
  assert.equal(scrubTyped(null, ['abc']), null);
});

test('scrubTyped goes into every nested string: links, elements, actions, readText', () => {
  const result = {
    url: 'https://a.example/?q=Planted-9', finalUrl: 'https://a.example/?q=planted-9', title: 'T planted-9', excerpt: 'e PLANTED-9', text: 't planted-9', readText: 'r planted-9',
    links: [{text: 'go planted-9', url: 'https://a.example/r?c=planted-9'}, {href: '/x?planted-9'}],
    elements: [{index: 1, tag: 'input', text: 'Code planted-9', type: 'text'}, {index: 2, tag: 'a', deep: {label: ['planted-9']}}],
    actions: [{op: 'read', ok: true, text: 'echo planted-9', reason: ''}], elementCount: 2, ok: true,
  };
  const out = scrubTyped(result, ['planted-9']);
  assert.doesNotMatch(JSON.stringify(out), /planted-9/i);
  assert.equal(out.links[1].href, '/x?[hidden]');
  assert.deepEqual(out.elements[1].deep.label, ['[hidden]']);
  assert.equal(out.elementCount, 2);
  assert.equal(out.elements[0].index, 1, 'numbers and booleans are kept');
  assert.equal(out.ok, true);
});

test('scrubTyped never changes its input and returns a copy', () => {
  const input = {text: 'planted-9', links: [{text: 'planted-9'}], elements: [{text: 'planted-9'}]};
  const before = JSON.stringify(input);
  const out = scrubTyped(input, ['planted-9']);
  assert.equal(JSON.stringify(input), before);
  assert.notEqual(out, input);
  assert.notEqual(out.links, input.links);
  assert.notEqual(out.links[0], input.links[0]);
  // No match is still a copy, so a caller can never get the page's own object back.
  const same = scrubTyped(input, ['nomatch']);
  assert.deepEqual(same, input);
  assert.notEqual(same.links[0], input.links[0]);
});

test('scrubTyped merges overlapping remembered strings in one pass, and never cuts the marker', () => {
  assert.equal(scrubTyped({text: 'is abcdef ok'}, ['abcd', 'cdef']).text, 'is [hidden] ok');
  assert.equal(scrubTyped({text: 'is abcdef ok'}, ['cdef', 'abcd']).text, 'is [hidden] ok');
  assert.equal(scrubTyped({text: 'abcdef'}, ['abc', 'def']).text, '[hidden]', 'touching ranges are one');
  assert.equal(scrubTyped({text: 'x aaaaa y'}, ['aaaa']).text, 'x [hidden] y', 'one value at overlapping places is one run');
  assert.equal(scrubTyped({text: 'hunter22 and hid'}, ['hunter22', 'hid']).text, '[hidden] and [hidden]');
  assert.equal(scrubTyped({text: 'a.c+(d) and abc'}, ['a.c+(d)']).text, '[hidden] and abc', 'regex characters are letters');
  assert.equal(scrubTyped({text: 'x straße-1 y'}, ['straße-1']).text, 'x [hidden] y');
});

test('scrubTyped leaves a picture alone, since a match inside it would only damage it', () => {
  const image = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ';
  assert.equal(scrubTyped({image, text: 'JRg'}, ['JRg']).image, image);
  assert.equal(scrubTyped({image, text: 'JRg'}, ['JRg']).text, '[hidden]');
});

/** A fake page for the clearing expressions: fields with a value, a form, the focus. */
function fakePage({active, fields}) {
  const timers = [];
  const make = f => {
    const el = {tagName: 'INPUT', type: 'text', value: '', attrs: {}, isContentEditable: false, ...f, removed: [],
      getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; },
      removeAttribute(n) { this.removed.push(n); delete this.attrs[n]; },
      closest(sel) { return sel === '[data-agent-secret]' && 'data-agent-secret' in this.attrs ? this : sel === 'form' ? this.form || null : null; },
      matches(sel) { return Boolean(this.submit) && sel.includes('button[type=submit]'); }};
    return el;
  };
  const els = fields.map(make);
  const form = {tagName: 'FORM', querySelectorAll: () => els.filter(e => e.form === form)};
  for (const e of els) if (e.inForm) e.form = form;
  const doc = {querySelectorAll: () => els, activeElement: active === undefined ? null : els[active]};
  const run = expression => vm.runInNewContext(expression, {document: doc, setTimeout: (fn, ms) => { timers.push({fn, ms}); return timers.length; }});
  return {els, form, doc, run, timers, fire: () => timers.splice(0).forEach(t => t.fn())};
}

test('clearSecrets empties each secret field and its value attribute, and nothing else', () => {
  const page = fakePage({fields: [{type: 'password', value: 'hunter22', attrs: {value: 'hunter22'}}, {type: 'text', value: 'ada'}, {tagName: 'DIV', value: undefined, isContentEditable: true, textContent: 'abc', attrs: {'data-agent-secret': ''}}]});
  const [pw, user, editable] = page.els;
  const count = vm.runInNewContext(`${PAGE_SECRETS_JS};${clearSecrets};clearSecrets(document, 0)`, {document: page.doc});
  assert.equal(count, 2);
  assert.equal(pw.value, '');
  assert.deepEqual(pw.removed, ['value']);
  assert.equal(user.value, 'ada', 'an ordinary field is left alone');
  assert.equal(editable.textContent, '');
});

test('the hand back expression empties every secret field of the page at once', () => {
  const page = fakePage({fields: [{type: 'password', value: 'hunter22'}, {type: 'text', value: 'ada'}]});
  assert.equal(page.run(CLEAR_SECRETS_ON_HANDBACK_JS), 1);
  assert.equal(page.els[0].value, '');
  assert.equal(page.els[1].value, 'ada');
  assert.equal(page.timers.length, 0, 'now, not later');
});

test('after a click only a submit control that has the focus empties its form, and only later and only if unchanged', () => {
  const fields = [{type: 'password', value: 'hunter22', inForm: true}, {type: 'text', value: 'ada', inForm: true}, {tagName: 'BUTTON', type: 'submit', submit: true, inForm: true, value: ''}, {type: 'password', value: 'other-pass'}];
  // A click that left the focus in the password field is a click into a field, not a submit.
  let page = fakePage({active: 0, fields});
  assert.equal(page.run(CLEAR_SECRETS_AFTER_CLICK_JS), 0);
  assert.equal(page.els[0].value, 'hunter22');
  // The submit control has the focus: its form's secret is emptied after the delay, and not another form's.
  page = fakePage({active: 2, fields});
  assert.equal(page.run(CLEAR_SECRETS_AFTER_CLICK_JS), 1);
  assert.equal(page.els[0].value, 'hunter22', 'not yet: a script may still read it');
  assert.ok(page.timers[0].ms > 0);
  page.fire();
  assert.equal(page.els[0].value, '');
  assert.equal(page.els[3].value, 'other-pass');
  // A person who retyped it meanwhile keeps what they typed.
  page = fakePage({active: 2, fields});
  page.run(CLEAR_SECRETS_AFTER_CLICK_JS);
  page.els[0].value = 'retyped-pass';
  page.fire();
  assert.equal(page.els[0].value, 'retyped-pass');
  // Nothing focused is nothing to clear.
  assert.equal(fakePage({fields}).run(CLEAR_SECRETS_AFTER_CLICK_JS), 0);
});

test('after Enter the focused input\'s form is emptied, a formless secret field empties itself, a textarea does not submit', () => {
  const inForm = [{type: 'password', value: 'hunter22', inForm: true}, {type: 'text', value: 'ada', inForm: true}];
  const page = fakePage({active: 1, fields: inForm});
  assert.equal(page.run(CLEAR_SECRETS_AFTER_ENTER_JS), 1);
  page.fire();
  assert.equal(page.els[0].value, '');
  const loose = fakePage({active: 0, fields: [{type: 'password', value: 'hunter22'}, {type: 'text', value: 'ada'}]});
  assert.equal(loose.run(CLEAR_SECRETS_AFTER_ENTER_JS), 1);
  loose.fire();
  assert.equal(loose.els[0].value, '');
  assert.equal(loose.els[1].value, 'ada');
  const area = fakePage({active: 0, fields: [{tagName: 'TEXTAREA', value: 'hunter22', attrs: {'data-agent-secret': ''}}]});
  assert.equal(area.run(CLEAR_SECRETS_AFTER_ENTER_JS), 0, 'Enter in a textarea is a new line');
  // Enter in a loose ordinary field with no form submits nothing.
  const plain = fakePage({active: 1, fields: [{type: 'password', value: 'hunter22'}, {type: 'text', value: 'ada'}]});
  assert.equal(plain.run(CLEAR_SECRETS_AFTER_ENTER_JS), 0);
});

test('the server runtime\'s click clears the form of a submit control it clicked, and does nothing for any other element', () => {
  const page = fakePage({fields: [{type: 'password', value: 'hunter22', inForm: true}, {tagName: 'BUTTON', submit: true, inForm: true}, {tagName: 'A'}]});
  const [, button, link] = page.els;
  button.closest = sel => (sel.includes('button[type=submit]') ? button : sel === 'form' ? page.form : null);
  link.closest = () => null;
  const statement = el => vm.runInNewContext(`(()=>{const el=this.el;${clearAfterSubmitJS('el')}})()`, {el, setTimeout: (fn, ms) => { page.timers.push({fn, ms}); return 1; }, document: page.doc});
  statement(link);
  assert.equal(page.timers.length, 0, 'a link is not a submit control');
  statement(button);
  page.fire();
  assert.equal(page.els[0].value, '');
});
