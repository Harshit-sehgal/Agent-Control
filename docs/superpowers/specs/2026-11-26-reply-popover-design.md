# Reply popover and learning from the chat — design

## Why

The owner found the Copy and Teach bar under bot replies unintuitive: it is hidden until hover, it sits on the reply's
edge, and "Teach" does not say what it does. They want it gone. Teaching should happen inside the system, from the
conversation itself: bots keep their own rulebook and chat notes. Holding a reply opens a small window, anchored at
the reply, for more prompts and more actions.

## Goals

- No buttons on replies. Holding a bot reply opens a popover at that reply: a long press on a touch screen, a
  right-click on a computer, the menu key or Shift+F10 from the keyboard.
- The popover gives feedback (👍 / 👎), an "Ask about this" box, and actions: Copy, Try again, Share, Pin, Start a
  thread, Save as template.
- Bots learn from plain corrections ("no, too long", "wrong, use rupees") and from 👎 notes, not only from
  "always / never / from now on" sentences. When a bot learns a rule from a chat, that chat shows one quiet line,
  "Learned: …", with Undo.
- The gesture can be found: a one-time hint tells the owner to hold a reply.

## Non-goals

- No separate mini-conversation about a reply. "Ask about this" sends into the same chat.
- No reactions shown on messages, and no read receipts.
- No change to what the company notebook is or who writes it.
- No change to the existing rule extraction, consolidation cooldown or rule limits, except what is listed below.

## Anti-goals (failure even if it works)

- A rule is learned from a one-off fix ("no, the Tuesday file") and quietly changes every later turn. Lessons must be
  lasting preferences, every learned rule is visible in the chat where it was learned, and Undo is one tap.
- The long press breaks scrolling, or a scroll opens the popover.
- A popover that cannot be closed with Escape, by tapping outside, or by scrolling.
- Any teaching or feedback path that widens what a bot may do (permissions stay with the ask mechanism).

## Approaches considered

- **A. One sheet** (slides up on a phone, centred on a computer). It reuses the app's sheets and is the least code.
- **B. A popover anchored at the reply, like iMessage.** Chosen by the owner. It feels native and keeps the reply in
  view. Placing it on small screens is the hard part.
- **C. A side window with its own mini-chat per reply.** This is the most literal "separate window", but it splits the
  conversation and needs new storage.

The owner picked **B**, plus all four improvements offered: the hint, asking about a selected part, 👍 / 👎, and
learning from corrections with a "Learned" line.

## Design

### The popover (B)

- **Opening it.**
  - On a touch screen, holding a bot reply (`.cv-bot`) for 420 ms opens it, with the same tolerances as the Chats
    home in `ui-gestures.js`: `HOLD` is 420 ms, and moving 9 px before the hold arms cancels it. Scrolling therefore
    never opens it.
  - The reply lifts slightly. Motion is reduced when the person asks for reduced motion.
  - The phone's own text-selection callout is suppressed on bot replies.
  - Right-click opens it at the pointer. A focused reply opens it with the menu key or Shift+F10; replies become
    focusable for this.
- **Where it sits.**
  - It is anchored to the reply: below it when there is room, above it otherwise.
  - It is kept inside the viewport with a 12 px margin, and never covers the composer.
  - On a phone it takes the screen width minus the margins.
- **Contents, top to bottom.**
  1. 👍 and 👎.
     - 👎 opens a one-line field in place, "What was wrong?". Sending it records the note as a correction (see
       Learning).
     - 👍 records that the owner liked this reply.
     - Both say "Thanks, noted" and leave the popover open.
  2. The "Ask about this…" box with a send button. It sends a new owner message in the same chat: the reply, or the
     selected part of it, quoted as a Markdown blockquote, then the owner's words. The popover then closes.
  3. Actions, as a vertical list of icon rows:
     - **Copy:** copies the reply, or the selected part of it.
     - **Try again:** works on any reply, old or new.
       - In a bot chat, it sends the owner message this reply answered again, as a new visible owner line at the
         bottom. The chat and the bot both see what was asked again. (Builder-check call.)
       - In a thread, it reruns the run this reply belongs to (`rerun` with `retryTarget`), as the existing Retry
         does.
       - It is hidden when there is nothing to resend.
     - **Share:** opens `navigator.share({text})` where the browser has it. Otherwise it copies the text and says
       "Copied. Paste it where you want to share it."
     - **Pin / Unpin:** see Pins.
     - **Start a thread:** starts a new thread (`startThread`) whose first message is the quoted reply followed by
       whatever is in the ask box. With an empty box, the line after the quote is "Follow up on this."
     - **Save as template:** saves **the owner message this reply answered**, not the reply. It goes through
       `POST /api/templates`, and the toast says the template now shows in the composer's Templates. It is hidden when
       there is no owner message before the reply.
     - **Select text** (touch screens only): closes the popover and makes that one reply's text selectable until the
       owner taps elsewhere.
- **Who sees what.** A viewer (`canWrite()` false) gets Copy, Share, Pin and Select text only.
- **Closing it.** Escape, a tap or click outside, scrolling the feed, or switching chats closes it. Focus returns to
  the reply. Tab stays inside the popover while it is open.
- **Asking about a selection.** On a computer, if text inside one bot reply is selected when the popover opens,
  Copy and the ask quote use the selection. The popover's header shows "About the selected part".

### Pins

- Pins are per person, on the device, through `saveLocal` under `ac-msg-pins`, like bot pins. The shape is
  `{[chatKey]: [messageId…]}`, with at most 20 per chat. The newest pin goes first.
- A chat with pins shows a slim strip under its header: "📌 N pinned". Tapping it lists them (first line of each,
  with the time). Tapping one scrolls to that reply and briefly highlights it.
