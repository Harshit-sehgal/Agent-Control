# Phase 0: secrets never reach a model — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A password, a one-time code or a card number, whether typed by the owner during a takeover or already in a field, never reaches a model, a chat line, a stored result, a log or an error, including after the page navigates and echoes it elsewhere. The owner gets masked Password and Code fields in both takeover screens.

**Architecture:** One set of small page functions decides which fields are **secret** and how a field is named. They are written once in `agent/page-secrets.mjs`, unit-tested in Node, and embedded into the page scripts with `.toString()`, as `foldLabel` is today (`agent/browser.mjs:110`). The device tags a field the owner typed into through a masked field (`data-agent-secret`), so the rule also covers sites whose code fields are plain text inputs. The server accepts `secret` input only over HTTPS or from loopback.

**Tech Stack:** Node ≥ 22, no npm runtime dependencies, `node --test`, `node:vm` for page-script tests, Chrome DevTools Protocol, Playwright smokes (`npm run test:ui`).

**Spec:** `docs/superpowers/specs/2026-11-26-goals-services-teams-design.md`, sections 6.1 and 6.2.

## Global Constraints

- Zero npm runtime dependencies; `shared/` stays browser-safe; any new `shared/` module goes into `shared/assets.js` followed by `npm run build:pages` (none is planned here).
- A field is **secret** when any of these holds: `input[type=password]`; an `autocomplete` token of `current-password`, `new-password`, `one-time-code`, `cc-number`, `cc-csc`, `cc-exp`, `cc-exp-month` or `cc-exp-year`; the attribute `data-agent-secret` on the field or an ancestor.
- A secret field is never named by its `value` or `innerText`. It is named by `aria-label`, then its first `<label>`'s text, then `placeholder`, then `name`, then the words `password field` (for `type=password`) or `secret field`.
- Every other element keeps today's naming (`innerText || value || aria-label || placeholder || name`), so search boxes, drafts and `<input type=submit value="Pay now">` read as now.
- In page text and `read` results, each secret field's content (its `value`, or `innerText` for a contenteditable) is replaced wherever it appears by `[hidden]` when it is at least 3 characters long.
- A bot's own `type` step into a secret field is refused with: `This is a password or code field. The owner signs in; a bot never types there.`
- `secret` input is accepted only when `secureRequest(req)` is true; otherwise 403 with: `Passwords and codes are only sent over HTTPS or from this computer.`
- `secureRequest(req)` is true when any of these holds:
  - `req.socket?.encrypted === true`;
  - `trustProxy()` holds and `x-forwarded-proto` equals `https`;
  - `trustProxy()` does not hold, the peer (`req.socket.remoteAddress`) is `127.0.0.1`, `::1` or `::ffff:127.0.0.1`, the request has no `x-forwarded-for`, `forwarded` or `x-real-ip` header, **and** its `origin` header's host is `localhost`, `127.0.0.1` or `[::1]` (a missing or unparsable `origin` fails).

  A proxy on this host relays other devices' requests from loopback, sometimes with no forwarding header at all (nginx's default `proxy_pass`), and passes the phone's own `Origin` through, so a relayed request is never "this computer". Behind `tailscale serve` or Caddy, the owner sets `TRUST_PROXY=1`. Check during Task 4 that `tailscale serve` sends `x-forwarded-proto`, and write in `DEPLOYMENT.md` what each setup needs. A plain-HTTP proxy must never carry secret input.
- Secret text never appears in a toast, the tray's echo, an activity line, a run record, a log line or an error message.

## Review Focus

