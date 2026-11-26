# Reply Popover and Learning from the Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove Copy and Teach. Bots learn from corrections and from 👍 / 👎, and announce what they learned with
Undo. Holding a bot reply opens a popover anchored at it, with feedback, an ask box and six actions.

**Architecture:**
- The learning rules are pure functions in `shared/memory.js`. The server wires them into the bot-chat send route, a
  new feedback route and the consolidation pass. The pass writes `learned` lines into the chat.
- The popover has a pure model, `shared/reply-menu.js`: which items show, the quote text, the question a reply
  answered, message pins and placement. Its DOM half is `shared/ui-reply-menu.js`: open and close, the gestures, the
  action handlers, the pins strip and the hint.

**Tech Stack:** Node 22, `node:test`, plain ES modules, Playwright smokes. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-26-reply-popover-design.md`

## Global Constraints

- Zero npm runtime dependencies.
- `shared/` stays browser-safe.
- `reply-menu.js` is pure (no DOM, no globals), because Node tests import it.
- Every new shared module is listed in `shared/assets.js`. Run `npm run build:pages` after `shared/` edits.
- New routes go through `router.add` with a role. The feedback route is `member`.
- Hold: `HOLD` is 420 ms. A touch moving 9 px before the hold arms cancels it.
- Popover margin is 12 px from the viewport edges, and it never overlaps the composer.
- Corrections list: newest 12, each `{said, reply ≤300 chars, at}`. Liked list: newest 6, each `{reply, at}`.
- At most 3 `learned` lines per pass. Pins: at most 20 per chat, newest first, under `ac-msg-pins`. Hint key:
  `ac-hold-hint`.
- Copy, exactly as written:
  - "Thanks, noted"
  - "What was wrong?"
  - "Ask about this…"
  - "About the selected part"
  - "Follow up on this."
  - "Copied. Paste it where you want to share it."
  - "Tip: hold a reply for more. On a computer, right-click it."
  - "Learned: <rule>"
  - "Undo"
  - "Switched off"
  - "📌 N pinned"
- Gate: `npm run check && npm test && npm run build:pages`, with a clean `git status` afterwards. Then
  `npm run test:ui`.

## Review Focus

- "no problem", "no worries" and any question must not count as a correction (Task 1 test).
- A browser-written chat line with `kind: 'learned'` or a `ruleId` must not survive. A forged Undo is then impossible
  (Task 2 test).
- A reworded rule that the owner switched off stays off, and is not announced again (Task 1 test).
- A bot whose memory is off stores no correction or feedback. The route refuses with 409 (Task 2 test).
- Feedback naming a message that is not that bot's reply in that chat gets a 404, and the reply text comes from the
  store, not the body (Task 2 test).

---

### Task 1: Learning rules (pure)

**Files:**
- Modify: `shared/memory.js`
- Test: `tests/memory-learning.test.js`

**Interfaces (produces):**
- `isCorrection(text) -> boolean`
- `correctionFrom(messages, text, botId) -> {said, reply} | null`. The newest message must be a bot reply by
  `botId` (or with no `senderId`). A trailing owner line equal to `text` is skipped first. It returns null unless
  `isCorrection(text)`.
- `noteCorrection(state, key, {said, reply}, {now}) -> book`
- `noteLiked(state, key, {reply}, {now}) -> book`
- `consolidationDue(book, now)`: also true when `corrections` or `liked` is non-empty. The cooldown is unchanged.
- `consolidationInput(...)`: adds `corrections`, `likedReplies`, and `rejectedRules` (the texts of disabled rules).
- `consolidationInstructions()`: adds two lines.
  - "Turn a correction into a rule only when it states a lasting preference about how this bot should work; ignore
    one-off fixes to a single task. Treat liked replies as examples of the style to keep."
  - "Never write a rule listed in rejectedRules again."
- `mergeConsolidation(state, key, result, {..., sentCorrections, sentLiked})`:
  - Clears the sent items.
  - A kept text that is `sameNote` as a disabled rule stays disabled.
  - It returns the book. It sets `book.announce` to at most 3 `{id, text}`: rules new by `sameNote` against every
    rule that was there before, only when `sentCorrections.length > 0`.

- [ ] Write the tests.
  - `isCorrection` is true for:
    - "No, too long"
    - "nope, use rupees"
    - "Wrong, it's Tuesday"
    - "That's not what I asked"
    - "I meant the other file"
    - "Too formal"
    - "Use bullet points instead"
    - "Stop doing that"
  - `isCorrection` is false for:
    - "No problem"
    - "no worries, thanks"
    - "Is that wrong?"
    - "Find the invoice"
    - ""
  - `correctionFrom`:
    - It finds the reply before a trailing equal owner line.
    - It returns null when the newest message is from another bot, or is not a reply.
  - `noteCorrection` caps at 12 and trims `reply` to 300 characters.
  - `consolidationDue` is true with one correction and no cooldown, and false inside the cooldown.
  - `consolidationInput` carries all three lists.
  - Merge:
    - Corrections that were sent are cleared, and ones that arrived meanwhile are kept.
    - A reworded disabled rule stays `enabled: false`.
    - A new rule is announced only with corrections sent.
    - A reworded old rule is not announced.
    - At most 3 rules are announced.
- [ ] Run `node --test tests/memory-learning.test.js`. Expected: fail.
- [ ] Implement it. Cues for `isCorrection`:
  - It starts with no, nope, wrong, not quite or not like that.
  - It contains that's not, that is not, i said, i meant, too long, too short, too formal, instead, or stop doing.
  - A trailing `?`, or a start of "no problem" or "no worries", is never a correction.
- [ ] Run the tests. Expected: pass. Run `npm test`, which must stay green.
- [ ] Commit `feat: bots learn from corrections and liked replies (rules)`.

### Task 2: Server wiring, demo parity and trust

**Files:**
- Modify: `src/routes-groups.js`
- Modify: `src/routes-memory.js`
- Modify: `src/memory.js`
- Modify: `shared/chats.js`
- Modify: `shared/local-api.js`
- Modify: `tests/route-roles.test.js`
- Test: `tests/memory-feedback.test.js`

**Interfaces:**
- Consumes everything Task 1 produces.
- Produces:
  - `POST /api/memory/feedback {bot, chat, message, kind: 'up' | 'down', note?}` returns `{ok: true}`.
  - Chat messages `{role: 'system', kind: 'learned', text, ruleId, off?}`.
  - `markLearned(state, ruleId, off)` in `shared/chats.js`.

- [ ] Write the tests, against a spawned server or the router with a store, as `tests/api.test.js` does.
  - Feedback:
    - `down` with a note stores a correction, with `reply` taken from the stored message.
    - `up` stores liked.
    - A message id that is not a bot reply in that chat gets a 404.
    - A bot with memory off gets a 409.
    - A viewer gets a 403.
  - Chat route:
    - A bot-chat message "No, shorter" right after that bot's reply stores one correction.
    - The same text in a thread (`team-…` key) stores none.
  - Consolidation:
    - A pass with an injected executor returning a new rule, run after a correction, adds one `learned` line to the
      chat, with its `ruleId`.
  - Trust:
    - `addChatMessages` from a browser drops `kind: 'learned'` and `ruleId`.
  - Undo:
    - `PATCH /api/memory/rules/:id {enabled: false}` sets `off: true` on that rule's learned line.
- [ ] Run them. Expected: fail.
- [ ] Implement it.
  - In `POST /api/groups/:group/chat`: when `directBotId` is set and the chat key (`b.chatKey || directBotId`) equals
    it, run `correctionFrom` on `state.chats[key]` and the message, inside `store.update`. On a hit, call
    `noteCorrection` on `botKey(directBotId)`. Skip this when `botSettings(bot).memory === false`. Do it before
    `queueGroupRun`.
  - In the feedback route:
    - Check the bot, the chat and that the message is a `bot` message by that bot.
    - Then call `noteCorrection` (down, with a note) or `noteLiked` (up).
    - For `down` with a note, also start `maybeConsolidate` with `resolveConfig(c.store, bot)`. Do it
      fire-and-forget, through `c.store.trackWork` when it exists.
  - In `consolidateModel`: pass the sent lists, and after the merge write `book.announce` as learned lines through
    `chats.addChatMessages(s, chatKey, lines, {trusted: true})`. Then delete `book.announce`.
  - In `shared/chats.js`: `LABELS` gains `ruleId` and `off`. `untrusted()` deletes `ruleId` and `off`, and deletes
    `kind` when it is `learned`. Add `markLearned`.
  - The PATCH-enabled branch calls `markLearned`. `local-api.js` gets the same feedback route and the same
    `markLearned` call. The demo stores feedback and runs no pass.
  - Add the feedback route to `tests/route-roles.test.js` wherever routes are listed by role.
- [ ] Run the tests, then `npm test`. Expected: pass.
- [ ] Commit `feat: corrections, 👍 and 👎 reach the bot's memory, and what it learned is said in the chat`.