- A pin whose message is gone is dropped when the chat is drawn.

### The hint

- The first time a person sees a bot reply that has an owner message before it, a small line appears under that
  reply: "Tip: hold a reply for more. On a computer, right-click it."
- It goes away once the person opens a popover or taps the line's ×.
- It is remembered with `saveLocal` under `ac-hold-hint`.

### Learning from the chat

- **Corrections.**
  - Only a **bot's own chat** records a correction from the text. There the bot that replied and the bot that reads
    the next message are the same.
  - In a thread, a correction is learned only through 👎 on a reply, which names the bot that wrote it.
    (Builder-check call: in a thread the next message may go to another bot.)
  - Detection runs once per owner message, in the bot-chat send route, before the turn starts. It does not run in
    `rememberTurn`, which runs once per run step and would store the same correction several times.
  - When that message comes right after a bot reply and reads as a correction, the bot's book stores
    `{said, reply, at}` in a new `book.corrections` list. `reply` is at most 300 characters; the list keeps the
    newest 12.
  - "Reads as a correction" is decided by a pure, tested `isCorrection(text)`. Cues include:
    - a start of "no", "nope", "wrong", "not quite" or "not like that";
    - "that's not" or "that is not";
    - "I said" or "I meant";
    - "too long", "too short" or "too formal";
    - "instead";
    - "stop doing".
  - A question is not a correction.
  - 👎 with a note stores the same shape, with `said` set to the note.
- **Liked replies.** 👍 stores `{reply, at}` in `book.liked`, keeping the newest 6.
- **When the pass runs.**
  - A correction or a liked reply counts as material: `consolidationDue` is true when either list is non-empty,
    still behind the existing 5-minute cooldown.
  - A 👎 note also starts a pass from the feedback route, through `maybeConsolidate` with the bot's resolved model
    config, under the same cooldown. That is at most one paid call per bot every 5 minutes.
  - A 👍 waits for the bot's next turn. (Builder-check call.)
- **What the pass is told.**
  - The consolidation input gets `corrections` and `likedReplies`.
  - The instructions gain this line: turn a correction into a rule only when it states a lasting preference about how
    this bot should work; ignore one-off fixes to a single task; treat liked replies as examples of the style to keep.
  - Both lists are cleared for the items the pass sent, as `pending` already is.
- **The "Learned" line.**
  - A pass announces rules only when it was sent at least one correction or 👎 note and had a `chatKey`.
  - A rule counts as new only when no rule already in the book, on or off, is the same note by `sameNote`. A
    rewording of a known rule is not announced. (Builder-check call: `mergeConsolidation` gives a reworded rule a
    fresh id.)
  - Each new rule adds a system message to that chat: `{role: 'system', kind: 'learned', text: rule, ruleId}`. There
    are at most 3 per pass.
  - `shared/chats.js` keeps `ruleId` in `LABELS`. `untrusted()` deletes `ruleId` and refuses `kind: 'learned'` from a
    browser, so only the server writes one.
  - The feed draws it in its own branch of `ui-feed.js`, not as a run note, and it is added to `RUN_LESS_KINDS`.
  - The feed draws it as one quiet line, "Learned: <rule>", with Undo.
  - Undo switches the rule off through the existing `PATCH /api/memory/rules/:id {enabled: false}`. The line then
    reads "Switched off".
  - A switched-off rule stays off when a later pass rewords it. `mergeConsolidation` keeps a kept text disabled when
    it is `sameNote` as a disabled rule, not only when the text is exactly the same.
  - The pass is also sent the disabled rules as `rejectedRules`, with the instruction not to write them again.
    (Builder-check call: Undo must stay one tap.)
  - Owner-written rules from "remember" / "from now on" are not announced; they are already in the owner's own words.
- **Where feedback is sent.** There is a new member route, `POST /api/memory/feedback`, with
  `{bot, chat, message, kind: 'up' | 'down', note?}`.
  - It reads the reply text from the stored message and never trusts the client for it.
  - It refuses a message that is not a bot reply in that chat, and refuses everything when the bot's memory is off.
  - It lives in `src/routes-memory.js`, and `shared/local-api.js` has the same route for the Pages demo. The demo has
    no model, so it stores the feedback and nothing more.
- **Memory off.** When a bot's memory is off (`botSettings(bot).memory === false`), nothing is stored, 👍 / 👎 are
  hidden, and corrections are not recorded.

### What is removed

- The `.cv-acts` bar, the `copy-reply` and `teach-reply` actions, and `teachPrompt` / `teachRule`.
- `tests/teach-reply.test.js` and the usability smoke's "teach" check. They are replaced by tests of the above.
- The Copy and Teach sentence in AGENTS.md. It is replaced by one sentence on the popover.

## Constraints

- No npm runtime dependencies.
- `shared/` stays browser-safe.
- New pure rules go in pure modules, so Node tests import them.
- A new shared module is listed in `shared/assets.js`, and `docs/` is rebuilt.
- The gate must stay green: `npm run check`, `npm test`, `npm run build:pages` with no drift, and `npm run test:ui`.
- The feedback route is registered through `src/router.js` with the `member` role, and route-role tests are updated.
- Popover copy is plain and short, in the app's voice.

## Left to the builder

- The popover's exact visuals, within the app's tokens: a raised surface, the app's radius and a soft shadow.
- Whether the popover is a new module (`ui-reply-menu.js` plus a pure `reply-menu.js`) or lives in
  `ui-conversation.js`. A new module is preferred, since `ui-conversation.js` is large.
- The exact wording of the correction cue list, as long as the tests pin the cases above and the cases that must not
  match (questions, and "no problem" or "no worries").