1. **A site's one-time-code box is a plain `<input type=text>` with no `autocomplete`.** Expected: once the owner types the code through the masked Code field, the device tags that input and the code is hidden from the snapshot, page text and hand back. Task 3 pins it.
2. **A page echoes a secret elsewhere** (a "show password" span, a confirmation that prints the card's last digits in full). Expected: every occurrence of a 3+ character secret value is `[hidden]` in page text. Task 2 pins it.
3. **The owner types a code into the plain "Type into the page" box** while a password field has focus. Expected: the device treats it as secret anyway, because the focused field is secret. Task 3 pins it.
4. **Plain HTTP from another device on the network, directly or through a proxy on this host.** Expected: 403 for `secret`, while ordinary takeover input keeps working. Task 4 pins it.
5. **A Pay or Send button built as `<input type=submit value="Pay now">`.** Expected: still classified as a payment by `riskGuard`. Task 2 pins it.

---

### Task 1: Page functions that know what is secret

**Files:**
- Create: `agent/page-secrets.mjs`
- Test: `tests/page-secrets.test.js`

**Interfaces:**
- Produces: `isSecretField(el) → boolean`, `labelOf(el) → string`, `hideSecrets(text, fields) → string` (`fields` is an array of elements; it reads each secret one's `value` or `innerText`), `PAGE_SECRETS_JS` (a string that declares all three functions, for embedding). Each function is self-contained: no imports, no module-level names, so `.toString()` works in a page.

- [ ] **Step 1: Write the failing tests** with fake elements (`{tagName, type, value, innerText, isContentEditable, labels, getAttribute, closest}`):

```js
test('password, code and card fields are secret; a tagged field and its children are secret', () => {
  assert.equal(isSecretField(field({tagName: 'INPUT', type: 'password'})), true);
  assert.equal(isSecretField(field({tagName: 'INPUT', type: 'text', attrs: {autocomplete: 'one-time-code'}})), true);
  assert.equal(isSecretField(field({tagName: 'INPUT', type: 'text', attrs: {autocomplete: 'billing cc-number'}})), true);
  assert.equal(isSecretField(field({tagName: 'INPUT', type: 'text', taggedAncestor: true})), true);
  assert.equal(isSecretField(field({tagName: 'INPUT', type: 'search'})), false);
  assert.equal(isSecretField(field({tagName: 'TEXTAREA'})), false);
});

test('a secret field is named by its label, never by what is in it', () => {
  assert.equal(labelOf(field({tagName: 'INPUT', type: 'password', value: 'hunter22', attrs: {'aria-label': 'Password'}})), 'Password');
  assert.equal(labelOf(field({tagName: 'INPUT', type: 'password', value: 'hunter22'})), 'password field');
  assert.equal(labelOf(field({tagName: 'INPUT', type: 'search', value: 'red shoes'})), 'red shoes');
  assert.equal(labelOf(field({tagName: 'INPUT', type: 'submit', value: 'Pay now'})), 'Pay now');
});

test('every occurrence of a secret is hidden from page text, and short values are left alone', () => {
  const pw = field({tagName: 'INPUT', type: 'password', value: 'hunter22'});
  assert.equal(hideSecrets('Your password hunter22 was saved. hunter22', [pw]), 'Your password [hidden] was saved. [hidden]');
  assert.equal(hideSecrets('a b', [field({tagName: 'INPUT', type: 'password', value: 'a'})]), 'a b');
});

test('the embedded script declares the same functions', () => {
  const ctx = {}; vm.runInNewContext(`${PAGE_SECRETS_JS};this.ok=typeof isSecretField+typeof labelOf+typeof hideSecrets`, ctx);
  assert.equal(ctx.ok, 'functionfunctionfunction');
});
```

- [ ] **Step 2: Run it to see it fail.** Run: `node --test tests/page-secrets.test.js`. Expected: FAIL, cannot find module `agent/page-secrets.mjs`.
- [ ] **Step 3: Implement the three functions and `PAGE_SECRETS_JS`** following the Global Constraints exactly. `isSecretField` reads `el.closest('[data-agent-secret]')` for the tag. `hideSecrets` replaces longest values first, with `split(value).join('[hidden]')`.
- [ ] **Step 4: Run it to see it pass.** Run: `node --test tests/page-secrets.test.js`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add agent/page-secrets.mjs tests/page-secrets.test.js && git commit -m "feat: page functions that know which fields are secret"`

---

### Task 2: The page scripts use them

**Files:**
- Modify: `agent/browser.mjs` (`MAIN_TEXT` `:80`, `SNAPSHOT` `:83`, `riskGuard` `words` `:113`, the `type` and `read` cases of `actionExpression` `:128`, `:130`)
- Test: `tests/page-scripts.test.js` (new); `tests/agent-browser.test.js` (one real-browser test)

**Interfaces:**
- Consumes: `PAGE_SECRETS_JS`, from Task 1.
- Produces: `export {SNAPSHOT, MAIN_TEXT, actionExpression}` from `agent/browser.mjs`, for tests only.

- [ ] **Step 1: Write the failing tests.** In `tests/page-scripts.test.js`, run each script with `vm.runInNewContext(script, {document, getComputedStyle: () => ({visibility: 'visible', display: 'block'}), location: {origin: 'https://shop.example', href: 'https://shop.example/pay'}})`. The fake `document.querySelectorAll` returns the test's element list for any selector; `document.querySelector` resolves the selector `targetOf` builds for `index: N` (`agent/browser.mjs:125`) to element N, and `body` to the body; `document.body.innerText` holds the page text. Use a page with `pw` (password, value `hunter22`), `otp` (plain text input tagged `data-agent-secret`, value `482913`), `q` (search, value `red shoes`) and `pay` (`input type=submit value="Pay now"`), and body text `Signed in as ada. Code 482913 sent.`

```js
test('the snapshot names secret fields by label and keeps ordinary values', () => {
  const {elements} = run(SNAPSHOT, page);
  const text = elements.map(e => e.text).join('|');
  assert.doesNotMatch(text, /hunter22|482913/);
  assert.match(text, /red shoes/); assert.match(text, /Pay now/);
});
test('page text hides a secret wherever it appears', () => {
  assert.equal(run(MAIN_TEXT, page), 'Signed in as ada. Code [hidden] sent.');
});
test('read hides secrets and riskGuard still sees Pay now as a payment', () => {
  assert.doesNotMatch(JSON.stringify(run(actionExpression({op: 'read', selector: 'body'}), page)), /482913/);
  const r = run(actionExpression({op: 'click', index: 4}, []), page);
  assert.equal(r.ok, false); assert.equal(r.risk, 'spend');
  assert.doesNotMatch(r.reason, /hunter22|482913/);
});
test('a bot cannot type into a secret field', () => {
  const r = run(actionExpression({op: 'type', index: 1, text: 'guess'}, []), page);
  assert.equal(r.ok, false); assert.match(r.reason, /owner signs in/);
});
```

In `tests/agent-browser.test.js`, add one test in the style of the test at line 128 (skipped with no browser): a local page with `<input type=password value="hunter22">` and `<input autocomplete="one-time-code" value="482913">`; `captureWithBrowser` with a `read` step; assert neither marker is in `JSON.stringify(page)`.
- [ ] **Step 2: Run them to see them fail.** Run: `node --test tests/page-scripts.test.js`. Expected: FAIL (no exports; the secrets are present).
- [ ] **Step 3: Change the scripts.** `SNAPSHOT` names each element with `labelOf(e)`. `MAIN_TEXT` takes today's text and passes it through `hideSecrets(text, [...document.querySelectorAll('input,textarea,[contenteditable],[data-agent-secret]')].filter(isSecretField))`. `riskGuard`'s `words(n)` leaves out `innerText` and `value` when `isSecretField(n)`. `read` returns `hideSecrets(textContent, …)` over the secret fields inside the target. `type` refuses a secret target with the constraint's sentence, checked first, before `riskGuard`, so the refusal is the same whatever was approved. Each script starts with `${PAGE_SECRETS_JS};`. Keep `SNAPSHOT`'s leading `(function(){var els=` and the capture expression's leading `JSON.stringify({url: location.href`, since `tests/fake-cdp.js` recognises them by those prefixes.
- [ ] **Step 4: Run them to see them pass,** then the suite. Run: `node --test tests/page-scripts.test.js tests/agent-browser.test.js tests/shared-browser.test.js && npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "fix: secret fields never reach a bot through the page"`

---

### Task 3: The device tags what the owner typed in secret

**Files:**
- Modify: `agent/live-input.mjs` (`cleanInput`, `:29`), `agent/shared-browser.mjs` (`applyInput`, `:203`), `shared/ui-computer.js` (`coalesce`, `:63`)
- Test: `tests/ui-computer.test.js`, `tests/shared-browser-takeover.test.js`

**Interfaces:**
- Produces: a type event may carry `secret: true`; `cleanInput` keeps it as `secret: true` and drops any other value. Before a secret type, the device runs `document.activeElement?.setAttribute('data-agent-secret','1')` in the tab (skipping `body`, the root and an empty focus). Before any type, it asks the tab whether the focused element `isSecretField`; if so the event is treated as secret.

- [ ] **Step 1: Write the failing tests.**

```js
test('a secret type event never merges with its neighbours', () => {
  const out = coalesce([{type: 'type', text: 'a'}, {type: 'type', text: 'b', secret: true}, {type: 'type', text: 'c'}]);
  assert.deepEqual(out.map(e => [e.text, e.secret === true]), [['a', false], ['b', true], ['c', false]]);
});
test('cleanInput keeps secret only as true, and its errors never carry the text', () => {
  assert.equal(cleanInput({type: 'type', text: 'x', secret: true}).secret, true);
  assert.equal('secret' in cleanInput({type: 'type', text: 'x', secret: 'yes'}), false);
  assert.throws(() => cleanInput({type: 'type', text: 'hunter22'.repeat(300), secret: true}), e => !e.message.includes('hunter22'));
});
```

In `tests/shared-browser-takeover.test.js`, with the fake CDP: take over a bot, send `{type: 'type', text: '482913', secret: true}`, and assert that a `Runtime.evaluate` whose expression contains `data-agent-secret` comes before the `Input.insertText`; then, with the focused-field check hooked to answer `true`, a plain type event is also tagged first.
- [ ] **Step 2: Run them to see them fail.** Run: `node --test tests/ui-computer.test.js tests/shared-browser-takeover.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** `coalesce` never merges when either event has `secret`. `cleanInput` returns `{type: 'type', text, ...(event.secret === true ? {secret: true} : {})}`. `applyInput` asks the focused-field question first, then tags the focused element when either says secret (and types nothing if the tag fails), then inserts the text.
- [ ] **Step 4: Run them to see them pass,** then `npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: the device tags fields the owner types secrets into"`

---

### Task 4: Secret input only over a safe connection, on both paths

**Files:**
- Modify: `src/http.js` (add `secureRequest` beside `trustProxy`, `:41`), `src/routes-live.js` (`POST /api/browser-live/:botId/input`, `:55`), `src/routes-groups.js` (`POST /api/browser-sessions/:session/act`, `:321`), `agent/browser.mjs` (the takeover handle's `act`: after a `type` step with `secret`, tag `[data-agent-index=N]` with `data-agent-secret`)
- Test: `tests/secret-input.test.js` (new)

**Interfaces:**
- Produces: `secureRequest(req) → boolean` from `src/http.js`. The `/act` route passes `secret: b?.secret === true` into the step.

- [ ] **Step 1: Write the failing tests,** calling route handlers through `createRouter` as `tests/public-auth.test.js` does (`req: {headers, socket: {remoteAddress}}`):

```js
test('secureRequest: TLS, a trusted proxy that says https, or loopback', () => {
  assert.equal(secureRequest({headers: {}, socket: {encrypted: true, remoteAddress: '203.0.113.5'}}), true);
  const local = {origin: 'http://localhost:4173'};
  assert.equal(secureRequest({headers: local, socket: {remoteAddress: '127.0.0.1'}}), true);
  // A proxy that adds no headers: loopback peer, the phone's own origin, or none at all.
  assert.equal(secureRequest({headers: {origin: 'http://192.168.1.20:8080'}, socket: {remoteAddress: '127.0.0.1'}}), false);
  assert.equal(secureRequest({headers: {}, socket: {remoteAddress: '127.0.0.1'}}), false);
  assert.equal(secureRequest({headers: {}, socket: {remoteAddress: '192.168.1.20'}}), false);
  // A local proxy relaying a phone over plain HTTP arrives from loopback but says so in its headers.
  for (const h of ['x-forwarded-for', 'forwarded', 'x-real-ip']) {
    assert.equal(secureRequest({headers: {...local, [h]: '192.168.1.20'}, socket: {remoteAddress: '127.0.0.1'}}), false);
  }
  withEnv({TRUST_PROXY: '1'}, () => {
    assert.equal(secureRequest({headers: {'x-forwarded-proto': 'https'}, socket: {remoteAddress: '127.0.0.1'}}), true);
    assert.equal(secureRequest({headers: {'x-forwarded-proto': 'http'}, socket: {remoteAddress: '127.0.0.1'}}), false);
  });
});
test('secret input over plain HTTP from the network is refused on both takeover paths, plain input is not', async () => {
  // live input from 192.168.1.20: {type:'type', text:'482913', secret:true} → 403, message as in Global Constraints, and the hub holds no command
  // the same body without secret → 200
  // POST /api/browser-sessions/:session/act {op:'type', index:1, text:'482913', secret:true} from 192.168.1.20 → 403
});
```

- [ ] **Step 2: Run it to see it fail.** Run: `node --test tests/secret-input.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `secureRequest` per the constraint, the 403 in both routes before anything is queued, and the `secret` pass-through and tag in the takeover handle.
- [ ] **Step 4: Run it to see it pass,** then `npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: secret takeover input only over HTTPS or loopback"`

---

### Task 5: Masked Password and Code fields in both takeover screens

**Files:**
- Modify: `shared/ui-computer-view.js` (the tray at `:109` and the `computer-type` action at `:337`), `shared/ui-takeover.js` (the form at `:44`, the submit at `:159`), `shared/shell.css` or `shared/app.css` (only if the new row needs a rule)
- Test: `tests/usability_smoke.py` (the Computer view scenario at `:1416`)

**Interfaces:**
- Consumes: the `secret` event from Task 3 and the `/act` pass-through from Task 4.

- [ ] **Step 1: Write the failing smoke check.** After the existing `.pc-type` fill at `:1416`, assert that the tray has `input[type=password][autocomplete=current-password]` and `input[inputmode=numeric][autocomplete=one-time-code]`, fill the password field with `hunter22`, submit, and assert that `hunter22` is not in the page's text, not in any toast, and that the field is empty afterwards.
- [ ] **Step 2: Run it to see it fail.** Run: `npm run test:ui`. Expected: the new check FAILS.
- [ ] **Step 3: Add the two fields** beside "Type into the page" in each screen: `<form id="computer-password">` with `<input type="password" name="text" autocomplete="current-password" aria-label="Password">` and a Type button, and `<form id="computer-code">` with `<input name="text" inputmode="numeric" autocomplete="one-time-code" aria-label="Code">`. Both actions push `{type: 'type', text, secret: true}` (Computer view) or call `act({op: 'type', index, text, secret: true})` (takeover sheet), then reset the form. Nothing echoes the text. Copy: the button says `Type`; the field's placeholder says `Password` or `Code`.
- [ ] **Step 4: Run it to see it pass.** Run: `npm run build:pages && npm run test:ui`. Expected: PASS, and `docs/` has no drift.
- [ ] **Step 5: Docs and commit.** Add one paragraph to `SECURITY.md` saying what counts as a secret field, that bots never type into one, and that masked input needs HTTPS or this computer, never a plain-HTTP proxy: such a proxy voids the loopback exemption, and the `Origin` check is what refuses it. In `DEPLOYMENT.md`, say to set `TRUST_PROXY=1` behind `tailscale serve` or Caddy. Tick Phase AA step 0 in `docs/BUILD-PLAN.md`. Run `npm run check && npm test && npm run build:pages`. `git commit -m "feat: masked password and code fields in the takeover screens"`

---

### Task 6: Remember what was typed in secret, scrub it from every result, clear it after submit, and one planted-secret test

**Spec:** `docs/superpowers/specs/2026-11-26-goals-services-teams-design.md` section 6.1. Read these bullets: "What was typed is remembered, and scrubbed from every result", "A submitted secret is cleared from the page", "One planted-secret test". They are binding. Read 6.2 for the two takeover paths.

**Files:**
- Modify:
  - `agent/page-secrets.mjs`: add `scrubTyped`, which runs in Node and is not embedded in the page.
  - `agent/shared-browser.mjs`: the device path. Keep a per-tab `typedSecrets` set. Add to it in `applyInput` when a type event is secret, or when the field answered "secret". Scrub every capture and action result before it leaves.
  - `agent/browser.mjs`: the takeover handle used by the server runtime. It keeps its own set for the session and scrubs in `act`, `view` and `read`. It also clears submitted secret fields.
  - The result paths that carry page results off the device. Find where capture, action and live-view results are returned or sent (`agent/live-channel.mjs`, `agent/agent.mjs`), and scrub at the last point before they leave.
- Test:
  - `tests/page-secrets.test.js` for `scrubTyped`.
  - `tests/shared-browser-takeover.test.js` for the device set.
  - A new `tests/planted-secret.test.js`.

**Interfaces:**
- Consumes: `hideSecrets`, `FOCUSED_IS_SECRET_JS`, `TAG_FOCUSED_SECRET_JS`, the text-entry predicate added by the final-review fix wave, and `applyInput`'s ask-tag-insert order. All are already on the branch.
- Produces: `scrubTyped(result, typed) -> result` in `agent/page-secrets.mjs`.
  - `typed` is an iterable of strings.
  - It returns a deep copy with every string field scrubbed: `url`, `finalUrl`, `title`, `text`, `excerpt`, `links` (each text and href), `elements` (each label and any string field), `readText`, and any nested strings in those.
  - Each remembered string of 3 or more characters becomes `[hidden]`, case-insensitively.
  - In strings that are URLs, its `encodeURIComponent` form is also matched.
  - It never mutates its input.

**Steps:**
- [x] **Step 1: unit tests for `scrubTyped`.**
  - Case-insensitive match.
  - The percent-encoded form in a URL query is matched.
  - A value under 3 characters is ignored.
  - Nested `links` and `elements` are scrubbed.
  - The input object is unchanged.
  - Overlapping remembered strings are merged in one pass, the way `hideSecrets` merges ranges, so `[hidden]` is never cut in half.
- [x] **Step 2: device set tests** (fake CDP).
  - After a secret type of `hunter22` and a page whose title, URL and a re-drawn field echo it, the next capture, action result and live view carry `[hidden]` and no `hunter22` in any letter case.
  - A plain type into a field that answered "secret" is remembered too.
  - A plain type into an ordinary field is not remembered.
  - Closing the tab drops its set.
  - The set is never written anywhere: no config, log, disk or jar.
- [x] **Step 3: clear after submit.**
  - When a secret field's form is submitted (a click on its submit control, or Enter in the field), or the owner hands back, the device sets that field's `value` to empty and removes its `value` attribute in the page.
  - Use one small page expression next to the others in `page-secrets.mjs`, with an exact constant so `tests/fake-cdp.js` can match it.
  - Its failure is logged with fixed wording and never blocks the hand back.
  - Test it on the fake CDP, and on the real-browser test if one already covers the takeover.
- [x] **Step 4: the planted-secret test** `tests/planted-secret.test.js`.
  - Type a unique marker, for example `Planted-<random>-Zq9`, as `secret: true` into a test page served locally. The page echoes it in its title, its URL query, and a field it draws again after "a failed sign-in".
  - Then run a bot capture and a read, and a hand back that stores a run.
  - Assert the marker, in any letter case, is in none of these: any model request body (stub the AI with a recording fake), any line written to the console, the stored store state (serialise it), any chat line, any activity line.
  - Use the test rigs other integration tests use (look at `tests/secret-input.test.js` and the bot-browser tests). Keep it off port 4173 and the real `data/state.json`.
  - It may be skipped only when no Chrome is found, the same way the existing real-browser tests are skipped. If it can run without Chrome on the fake CDP, prefer that and keep one Chrome variant.
- [x] **Step 5: docs and gate.**
  - One sentence in `SECURITY.md`'s secret-fields paragraph about the typed-value memory and the clear after submit. Replace the "not yet covered after navigation" line the fix wave added, since this task covers it.
  - In the plan file, the Goal line goes back to covering navigation.
  - Run `npm run check && npm test && npm run build:pages` (no drift) and `npm run test:ui`.
  - Commit: `feat: the device remembers secret typing and scrubs it from every result`.

**Constraints:**
- Never put a typed value in an error, toast, log or test failure message. Assertions print a fixed message, not the marker.
- The set lives in memory only.

---

### Task 7: The `secret-input-v1` device feature, and masked fields only for a device that has it

**Spec:** `docs/superpowers/specs/2026-11-26-goals-services-teams-design.md`. Read these, which are binding:
- 6.2: "The server queues a `secret` event only for a device that reports `secret-input-v1`… For any other device the masked fields are not shown, and a line says to update the device app."
- 5.5, the "Features" paragraph. Phase 0 ships only `secret-input-v1` and this one check. The general `needs` and `missing-feature` in `chooseDevice`, and the 60-day window, are Phase 1. Do not build those.

**Files:**
- Modify:
  - `agent/agent.mjs`: the heartbeat near line 266 already sends `cli`. Send `features: ['secret-input-v1']` with every heartbeat. Use a constant list exported from one place in `agent/`, for example `agent/features.mjs`. If you make a new agent file, make sure `scripts/check.mjs` walks it; it walks `agent/`.
  - `src/agent.js`: store the reported features per agent, the way `cli` is stored (look at `readAgentCli` and where the heartbeat writes `cli`). Expose them as `features` in the agent rows the UI reads, near lines 396 and 411. Use a kv or column choice matching how `cli` is kept. If it needs a schema change, follow `TABLE_SHAPES` and the store migration pattern, because `tests/store-incremental.test.js` checks it.
  - `src/routes-live.js`: the `POST /api/browser-live/:botId/input` route. A `secret: true` event for a bot whose live device lacks `secret-input-v1` is refused with 409 "Update the app on your computer to type passwords and codes here.". Find which device serves that bot's live session (`src/browser-live.js`). The check runs after the `secureRequest` 403, keeping that order, and before anything is queued.
  - `shared/ui-computer-view.js`: hide the Password and Code rows when the serving device lacks the feature, and show that same sentence as a line in the tray instead. Read the device's features from what the snapshot or live session already gives the view. If nothing gives it, add `features` to the smallest existing payload that reaches the view.
  - The server-runtime takeover sheet (`shared/ui-takeover.js`) runs in the server's own browser, not on a device, so it keeps its fields. Say so in a code comment.
- Test:
  - a unit or integration test that a heartbeat's `features` is stored and shown;
  - the 409 for a device without the feature, and acceptance for one with it;
  - a usability smoke step: with a device that does not report the feature, the tray shows the line and no Password field.
  - Update the existing Computer view smoke's fake device to report the feature, so its masked-field steps still run.

**Steps:** write the tests first, see them fail, implement, see them pass. Then:
- Run `npm run build:pages` and commit the regenerated `docs/`.
- Add one line in `docs/AGENT-PROTOCOL.md` (it documents the device protocol) naming the `features` heartbeat field and `secret-input-v1`.
- Run the gate: `npm run check && npm test && npm run build:pages` (no drift) and `npm run test:ui`.
- Commit: `feat: masked input only for a device that reports secret-input-v1`.

**Constraints:**
- An older device that sends no `features` is treated as having none. It never crashes the heartbeat.
- `features` from the device is validated: an array of short known-shaped strings, capped in length and count. It is never trusted as anything else.
- Never put typed text in an error or log.

---

## Done when

`npm run check`, `npm test`, `npm run build:pages` (no drift) and `npm run test:ui` pass; the five Review Focus cases each have a passing test; `SECURITY.md` and `BUILD-PLAN.md` say what changed.