### Task 3: The learned line in the feed

**Files:**
- Modify: `shared/ui-feed.js`
- Modify: `shared/ui-model.js`
- Modify: `shared/ui-conversation.js`
- Modify: `shared/shell.css`
- Test: `tests/ui-feed.test.js` (add cases)

- [ ] Write a test: a system message with `kind: 'learned'` becomes the entry `{kind: 'learned', message}`. It is
  never a run note: `isRunNote` is false, and `learned` is in `RUN_LESS_KINDS`.
- [ ] Run it. Expected: fail.
- [ ] Implement it.
  - The feed branch is placed before the `isRunNote` fallthrough.
  - `learnedEntry` draws one quiet line, "Learned: <text>". It has an Undo button
    (`data-action="learned-undo" data-rule`) while `!m.off` and the person can write; otherwise it shows
    "Switched off".
  - The action PATCHes `{enabled: false}`, then calls `sync()`.
- [ ] Run the tests. Expected: pass.
- [ ] Commit `feat: a quiet Learned line with Undo`.

### Task 4: The popover model (pure)

**Files:**
- Create: `shared/reply-menu.js`
- Test: `tests/reply-menu.test.js`

**Interfaces (produces):**
- `menuItems({canWrite, touch, memoryOn, canRetry, canTemplate, pinned}) -> [{id, label, glyph}]`
  - The ids, in order: `copy`, `retry`, `share`, `pin`, `thread`, `template`, `select`.
  - The pin label is "Pin" or "Unpin". `select` appears only with `touch`.
  - A viewer gets copy, share, pin and select.
