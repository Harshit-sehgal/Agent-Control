# Phase 3: sign-in from the phone — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Plan path (once merged):** `docs/superpowers/plans/2026-11-27-phase-3-signin-from-phone.md`

**Goal:** A keeper finds an account signed out and your phone buzzes. You sign in from the phone, and the waiting run carries on by itself.

**Architecture:**
- **One ask per account.** A sign-in wall is now the server's to notice. It can come from two places: a bot's page coming back as a sign-in page on its account's own site, or a heartbeat that says an account went signed out. Either way the server opens one **sign-in ask** for that account. This is an ask record with `kind: 'signin'`, kept in kv `signin_pending: {accountId → askId}`.
  - The ask is posted as an ordinary ask line in each waiting chat, and in the primary's Needs you.
  - It is pushed once, not urgent, with a route to its chat.
- **The wait is an ask.** A page that hit the wall is held in a new request status, `signin`, which `expireBrowserTasks` never touches. Its run parks as `awaiting_ask`, with the ask in its `askIds`, so busy state, follow-ups and Stop already treat it right.
- **Hand back answers it.** The card's **Take control** opens the bot's account tab on the account's site, exactly as the setup card's Sign in does today. The owner signs in through the masked Password and Code fields (Phase 0) and taps **Hand back**.
  - The hand back route answers the account's ask.
  - Every held page goes back to `pending`, and every parked run is resumed through `resumeAfterAsks`, which dispatches those pages again under a fresh task.
  - **Not now**, or 24 hours with no sign-in, denies the held pages instead. Each run then takes its declined turn.

**Tech Stack:**
- Node ≥ 22, with no npm runtime dependencies;
- `node --test`, with `tests/fake-cdp.js` for the device, and the `createApp` harness of `tests/browser-account-heartbeat.test.js` for the server;
- SQLite through `src/sqlite-store.js`;
- the Playwright smoke `tests/usability_smoke.py` (`npm run test:ui`).

**Spec:** `docs/superpowers/specs/2026-11-26-goals-services-teams-design.md`.
- §6.3 is binding: the card and the wait.
- §15 row 3 is the definition of done.
- §5.1 to §5.3: accounts, keepers and sign-in detection.
- §6.1 and §6.2: what is typed in secret never leaves the device.
- §13.1: the sign-in card sits in the bot's chat and the group chat, and Needs you counts it.
- §13.2: the demo says this needs the server.
- §17: acting from the wrong account.

**Builds on Phases 0, 1, 1b and 2, all merged in this tree:**
- the ask mechanism: `createAsk`, `answerAsk`, `expireAsks` (`shared/asks.js:364-432`), `answerAskFlow` and `expirePendingAsks` (`src/ask-runs.js:28-58`), `resumeAfterAsks` (`src/coordination.js:664-705`), and `addAskCards` and `notifyAsks` (`src/ask-cards.js:21-42`);
- browser requests: `dispatchBrowserRequest`, `finishBrowserRequest`, `expireBrowserTasks` and `onAgentTaskResult` (`src/bot-browser.js:61-318,371-379`), and `resumeBrowserRun` (`src/coordination.js:586-662`);
- accounts: `browserAccountOf` (`shared/browser-accounts.js:97`), `recordAccountReports` (`src/agent.js:491-502`), the heartbeat (`src/routes-public.js:203-255`), and the device's `noteResult`, `handback` and `accountStates` (`agent/shared-browser.mjs:307-380,532-539`);
- sign-in detection: `signinSite` and `signinPage` (`shared/bot-browser.js:270-292`);
- the setup card's Sign in, which takes over and navigates (`shared/ui-conversation.js:558-565`);
- the live routes (`src/routes-live.js:107-118`) and the Computer view's hand back (`shared/ui-computer-view.js:326-345`);
- push: `createNotifier` (`src/handlers.js:17-42`), `announce` and `send` (`src/push.js:95-153`), and the service worker's `route` (`shared/sw.js:129-140`).

## Global Constraints

**Repo rules**
- No npm runtime dependencies, and no new `shared/` module. Any edit to `shared/` is followed by `npm run build:pages`.
- Every task leaves `npm run check`, `npm test` and `npm run build:pages` green, with no drift in `docs/`.
- `build:pages` stamps every file in `docs/` with one content hash. So Tasks 1 and 6, the only ones that touch `shared/`, each sit in a wave with no other `shared/` task.
- No schema migration. An ask keeps its extra fields in the `asks` table's `doc` column (`src/sqlite-store.js:173-178`), and `signin_pending` is one kv row.
- **Sign-in is for account bots only.** A bot with `browserAccount: null` keeps today's flow: the model's own setup `signin` block, `signinOffered` and `signinNotice`.

**The sign-in ask** (`shared/asks.js`)
- Its shape is `{id, kind: 'signin', action: 'signin', botId, runId, chatKey, accountId, accountName, site, url: 'https://<site>/', detail: 'signing in to <site> as <accountName>', target: '', grantScope: '', status, scope, createdAt, expiresAt, answeredAt?, expired?}`.
- `'signin'` is **not** in `ASK_ACTIONS`, so no grant, rule card or backup grant row can ever name it.
- `expiresAt` is always `createdAt + ASK_EXPIRY_MS` (24 hours), whether the run is attended or not.
- **Answered.**
  - Signed in: `status: 'allowed', scope: 'once'`.
  - Not now, or expired: `status: 'declined'`, with `expired: true` when it lapsed.
- **Held requests.** A held request carries `status: 'signin'`, `signinAskId` and `signinHolds` (1 or 2). `MAX_SIGNIN_HOLDS = 2`.
- **A re-dispatch key.** A re-dispatch is enqueued with the idempotency key `browser:<requestId>:<signinHolds>`. The first dispatch keeps `browser:<requestId>`.

**Sentences** (exact)
- **The card's line** (`askText`): `${bot} needs you to sign in to ${site} as ${accountName}.`
- **The card's note:** `Take control opens ${accountName}'s browser on its computer. Sign in there, then tap Hand back, and the task carries on by itself.`
- **The card's buttons:** `Take control` (primary), `Not now`.
- **Answered lines** (`answeredText`):
  - `You signed in`;
  - `You chose not now`;
  - `No sign-in in 24 hours, so the task went on without it`.
- **Refusal** (409, for `allow` or `always`): `This card is answered by signing in: tap Take control, sign in, then Hand back.`
- **Push.** The title is `Sign in to ${site}`. The body is `${bot} needs you to sign in to ${site} as ${accountName}. Open the card and tap Take control; the task carries on by itself.`
  - Its `kind` is `'signin'`, with `urgent: false`.
  - Its `route` is `#bot/<chatKey>` for a bot chat, else `#thread/<groupId>` for `team-<groupId>`.