- `showFeedback({canWrite, memoryOn}) -> boolean`
- `quoteText(text) -> string`: a Markdown blockquote of each line, at most 1200 characters, with an ellipsis when
  cut.
- `askText(quoted, words) -> string`: the quote, a blank line, then the words.
- `threadText(quoted, words)`: as `askText`, with "Follow up on this." when `words` is empty.
- `askedBefore(messages, messageId) -> string | ''`: the text of the nearest owner line before that message, with no
  other bot reply in between.
- `togglePin(pins, chatKey, id) -> pins`: newest first, capped at 20.
- `pinsOf(pins, chatKey, ids) -> string[]`: drops ids not in `ids`.
- `placePopover(anchor, size, view, composerTop) -> {left, top, below}`
- `hintFor(entries, seen) -> messageId | null`: the first bot reply with an owner line before it, while not `seen`.

- [ ] Write tests for every function above:
  - The viewer set, and `select` showing only on touch.
  - Placement: below when there is room, above otherwise, clamped to the 12 px margin and above `composerTop`.
  - The quote cut, the pin cap and order, and that stale pins are dropped.
- [ ] Run it, expect a failure, implement it, then run until it passes. Add `'reply-menu.js'` to `shared/assets.js`.
- [ ] Commit `feat: the reply popover's rules (pure)`.

### Task 5: The popover, gestures, pins and hint; Copy and Teach removed

**Files:**
- Create: `shared/ui-reply-menu.js`
- Modify: `shared/ui-conversation.js` (remove `.cv-acts`, `copy-reply`, `teach-reply` and `replyText`; add
  `tabindex="0"` to `.cv-bot`; draw the pins strip and the hint)
- Modify: `shared/ui-model.js` (remove `teachPrompt` and `teachRule`)
- Modify: `shared/ui-kit.js` (glyphs `share`, `retry`, `up`, `down`, `cursor`)
- Modify: `shared/app.js` (call `wireReplyMenu()` once)
- Modify: `shared/assets.js`
- Modify: `shared/shell.css` (remove the `.cv-acts` rules; add `.rmenu`, `.cv-pins`, `.cv-hint`; reduced motion)
- Delete: `tests/teach-reply.test.js`
- Modify: `tests/usability_smoke.py`

- [ ] Wire the gestures.
  - Pointer handlers on `.cv-bot` inside `#main`. Touch opens after `HOLD` with the 9 px cancel. The click that ends a
    hold is swallowed.
  - `contextmenu` opens at the pointer on a mouse.
  - The ContextMenu key or Shift+F10 opens it on a focused `.cv-bot`.
  - `-webkit-touch-callout: none` and `user-select: none` apply to `.cv-bot` on touch screens, until Select text is
    tapped.
- [ ] Build the popover.
  - It is `role="menu"`, placed by `placePopover`, with focus trapped inside.
  - Escape, a click outside, a feed scroll, or a route change closes it and returns focus to the reply.
  - It captures the selection inside that reply at open time.
- [ ] Wire the actions.
  - **Copy:** the clipboard.
  - **Try again:** in a bot chat, `sendChat(id, askedBefore(...))`. In a thread, `rerun` with `retryTarget` for the
    reply's run.
  - **Share:** `navigator.share`, else copy with the fallback toast.
  - **Pin:** `togglePin` and `saveLocal`, then redraw.
  - **Start a thread:** `startThread(threadText)`.
  - **Save as template:** `POST /api/templates {text: askedBefore}`.
  - **Select text:** adds `.cv-select` to that reply.
  - **The ask box:** `sendChat(id, askText(...))`.
  - **👍 / 👎:** `POST /api/memory/feedback`. 👎 first shows the note field.
- [ ] Draw the pins strip ("📌 N pinned") under the header. It lists its pins, and tapping one scrolls to the reply
  and flashes it. Draw the hint under `hintFor`, with a ×. Opening any popover sets `ac-hold-hint`.
- [ ] Update the usability smoke.
  - Drop the `.cv-acts` check.
  - Add: right-click a bot reply opens `.rmenu`. Copy, Pin and Ask are present. Escape closes it. Pinning shows the
    strip.
- [ ] Run `npm run check`, `npm test`, `npm run build:pages` and `npm run test:ui`. Expected: pass.
- [ ] Commit `feat: hold a reply for a popover with feedback, ask and actions; Copy and Teach removed`.

### Task 6: Docs and the gate

- [ ] Update the docs:
  - AGENTS.md: replace the Copy and Teach sentence with one on the popover, `reply-menu.js` / `ui-reply-menu.js`,
    the feedback route and learned lines.
  - Add `ac-msg-pins` and `ac-hold-hint` to its per-person list.
  - CHANGELOG, under Unreleased.
  - `docs/FEATURE-RESEARCH.md`: the line that names `teach-reply`.
- [ ] Run the full gate. Afterwards `git status` must be clean.
- [ ] Commit `docs: the reply popover and learning from the chat`.