- **The request label** (`BROWSER_STATUS`): `signin: ['Waiting for you to sign in', 'warn']`.
- **Hand back toast**, when a sign-in was answered: `Signed in. ${bot}'s task carries on.`
- **The demo** (the card's Take control): `Signing in needs the app running on your computer.` These are the setup card's words.

## Calls

Each is a choice the spec leaves open, with the reason.

1. Call: **Account bots only.** §6.3 keys the card by account (`signin_pending: {accountId → askId}`) and replaces the per-run lists "for accounts".
2. Call: **The card is an ask line** (`kind: 'ask'`, ask `kind: 'signin'`), not a setup card. An ask already has Needs you, the 24-hour expiry, the answered line, push and the run park. A setup card would be a second record that could disagree with it. Its Take control reuses the setup card's takeover-and-navigate code.
3. Call: **A sign-in ask is never a grant.** `answerAsk` refuses `allow` and `always` for it. Not now goes through `POST /api/asks/:id` as `decline`, and only a hand back signs it in.
4. Call: **Answers use the three statuses every reader knows** (`allowed`, `declined`, `pending`). The `asks` table, backups and `settled` need no change.
5. Call: **Every sign-in ask expires in 24 hours**, attended or not. §6.3.2 relies on that expiry to end the wait.
6. Call: **The kv `signin_pending` is kept, but read only through `openSigninAsk`.** That function ignores an entry whose ask is no longer pending or whose bot is gone, so a stale entry can never strand a card.
   - The entry is cleared on a hand back, on Not now, on expiry and on an account delete.
   - A restore drops it, as it drops `browser_requests`.
7. Call: **One ask, many waiters.** Each held request carries `signinAskId`, and each parked run lists the ask in `askIds`. The ask's one line (id `ask-<id>`) is posted into every waiting chat, and it is pushed once.
8. Call: **A page is held only on its account's own wall.** The request must name an `account`, carry no `watchId`, not be a takeover result, and be `dispatched` with fewer than 2 holds. `accountWall` must also find the wall on the account's site. Anything else finishes as today. A watch never asks (AGENTS.md), and a wall on another site is not this account's.
9. Call: **`MAX_SIGNIN_HOLDS = 2`.** Leaving the Computer view hands back by itself (`shared/ui-computer-view.js:323`), so one stray hand back must not cost the run its wait. A third wall goes to the bot as today, so nothing loops.
10. Call: **A re-dispatch runs the request's own `url` and steps**, not the page the owner left. The steps were planned for that url, and one card can serve several requests. A per-hold idempotency key keeps `enqueueAgentTask` (`src/agent.js:327-329`) from handing back the finished first task.
11. Call: **A hand back of any bot's tab in the account answers its card**, signed in or not. A heartbeat never answers one. The hand back is the owner's "done", and a beat's state can be stale.
12. Call: **A keeper card needs a stored transition** from `signed-in` or `unknown` to `signed-out`. A first report never posts one: a new account and every restored account read `signed-out` by default (`agent/shared-browser.mjs:498`).
13. Call: **A keeper card names the first bot**, in group order, that signs in as the account, and is posted in that bot's chat. With no such bot there is no card and no push, because nothing would use the sign-in.
14. Call: **The card opens `https://<site>/`.** One card serves every waiting request, and each re-dispatch opens its own page.
15. Call: **The push carries a `route`** to the ask's chat, so a tap lands on the card. `send` (`src/push.js:100`) passes only title and body today, and the service worker already honours `route`.
16. Call: **Not now and expiry deny the held pages.** Each parked run takes its declined turn through `resumeAfterAsks`. A run-less (1:1) page is simply denied.
17. Call: **On the device, typed-secret memory is per account for an account's tabs.** The owner signs in on the card's bot's tab, and the re-dispatched page may open in another bot's tab of the same account (§6.1). A tab with no account keeps its own memory.
18. Call: **`signinOffered` and `signinNoticed` skip an account site whose sign-in card is open,** and stay as they are otherwise. One card and one push per account is what "replacing … for accounts" asks. A site that refused twice is not a detected wall, so its setup card stays.
19. Call: **`resumeBrowserRun` consumes a page while its run is `awaiting_ask`,** and `resumeAfterAsks` waits in `awaiting_browser` while a page of the run is still out. A round of two pages, one of which hits the wall, would otherwise drop the other.
20. Call: **The hold rules live in `src/signin-wait.js`, which is server-only.** The demo has no computer, so it can never hold a page. The shared pieces go into `shared/asks.js`, `shared/browser-accounts.js` and `shared/bot-browser.js`. `shared/asks.js` may not import `shared/browser-accounts.js`, which would form a cycle through `shared/bot-browser.js`.
21. Call: **An IdP landing counts as the account's wall when the page was asked for on the account's site, with or without a return parameter.** This is the Phase 2 Task 8 leftover: with no return parameter, `signinSite` cannot map the IdP back to the site today. The device and the server use the same `accountWall`.
22. Call: **Deleting an account declines its open card,** so no card is left with nothing to sign in to.
23. Call: **No health-watch code changes.** `healthIssues` reads only queue tasks (`src/health-watch.js:37-64`), and `runBotTask` returns once its run is queued (`src/coordination.js:213-242`), so a parked run leaves nothing late. Task 7 pins this with one assertion.
24. Call: **The demo gains no route.** A sign-in ask cannot arise there. Its shared `answerAsk` accepts Not now on one, and Take control says the setup card's demo line.

## Review Focus

1. **A round of two pages where one hits the wall.** The run must end with both pages, and must not wait for ever in `awaiting_browser`. This holds whichever page comes back first, and when the other page is still out at the hand back. Tasks 2 and 4 pin this.
2. **A late or repeated result for the first task.** It must not turn a held request into `done`. After the hand back, the re-dispatch must be a new agent task that the device really receives, not the finished first task. Task 2 pins this.
3. **Two runs and one 1:1 chat wait on one account.** Expected:
   - one card and one push;
   - a hand back resumes both runs and opens the 1:1 page;
   - Not now gives each run its declined turn and opens nothing.

   Task 4 pins this.
4. **A new account, or every account after a restore, reports `signed-out`.** There must be no card and no push. A device restart that finds a restored jar's sign-in lost (`unknown` then `signed-out`) does post one. Task 3 pins this.
5. **The owner hands back without signing in, or leaves the Computer view.** The page is held once more with the same card behaviour. On the third wall the bot gets the sign-in page as today: no endless cards, and no run stuck. Tasks 2 and 4 pin this.

---

## Order and parallel work

| Wave | Tasks (each set touches disjoint files) | Waits for |
|---|---|---|
| A | 1 | nothing. It is the only `shared/` task in the wave. |
| B | 2, 5 | Both wait for 1. Task 2 touches `src/` only, and Task 5 touches `agent/` only. |
| C | 3, 4, 6 | 3 and 4 wait for 2. Task 3 touches `src/agent.js` and `src/routes-public.js`. Task 4 touches `src/ask-runs.js`, `src/routes-live.js`, `src/routes-browser-accounts.js` and `src/coordination.js`. Task 6 is the only `shared/` task in the wave, and reads Task 4's handback reply from its Interfaces. |
| D | 7 | all |

---

### Task 1: The shared rules: the sign-in ask, the account's wall and the `signin` status

**Files:**
- Modify `shared/asks.js`:
  - add `SIGNIN_ASK`, `isSigninAsk`, `createSigninAsk` and `openSigninAsk` beside `createAsk` (`:364-386`);
  - refuse `allow` and `always` in `answerAsk` (`:396-419`);
  - branch `askText` (`:475`) and `answeredText` (`:478-483`).
- Modify `shared/browser-accounts.js`: export `onSite` and `accountWall` beside `browserAccountOf` (`:97`).
- Modify `shared/bot-browser.js`:
  - export `isSigninHost`, from `SIGNIN_HOSTS` (`:270`);
  - export `OPEN_REQUEST_STATUSES = ['pending', 'dispatched', 'signin']`;
  - use it in `denyBrowserRequest` (`:676`) and `pruneBrowserRequests` (`:687`);
  - in the refused-twice block (`:611-617`), skip the setup card when the bot's account site is `host` and its sign-in card is open.
- Modify `shared/chats.js:173` (`releaseChatWork`) and `shared/workflow.js:214` (removing a bot) to use `OPEN_REQUEST_STATUSES`.
- Regenerate `docs/`.
- Test: `tests/signin-asks.test.js` (new). Extend `tests/signin-page.test.js`.

**Interfaces:**
- Produces, from `shared/asks.js`:
  - `SIGNIN_ASK = 'signin'`;
  - `isSigninAsk(ask) → boolean`;
  - `createSigninAsk(state, {botId, runId = null, chatKey, account: {id, name, site}, now, makeId}) → ask`, with the shape in Global Constraints. It pushes onto `state.asks` with the same settled-history bound as `createAsk`, and sets `state.signinPending[account.id] = ask.id`.
  - `openSigninAsk(state, accountId) → ask | null`. It reads `state.signinPending`. An entry whose ask is missing or not pending, or whose `botId` is no bot of the roster, is deleted from the map and gives `null`.
  - `answerAsk` on a sign-in ask:
    - `allow` or `always` throws 409 with the refusal sentence;
    - `decline` records `declined` and returns `resumeRunId: null`, because fanning out is the server's job (Task 4).
- Produces, from `shared/browser-accounts.js`:
  - `onSite(host, site) → boolean`: `host === site` or `host.endsWith('.' + site)`, both lowercased, with an empty value false.
  - `accountWall(site, url, result) → boolean`. It is true when either of these holds:
    - `signinPage(result)` is on `site`;
    - `hostOf(url)` is on `site` and `hostOf(result.finalUrl || result.url)` is an IdP (`isSigninHost`), whatever its return parameter says.
- Produces, from `shared/bot-browser.js`: `isSigninHost(host) → boolean`, and `OPEN_REQUEST_STATUSES`.

- [ ] **Step 1: Write the failing tests.**

```js
const A = '0b6f1c2e-4d5a-4b8c-9e1f-2a3b4c5d6e7f';
const acct = {id: A, name: 'Work CRM', site: 'crm.example.com'};
const state = () => ({groups: [{id: 'home', bots: [{id: 'scout', name: 'Scout', settings: {browserAccount: A}}]}], asks: [], browserRequests: [], browserAccounts: [{...acct, deviceId: 'pc-1', storage: 'cookies'}]});
test('a sign-in ask is one per account, lasts 24 hours and is never a grant', () => {
  const s = state(), now = '2026-11-27T10:00:00.000Z';
  const ask = createSigninAsk(s, {botId: 'scout', chatKey: 'scout', account: acct, now, makeId: () => 'k1'});
  assert.equal(ask.expiresAt, '2026-11-28T10:00:00.000Z');
  assert.deepEqual(s.signinPending, {[A]: 'k1'});
  assert.equal(openSigninAsk(s, A).id, 'k1');
  assert.equal(askText(ask, 'Scout'), 'Scout needs you to sign in to crm.example.com as Work CRM.');
  for (const no of ['allow', 'always']) assert.throws(() => answerAsk(s, 'k1', no), e => e.status === 409 && /^This card is answered by signing in: tap Take control, sign in, then Hand back\.$/.test(e.message));
  assert.equal(answerAsk(s, 'k1', 'decline').resumeRunId, null);
  assert.equal(answeredText(ask), 'You chose not now');
  assert.equal(openSigninAsk(s, A), null); assert.deepEqual(s.signinPending, {});
  assert.equal(isAskAction('signin'), false);
});
test('a stale entry heals: an ask gone, or whose bot is gone, is no open card', () => {
  const s = state(); createSigninAsk(s, {botId: 'scout', chatKey: 'scout', account: acct, now: iso(), makeId: () => 'k1'});
  s.groups[0].bots = []; assert.equal(openSigninAsk(s, A), null); assert.equal(s.signinPending[A], undefined);
});
test('the account\'s wall: a sign-in page on its site, a password field alone, an IdP with no way back; never another site', () => {
  const page = (finalUrl, elements = []) => ({finalUrl, elements});
  assert.equal(accountWall('crm.example.com', 'https://crm.example.com/r/1', page('https://crm.example.com/login')), true);
  // A two-step login's second page shows a password field and nothing else: it is a wall (Phase 2 Task 10, pinned here).
  assert.equal(accountWall('crm.example.com', 'https://crm.example.com/', page('https://crm.example.com/u/next', [{tag: 'input', type: 'password'}])), true);
  assert.equal(accountWall('crm.example.com', 'https://crm.example.com/', page('https://accounts.google.com/v3/signin/identifier')), true);
  assert.equal(accountWall('crm.example.com', 'https://other.example.org/', page('https://other.example.org/login')), false);
  assert.equal(accountWall('crm.example.com', 'https://localhost/', page('https://localhost/', [{tag: 'input', type: 'password'}])), false);
  assert.equal(accountWall('crm.example.com', 'https://crm.example.com/', page('https://crm.example.com/home')), false);
});
test('a held request is open: pruning keeps it, a decline, a cleared chat and a removed bot deny it', () => {
  // pruneBrowserRequests over MAX_BROWSER_REQUESTS + 1 requests keeps the one in 'signin';
  // denyBrowserRequest on it gives 'denied'; releaseChatWork(s, 'scout') and the bot's removal deny it.
});
test('a site that refused twice posts no setup card while its account\'s sign-in card is open', () => {
  // recordBrowserRequests for scout on crm.example.com, with two refused requests of the run: no `kind: 'setup'` line,
  // and still the `refused` entry; with no open card, the setup card is posted as today.
});
```

- [ ] **Step 2: Run the tests and see them fail.** Run `node --test tests/signin-asks.test.js tests/signin-page.test.js`. Expected: FAIL, because `createSigninAsk` is not exported.
- [ ] **Step 3: Implement.** `createSigninAsk` builds the record by hand and never calls `createAsk`, which would refuse the action. `openSigninAsk` reads the roster the way `botIds` does (`shared/asks.js:72`). `accountWall` reuses `signinPage` and `hostOf`.
- [ ] **Step 4: Run the tests, the build and the suite.** Run `node --test tests/signin-asks.test.js tests/signin-page.test.js tests/asks.test.js tests/architecture.test.js && npm run build:pages && npm test`. Expected: PASS, with no drift.
- [ ] **Step 5: Commit.** `git add shared/asks.js shared/browser-accounts.js shared/bot-browser.js shared/chats.js shared/workflow.js docs tests/signin-asks.test.js tests/signin-page.test.js && git commit -m "feat: the sign-in ask per account, the account's wall and the signin request status"`

---

### Task 2: The server holds the page, parks the run, posts the card and pushes it

**Files:**
- Create `src/signin-wait.js` (server-only, with pure state functions).
- Modify `src/bot-browser.js`:
  - In `finishBrowserRequest` (`:199-245`), add `'signin'` to the early-return list. Then call `holdForSignin` inside the same `store.update`, before the request is marked done. A held request posts no browser-result line and resumes nothing.
  - In `dispatchBrowserRequest` (`:120`), use the per-hold idempotency key.
  - Leave the peer check in `finishBrowserRequest` (`:230`) on `['pending', 'dispatched']`, not `OPEN_REQUEST_STATUSES`. A held peer must not stop a finished page from reaching `resumeBrowserRun`, which Call 19 relies on.
- Modify `src/coordination.js`:
  - `denyRunPages` (`:83-92`) uses `OPEN_REQUEST_STATUSES` and fails task ids only for `dispatched`;
  - the unattended `signinNoticed` (`:416`) skips sites `onSite` the bot's account site while `openSigninAsk` is set;
  - `resumeBrowserRun` (`:586-590`) consumes a page while the run is `awaiting_ask` (Call 19). It resumes only from `awaiting_browser`, as now.
- Modify `src/ask-cards.js`: add `notifySignin`.
- Modify `src/push.js:100` (`send`) and `:149-153` (`announce`), and `src/handlers.js:35-38` (`createNotifier`), to carry an optional `route`.
- Modify `src/sqlite-store.js:622,730`: read and write `state.signinPending` as kv `signin_pending`, defaulting to `{}`.
- Modify `src/backup.js:371-376`: a restore deletes kv `signin_pending`.
- Test: `tests/signin-hold.test.js` (new). Extend `tests/push.test.js` and `tests/credentials-backup.test.js` (beside the `browser_requests` restore drop at `:250`).

**Interfaces:**
- Consumes Task 1: `createSigninAsk`, `openSigninAsk`, `accountWall`, `onSite` and `OPEN_REQUEST_STATUSES`.
- Produces, from `src/signin-wait.js`:
  - `MAX_SIGNIN_HOLDS = 2`.
  - `holdForSignin(state, request, result, {now, makeId}) → {ask, fresh: boolean} | null`. This is the rule of Call 8. On a hold it does the following:
    - it reuses `openSigninAsk`, or creates the ask, naming `request.botId`, `request.runId ?? null` and `request.chatKey`;
    - it sets `status: 'signin'`, `signinAskId`, `signinHolds` (+1) and `updatedAt` on the request;
    - if the request has a run in `awaiting_browser` or `awaiting_ask`, the run becomes `awaiting_ask` with the ask added to `askIds`, once;
    - a fresh ask posts `addAskCards`; a reused one adds its line (id `ask-<id>`) to `request.chatKey` only when that chat lacks it.

    A request with a run in any other status is not held.
  - `signinFromKeeper(state, accountId, {now, makeId}) → {ask, bot} | null` (Call 13). It returns `null` when the account has no record, an open card, or no bot.
  - `noticeSignins(store, accountIds) → Promise<number>`. For each account it runs `signinFromKeeper` in one update, then `notifySignin` for each card made. It returns how many it made.
- Produces, from `src/ask-cards.js`: `notifySignin(store, ask, botName)`. It calls `store.notify({title, body, kind: 'signin', urgent: false, route, meta: {askId, accountId}})` with the copy in Global Constraints. It is fire and forget, like `notifyAsks`.
- Produces, from `src/push.js`: `announce(..., {id, title, body, urgent, route})`. `send` puts `route` into the encrypted JSON only when it is a string matching `/^#[A-Za-z0-9/_-]{1,200}$/`.

- [ ] **Step 1: Write the failing tests.** Build on `rig` in `tests/browser-account-dispatch.test.js`: a paired device with `browser-accounts-v1`, bot `web` on account `A` at `crm.example.com`, and a run whose request is dispatched.

```js
const wall = {finalUrl: 'https://crm.example.com/login', title: 'Sign in', text: '', elements: [{index: 1, tag: 'input', type: 'password'}]};
test('a page that comes back as its account\'s sign-in page is held, the run parks on one card, and the push is quiet', async t => {
  // finishBrowserRequest(store, request, {ok: true, result: wall})
  // request: status 'signin', signinHolds 1, signinAskId === ask.id; no 'browser-result' line in web's chat
  // run: status 'awaiting_ask', askIds includes ask.id; resumeBrowser hook not called
  // chats.web has a kind 'ask' line `ask-${ask.id}` with text 'Web needs you to sign in to crm.example.com as Sales.'
  // the notify recorder saw one {kind: 'signin', urgent: false, route: '#bot/web', title: 'Sign in to crm.example.com'}
});
test('a second run on the same account parks on the same card: one push, its own chat line', async t => {});
test('a late result for the first task leaves a held request held; the re-dispatch is a new task', async t => {
  // onAgentTaskResult(store, firstTaskId) again → request still 'signin'
  // set the request back to 'pending' and dispatchBrowserRequest → agent_tasks has 2 rows; the second's idempotency_key is `browser:${id}:1`
});
test('what is never held: a watch, a takeover result, a page with no account, a wall on another site, a third wall', async t => {
  // watchId → done; result.tookOver → done; no account → done; https://other.example.org/login → done;
  // signinHolds 2 → done, and the bot's page text starts 'This is a sign-in page'
});
test('a page that comes back while its run waits on a sign-in is kept for the run', async t => {
  // two requests in one round: r2 holds first, then r1 comes back done → run.browserConsumed holds r1, browserPage holds r1's page,
  // status stays 'awaiting_ask'
});
test('an unattended run on an account with an open card sends no second sign-in notice', async t => {});
test('signin_pending survives a reopen and is dropped by a restore', async t => {});
```

Extend `tests/push.test.js`: `announce` with `route: '#bot/web'` queues a payload with that route, and `send` encrypts `{title, body, route}`. A route like `javascript:x` is dropped. Extend the notifier test: `createNotifier`'s announce gets `urgent: false` for `kind: 'signin'`.

- [ ] **Step 2: Run the tests and see them fail.** Run `node --test tests/signin-hold.test.js tests/push.test.js`. Expected: FAIL, because `src/signin-wait.js` does not exist.
- [ ] **Step 3: Implement.**
  - `finishBrowserRequest` reads `holdForSignin`'s answer from its update. After the update, a fresh ask calls `notifySignin` with the request's `botName`.
  - `src/signin-wait.js` imports only `shared/*` and `src/ask-cards.js`, so `src/bot-browser.js` can import it without forming a cycle.
- [ ] **Step 4: Run the tests and the suite.** Run `node --test tests/signin-hold.test.js tests/push.test.js tests/ask-runs.test.js tests/browser-account-dispatch.test.js tests/architecture.test.js && npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/signin-wait.js src/bot-browser.js src/coordination.js src/ask-cards.js src/push.js src/handlers.js src/sqlite-store.js src/backup.js tests/signin-hold.test.js tests/push.test.js tests/credentials-backup.test.js && git commit -m "feat: hold a page at its account's sign-in, park the run on one card per account and push it quietly"`

---

### Task 3: A keeper's signed-out finding posts the card

**Files:**
- Modify `src/agent.js:491-502`: `recordAccountReports` returns the account ids that fell.
- Modify `src/routes-public.js:219-220`: the heartbeat calls `noticeSignins` with them. A failure is logged as `Sign-in card:` and never fails the beat.
- Test: extend `tests/browser-account-heartbeat.test.js`.

**Interfaces:**
- Consumes Task 2: `noticeSignins(store, accountIds)`.
- Produces: `recordAccountReports(store, agentId, reported) → string[]`. These are the ids whose stored entry existed with state `signed-in` or `unknown` and is now `signed-out`. It returns `[]` on every early return.

- [ ] **Step 1: Write the failing tests.**

```js
test('an account that goes from signed in to signed out on a beat posts one card and one quiet push', async t => {
  // beat A signed-in, then A signed-out → one ask {kind: 'signin', accountId: A, botId: <first bot on A>}; notify once, urgent false
  // a third beat still signed-out → nothing more
});
test('a first report of signed out, a new account or one after a restore, posts nothing', async t => {});
test('a restored jar found lost after a restart posts the card: unknown, then signed out', async t => {});
test('an account no bot signs in as posts nothing', async t => {});
test('a card that cannot be posted does not fail the beat', async t => {
  // store.notify throws → beat 200, with `accounts` in the reply
});
```

- [ ] **Step 2: Run the tests and see them fail.** Run `node --test tests/browser-account-heartbeat.test.js`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** Compare against the `before` map that `recordAccountReports` already builds (`src/agent.js:495`).
- [ ] **Step 4: Run the tests and the suite.** Run `node --test tests/browser-account-heartbeat.test.js && npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/agent.js src/routes-public.js tests/browser-account-heartbeat.test.js && git commit -m "feat: a keeper's signed-out finding posts the account's sign-in card"`

---

### Task 4: Hand back, Not now and expiry release every waiter

**Files:**
- Modify `src/signin-wait.js`: add `releaseSignin`.
- Modify `src/ask-runs.js`:
  - add `answerSigninFlow` and `finishSignin`;
  - `answerAskFlow` (`:28-43`) sends a sign-in ask to `answerSigninFlow` (Not now) before `answerAsk`;
  - `expirePendingAsks` (`:47-58`) releases each expired sign-in ask inside its update, and adds those runs to `resumeRunIds`.
- Modify `src/coordination.js:664-705`: in `resumeAfterAsks`, a run with a page still `dispatched` and not consumed goes to `awaiting_browser` with nothing to dispatch, and does not start.
- Modify `src/routes-live.js:114-118`: the handback route calls `finishSignin` for `line.account`, and its reply gains `signedIn`.
- Modify `src/routes-browser-accounts.js:37`: a delete declines the account's open card through `answerSigninFlow`.
- Test: `tests/signin-release.test.js` (new).

**Interfaces:**
- Consumes Tasks 1 and 2: `openSigninAsk`, `isSigninAsk`, and the held-request fields.
- Produces, from `src/signin-wait.js`: `releaseSignin(state, askId, {signedIn, now}) → {ask, runIds: string[], openIds: string[]}`.
  - A pending ask is answered (`allowed`/`once`, or `declined`), and its `expiresAt` is deleted. An ask already declined by expiry is left as it is.
  - Its `signinPending` entry is deleted.
  - Every request with `status: 'signin'` and this `signinAskId` becomes `pending` (signed in) or `denied` (not), with `updatedAt`. A signed-in one also gets `agentTaskIds: []` and loses `notAfter`, `approvedBy`, `via`, `account` and `accountName`, as the revert at `src/bot-browser.js:145` does. The old task id then matches nothing in `onAgentTaskResult` (`:372`), and a failed re-dispatch can revert to `pending` (the guard at `:144` refuses a request that still holds task ids).
  - `runIds` are the runs in `awaiting_ask` whose `askIds` hold the ask. `openIds` are the run-less requests made `pending`.
- Produces, from `src/ask-runs.js`:
  - `answerSigninFlow(store, askId, {signedIn, actor = null, runtime, executor} = {}) → {ask, resumed: number}`. It runs `releaseSignin` in one update, then `resumeAfterAsks` for each run, then the existing `open()` for each run-less id. `resumed` counts both.
  - `finishSignin(store, accountId, opts) → {ask, resumed} | null`. It returns `null` when `openSigninAsk` finds no open card.
- Produces, from `src/routes-live.js`: `POST /api/browser-live/:botId/handback` answers `{botId, state, signedIn?: {resumed}}`.

- [ ] **Step 1: Write the failing tests.** Use the `createApp` harness of `tests/browser-account-heartbeat.test.js`, with an owner session.

```js
test('hand back answers the account\'s card and sends the held page again under a new task', async t => {
  // a run parked on ask k1 with request r1 held → POST /api/browser-live/web/handback
  // reply.signedIn.resumed === 1; ask k1 'allowed'; signinPending {}; r1 'dispatched' with a new agentTaskIds[0]; run 'awaiting_browser'
  // the device posts a signed-in page for the new task → the run completes, and the bot's envelope holds that page
});
test('any bot\'s tab in the account answers it; a bot with no account answers nothing', async t => {});
test('two runs and a 1:1 chat on one account: a hand back resumes all three', async t => {});
test('Not now denies every held page and each run takes its declined turn', async t => {
  // POST /api/asks/k1 {answer: 'decline'} → requests 'denied'; each run's next envelope says it was declined: 'signing in to crm.example.com as Sales'
  // POST /api/asks/k1 {answer: 'allow'} on a fresh card → 409, with the refusal sentence
});
test('24 hours with no sign-in end it like Not now, with the expired line', async t => {
  // expirePendingAsks(store, {now: +24h+1s}) → ask.expired, requests denied, runs resumed; answeredText 'No sign-in in 24 hours, so the task went on without it'
});
test('a hand back while another page of the round is still out waits for it, then goes on with both', async t => {});
test('a hand back without signing in holds the page once more; the third wall goes to the bot', async t => {});
test('after the re-dispatch, a late result for the first task is ignored and the new task\'s result completes the run', async t => {});
test('deleting an account declines its open card', async t => {});
```

- [ ] **Step 2: Run the tests and see them fail.** Run `node --test tests/signin-release.test.js`. Expected: FAIL, because `releaseSignin` does not exist.
- [ ] **Step 3: Implement.**
  - The hand back calls `hub.handback` first, as now, and then `finishSignin`.
  - The re-dispatched task waits on the device until the hand back reaches it, because `acquire` waits while `driving?.key === key` (`agent/shared-browser.mjs:245`).
- [ ] **Step 4: Run the tests and the suite.** Run `node --test tests/signin-release.test.js tests/ask-runs.test.js tests/browser-live-devices.test.js && npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/signin-wait.js src/ask-runs.js src/coordination.js src/routes-live.js src/routes-browser-accounts.js tests/signin-release.test.js && git commit -m "feat: hand back signs the account's card in and every waiting run carries on; Not now and expiry release them"`

---

### Task 5: On the device, the account's wall and one typed memory per account

**Files:**
- Modify `agent/shared-browser.mjs`:
  - `noteResult` (`:307-319`) takes the task's `url` and uses `accountWall` for `signed-out`, keeping `onSite(host, site)` for `signed-in`;
  - `openTab` (`:232`) gives an account's tab the account's typed set;
  - `letGo` (`:515-529`) and `forget` (`:113-121`) clear it.
- Test: extend `tests/shared-browser-keepers.test.js` and `tests/shared-browser-accounts.test.js`.

**Interfaces:**
- Consumes Task 1: `accountWall` and `onSite` from `shared/browser-accounts.js`.
- Produces: nothing new on the wire. `accountStates()` now reads `signed-out` for an IdP wall, and `scrubTyped` hides, in every tab of an account, what was typed in secret in any of them.

- [ ] **Step 1: Write the failing tests.**

```js
test('a keeper sent to an IdP with no way back marks the account signed out', async t => {
  // pages['https://crm.example.com/'] → finalUrl 'https://accounts.google.com/v3/signin/identifier'
  // after sweep: accountStates() is [{id: A, state: 'signed-out', storage: 'cookies'}]
});
test('what the owner types in secret on one bot\'s account tab is hidden in another bot\'s tab of that account', async t => {
  // takeover('scout', A); applyInput('scout', {type: 'type', text: 'hunter22-marker', secret: true}); handback('scout')
  // run('writer', {url: echo, account: A}) → JSON of the result has no 'hunter22-marker', and has '[hidden]'
  // run('atlas', {url: echo}) with no account → unchanged: a tab with no account keeps its own memory
});
test('letting an account go forgets what was typed on it', async t => {});
```

The existing test at `tests/shared-browser-takeover.test.js:130-153` uses no account, and must still pass unchanged.

- [ ] **Step 2: Run the tests and see them fail.** Run `node --test tests/shared-browser-keepers.test.js tests/shared-browser-accounts.test.js`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** Use one `Map<account, Set>`. `rememberTyped` already bounds each set to 50.
- [ ] **Step 4: Run the tests and the suite.** Run `node --test tests/shared-browser*.test.js tests/planted-secret.test.js && npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add agent/shared-browser.mjs tests/shared-browser-keepers.test.js tests/shared-browser-accounts.test.js && git commit -m "feat: the device reads an IdP wall as the account signed out, and keeps one typed-secret memory per account"`

---

### Task 6: The sign-in card on screen

**Files:**
- Modify `shared/ui-asks.js:25-46`: `askCard` gets a sign-in branch.
- Modify `shared/ui-conversation.js`:
  - `BROWSER_STATUS` (`:112`) gains `signin`;
  - `askEntry` (`:138-153`) paints a `signin` choice as `btn('Take control', 'signin-take-control', …)`;
  - move the body of the setup card's signin branch (`:558-565`) into one `takeControl(botId, url)`, used by that branch and by the new `'signin-take-control'` action;
  - the `ask-answer` action keeps Not now as `decline`.
- Modify `shared/ui-computer-view.js:342-345`: the hand back toast uses `signedIn` from the reply.
- Regenerate `docs/`.
- Test: extend `tests/ui-asks.test.js` and `tests/usability_smoke.py`.

**Interfaces:**
- Consumes Task 1: the ask shape and `answeredText`. Consumes Task 4: the handback reply's `signedIn`.
- Produces: `askCard(state, line)` for a sign-in ask gives `{open: true, ask, askId, botId, botName, text, question: <the card's line>, note: <the card's note>, choices: [{id: 'signin', label: 'Take control', primary: true}, {id: 'decline', label: 'Not now', primary: false}], target: '', body: '', url: ask.url}`. Answered, it collapses to `answeredText`.

- [ ] **Step 1: Write the failing tests.** In `tests/ui-asks.test.js`, cover:
  - a pending sign-in ask: the question, the note and the two choices, and no Allow once or Always allow;
  - each of the three answered lines;
  - the Needs you copy, which reads `You signed in (Scout)`.
- [ ] **Step 2: Add the smoke scenarios** to `tests/usability_smoke.py`. Each seeds one sign-in ask with a `seed_asks`-like script that writes `kind: 'signin'`, `accountName`, `site` and `url`.
  - `sign-in: the card names the bot, the site and the account, with Take control and Not now and no Allow`. The bot's row and Atlas's face carry the count 1.
  - `sign-in: Take control opens the Computer view on the site, and Hand back says the task carries on`.
    - Set the `agent-backend` meta to `server`, and answer `/api/browser-live*` with `Live`, whose handback reply carries `signedIn: {resumed: 1}`.
    - Assert that the posts are `takeover`, then `input` `{type: 'navigate', url: 'https://crm.example.com/'}`, then `handback`.
    - Assert the hash `#profile/<bot>/computer`, and the toast `Signed in. Writer's task carries on.`
  - `sign-in: Not now collapses the card to "You chose not now"`. This goes through the demo's `POST /api/asks/:id`.
  - `sign-in: the demo says signing in needs the app`. Leave the meta static: Take control toasts the demo line and posts nothing.
  - `phone: the sign-in card and Take control fit, thumb-sized` (`PHONE`).
- [ ] **Step 3: Run them and see them fail.** Run `node --test tests/ui-asks.test.js`, then `SMOKE_ONLY=sign-in npm run test:ui`. Expected: FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run the tests, the build and the smokes.** Run `node --test tests/ui-asks.test.js tests/pages-bundle.test.js && npm run build:pages && npm test && npm run test:ui`. Expected: PASS, with no drift.
- [ ] **Step 6: Commit.** `git add shared/ui-asks.js shared/ui-conversation.js shared/ui-computer-view.js docs tests/ui-asks.test.js tests/usability_smoke.py && git commit -m "feat: the sign-in card with Take control and Not now, and the hand back that says the task carries on"`

---

### Task 7: Done when you can see it, docs and the tick

**Files:**
- Test: `tests/signin-from-phone.test.js` (new).
- Modify these docs:
  - `AGENTS.md`: a "Sign-in from the phone" paragraph under Security. It names `src/signin-wait.js`, the `signin` ask and request status, kv `signin_pending`, `MAX_SIGNIN_HOLDS`, the quiet push with its route, and hand back, Not now and expiry.
  - `docs/AGENT-PROTOCOL.md`: the IdP wall and the per-account typed memory.
  - `docs/DEPLOYMENT.md`: signing in from a phone needs HTTPS or `TRUST_PROXY=1`, and a sign-in push waits out `QUIET_HOURS`.
  - `README.md:46-47`: the sign-in bullets. This also fixes the stale "every bot is signed in" line at `:47`, left from Phase 2.
  - `docs/BUILD-PLAN.md:241`: the tick.

**Interfaces:**
- Consumes all tasks.

- [ ] **Step 1: Write the test.**

```js
test('a keeper finds an account signed out, the phone is told, the owner signs in from it, and the waiting run carries on by itself', async t => {
  // createApp harness, a notify recorder, a paired device with browser-accounts-v1 + secret-input-v1, bot web on account A
  // 1. beat A signed-in, then signed-out → one card, one notify {kind: 'signin', urgent: false, route: '#bot/web'}
  // 2. a run asks web for https://crm.example.com/reports; the device claims the task and posts the wall → the request is held on the same card, no second notify
  // 3. POST takeover; POST input {type: 'navigate', url: 'https://crm.example.com/'} and two {type: 'type', secret: true} over an https request; POST handback
  // 4. the next beat claims a new task for the request; the device posts 'Reports for Sales' → the run completes, and its last reply used that page
  // 5. healthIssues over the store's tasks is []
});
```

- [ ] **Step 2: Run it.** Run `node --test tests/signin-from-phone.test.js`. Expected: PASS. If it fails, fix the owning task's code in a separate commit that names that task.
- [ ] **Step 3: Make the doc edits.**
- [ ] **Step 4: Run the full gate.** Run `npm run check && npm test && npm run build:pages && npm run test:ui`. Expected: PASS, with no drift.
- [ ] **Step 5: See it work** (§15 row 3):
  1. Set up the server so the phone reaches it over HTTPS: `tailscale serve` or Caddy with `TRUST_PROXY=1`. Check that `QUIET_HOURS` is not now, and turn on push on the phone in Settings → Notifications.
  2. Add an account of a real site on the computer, give a bot that account, sign in once from its Computer view, and let the keeper read `Signed in`.
  3. Sign that account out from another browser (or clear its session on the site). Then wait for the keeper, up to 30 minutes, or restart the device app to make it check sooner.
  4. The phone buzzes with `Sign in to <site>`, and a tap opens the bot's chat at the card.
  5. Ask the bot to read a page behind the sign-in. Its run waits on the same card, and no second buzz comes.
  6. On the phone, tap Take control, sign in through the Password and Code fields, and tap Hand back.
  7. The run carries on with no further tap, and its reply reads the signed-in page.
  8. Write the results in the commit body.
- [ ] **Step 6: Commit.** `git add tests/signin-from-phone.test.js AGENTS.md README.md docs/AGENT-PROTOCOL.md docs/DEPLOYMENT.md docs/BUILD-PLAN.md && git commit -m "docs: sign-in from the phone; tick Phase AA step 3"`

---

## Spec coverage (§6.3)

| Spec item | Task |
|---|---|
| A sign-in page result posts a `signin` card naming the account, the service and the bot | 1, 2, 6 |
| A keeper finding the account signed out posts the card | 3, 5 |
| The card is pushed, not urgent, respecting quiet hours | 2 |
| One card per account until answered, across runs: kv `signin_pending` | 1, 2, 4 |
| Replaces `signinOffered` and `signinNoticed` for accounts | 1, 2 (Call 18) |
| The run parks as `awaiting_ask` on a sign-in ask | 2 |
| The 24-hour expiry ends it if nobody signs in | 1, 4 |
| The browser request is held in a `signin` status that `expireBrowserTasks` skips | 1, 2. `expireBrowserTasks` reads only `dispatched` (`src/bot-browser.js:304`); Task 2's test asserts it. |
| Late-work checks ignore it | 7 (Call 23) |
| Take control opens the account's tab and navigates | 6 |
| Hand back marks the ask answered and re-dispatches the request | 4 |
| §13.1: the bot's chat and the group chat, Needs you | 2 (the ask's chat and the primary's Needs you), 6 |
| §13.2: the demo says it needs the server | 6 |
| §6.1: a typed secret never leaves the device | 5 |

## Phase 2 leftovers taken in this phase

| Leftover | Where |
|---|---|
| Task 10: "any visible password input marks a sign-in wall; pin the choice with a test later" | Task 1 (the two-step login test) |
| Task 10: the host fallback accepts localhost, an IP or `.internal` | Task 1, for accounts: a wall counts only on the account's site, and that site is a real host name. The default profile is unchanged (carried below). |
| Task 8: an IdP redirect with no return parameter gives no finding (Call 21 counts any IdP landing) | Tasks 1 and 5 (Call 21) |
| Re-review: `README.md:47` still says every bot shares one signed-in profile | Task 7 |

## Optional (not in the steps)

- A line in the Computer view while the bot's account has an open card, saying what to do.
- A Sign in button on a signed-out account's row in Settings → Local agents, opening the first bot on it.
- A route on the other pushes (asks, watches, health), now that `announce` carries one.

## Out of scope

- **The default profile's sign-in** (bots with no account). It keeps today's model-sent setup card and `signinNotice` (Call 1).
- **The profile fallback (`storage: 'profile'`) and a site that keeps its sign-in outside cookies.** These are deferred by §15. A `lost` account still gets the card. Signing in again is all the owner can do until the fallback ships.
- **A password manager that hands over an item id** (§6.2, later).
- **Signed-out accounts a goal needs in Needs you** (§13.1). That is Phase 4.

## Done when

- `npm run check`, `npm test`, `npm run build:pages` (with no drift) and `npm run test:ui` pass.
- The five Review Focus cases each have a passing test.
- `tests/signin-from-phone.test.js` passes.
- The manual phone check in Task 7 has been seen working.

## Carried from Phase 2

These are from the Phase 2 final review's LEAVE rows and the final re-review's Minors and Out-of-Scope notes. Rows already resolved there are not repeated.

**Re-pairing**
- A second pair proof, so that removing either computer between the pair and the first heartbeat keeps the accounts. `finishReplacement` skips an old row the owner revoked (`src/bot-browser.js:349`).
- `agent_replaces:<id>` records never expire. Drop one whose old id beats again, or give it a TTL (`src/agent.js:287`).
- A persistent `finishReplacement` failure leaves the computer reading online while it gets no work, because `touchAgent` runs first (`src/routes-public.js:209-211`).
- A beat that retries after the move writes the "A local agent was replaced…" activity line twice (`src/bot-browser.js:353`).
- A crash between the revoke and the page finish of `finishReplacement` leaves the old row's requests `dispatched` until browser expiry (`src/bot-browser.js:356-367`).
- An owner PATCH that moves an account to the old id while the move runs lands on a row that is then revoked. It fails closed (`src/bot-browser.js:349-354`).

**Device and pages**
- `blockedRequests` counts other tabs' proxy refusals (`agent/browser.mjs:479`, `:570`, `:595`).
- `MAX_ELEMENTS = 60` can hide a login form from `signinPage` (`agent/browser.mjs:68`).
- On the default profile, the `signinPage` host fallback accepts localhost, an IP or `.internal` (`shared/bot-browser.js:291`).
- `KEEPER` is not a reserved bot id. A one-line refusal in `runBrowserTask` is optional (`agent/shared-browser.mjs:69`, `:639`).
- `savedAt` is stamped after a failed save, so the retry comes 10 minutes later instead of 1 (`agent/shared-browser.mjs:569`, `:575`).
- The `scrub` account argument is dead (`agent/shared-browser.mjs:616`). The unused `current` and `jars` on the host are test seams (`agent/browser-host.mjs`).
- The conflict sentence says "another bot's tab" for one bot on two accounts (`agent/shared-browser.mjs:335`).

**Jars and the lock**
- Jars:
  - there is no folder fsync after a jar or config rename (`agent/account-jars.mjs:61-75`, `agent/agent.mjs:79-100`);
  - `retain` leaves a stray `<id>.jar.tmp` for kept ids;
  - `chmodSync(dir)` follows a symlinked folder (`agent/account-jars.mjs:64`);
  - the failed-rename path of `rekeyJars` is untested (`agent/account-jars.mjs:123-135`).
- Lock staleness on pid reuse, a server-started `run` refused while the previous one drains (about 60 s), and the judge-then-unlink window, all in `agent/agent-lock.mjs`.

**Server and routes**
- The stale `agent_accounts:` and `agent_features:<oldId>` rows survive a revoke (`src/agent.js:545`).
- The route's existence checks run before `c.store.update`. This fails closed (`src/routes-browser-accounts.js`).
- The route has no tests of its own for a 404, the limit, a duplicate or `storage: 'profile'`. The pure tests cover each (`tests/browser-accounts.test.js:14-60`).
- An account with no `deviceId` would fall back to the bot's pin. This cannot be reached (`shared/browser-accounts.js:106`).
- The `ACCOUNT_NOT_PINNED` wording is used for a computer that lacks the permission (`src/bot-browser.js:50`).
- "This bot's browser account changed. Approve again." is not in Phase 2's sentence list (`src/bot-browser.js:121`).
- The live view's refusal hand-builds `hub.view`'s shape, and unadopted spaces are kept (`src/routes-live.js:90`).
- The live hub is not told on a revoke, so it is at most about 45 s stale (`src/routes-account.js:145`).
- An unheld, unpinned bot's view follows the last poller. This is Phase 2 Call 13, by design (`src/routes-live.js:62-67`).

**UI**
- `pairedChoices` offers computers that lack `browser-accounts-v1` (`shared/ui-admin.js:191`).
- Cosmetics on the accounts page (`shared/ui-admin.js:191-215`, `:731`, `:915`):
  - run the two fetches with `Promise.all`;
  - "No computer" repeats;
  - a textarea name;
  - "is removed".

**Tests**
- `serverIn` should pass `LOCAL_AGENT: '0'`. Without the npm preload the spawned server runs its own agent and can wipe the test's jar (`tests/agent-accounts-e2e.test.js:49`).
- Wall-clock sleeps (a 1500 ms race) in `tests/shared-browser-accounts.test.js`.
- A misnamed test in `tests/browser-account-dispatch.test.js`.
- The wrong-proof test passed before the feature existed (`tests/browser-account-heartbeat.test.js`).

**Phase 1b**
- The parked 1b minors, left as they are:
  - the helper turn note;
  - the `''` key;
  - `fallbacksOf` by model name;
  - the `ui-admin` fallback select;
  - handoff ranking;
  - the `search_chat` cap;
  - the block-only fallback;
  - the fallback e2e timing.

**Rulings kept**
- A restore to the same install loses every jar (§9.4).
- The lock is stale on our own pid, a dead pid, or an mtime over 2 minutes.
- The `CRM` and `crm.example.com` placeholders stay.
- Phase 2's manual two-account check on a real site, with a device restart, is still the owner's to do, because it needs their sign-ins.
