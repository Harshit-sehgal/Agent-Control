# What to build next, and what to leave out

Written 2026-11-20. Built from three things: the code as it stands, the approved design in
`docs/superpowers/specs/2026-11-20-automation-and-remote-access-design.md`, and a short search of
current products. It is a working list, not a roadmap commitment. Each kept idea names the code it
builds on, so the cost is visible.

## What is different about this product, honestly

Human handoff on a live browser is not new. Cloudflare Browser Run has a human-in-the-loop Live View
flow ([changelog, 2026-07-28](https://developers.cloudflare.com/changelog/post/2026-07-28-human-in-the-loop/)),
BrowserAct pauses at login or approval and shares the session ([BrowserAct](https://www.browseract.com/blog/remote-assist-browser-automation-1782112684514)),
and handraise separates takeover (a capability gap) from approval (an authority boundary)
([handraise](https://github.com/Sy-D/handraise)). BrowserBird runs scheduled jobs with a VNC viewer
([BrowserBird](https://github.com/Owloops/browserbird)). No single piece is unique.

The combination is what this product has and most listed tools do not, in one self-hosted install:

- one owner, one private address behind Cloudflare Access (the owner's email only);
- a logged-in profile that lives on the owner's own server and survives restarts;
- takeover and handback on that same profile, not a fresh browser;
- approvals for anything that sends, posts, deletes or pays, with the owner's phone as the place they land;
- schedules that can be paused, resumed, or stopped for everything at once.

I have not checked every product in this space, so treat "most" as a claim to verify with
`/founder-competitors` before it appears in any sales copy.

## Built in this round (verified by tests and on the server)

| Piece | Where | Builds on |
| --- | --- | --- |
| Pause and resume one schedule | `shared/tasks.js` `pauseTask`, `resumeTask`; routes in `src/routes-workflow.js` | the task queue's status model |
| Kill switch: pause every schedule, hold new ones, survive restart | `pauseAllSchedules`, `resumeAllSchedules`, kv flag `schedules_paused` | `handsOff`'s persistence pattern |
| Weekday and weekend schedules | `DAY_RULES`, `skipToDays` in `shared/schedules.js` | the existing daily interval |
| Quiet hours for phone notices | `shared/quiet-hours.js`, `QUIET_HOURS` in `src/push.js` | web push and the notifications queue |
| Approval requests bypass quiet hours | `urgent` flag in `src/handlers.js` | the `ask` notification kind |
| Encrypted nightly backup, restore check | `deploy/backup-encrypted.sh`, `deploy/restore-encrypted.sh` | the existing data volume |

## Keep: next, in order of how much it changes what the owner can do

1. **Session health check.** A daily scheduled check that the X login still works. If it has expired,
   notify the owner so they can sign in from the live view. Builds on `bot-task` schedules and
   `src/bot-browser.js`. This is the one most worth doing first, because a silent expiry looks like
   a working bot.
2. **Per-site daily limit.** `shared/limits.js` caps pages and rounds per message, not per site per
   day. A daily cap per site stops a looping schedule from spending the account's goodwill.
3. **Screenshot in the action log.** `shared/activity-log.js` records what happened; the browser
   already produces screenshots for the live view. Storing the one taken before each send, post or
   delete lets the owner see what the bot saw when they approved it.
4. **Health alerts.** The app has `/api/health`, but nothing notices when the tunnel, the container or
   the nightly backup fails. A cron check that pushes an urgent notice covers this.
5. **Watch-and-tell.** A scheduled page read that notifies only when it changes. Needs a stored
   last-seen value; `src/memory.js` is the place for it.
6. **Drafts for approval.** The bot reads messages, writes replies, and queues each as an ask card.
   The send happens only after the owner taps Allow. The ask mechanism already does the sending part.

## Already present, so do not rebuild

- **Daily morning briefing:** `shared/briefing.js`.
- **Saved routines and templates:** `shared/templates.js`, `POST /api/templates`.
- **Export:** `src/backup.js` (a JSON export; unencrypted, which is why the nightly encrypted copy exists).
- **Per-message limits and a fail streak:** `shared/limits.js`, `FAIL_STREAK`.
- **Three-level safety presets:** `shared/presets.js`.
- **Schedule failure pause:** `MAX_FAILED_RUNS` in `shared/schedules.js`.

## Rejected, and why

- **Telegram notices.** Dropped by the owner; the phone app covers it.
- **Running the browser from the home IP.** Parked by the owner until they ask.
- **Public sign-up or several owners.** Out of scope; the Access rule admits one email.
- **Solving CAPTCHAs or bypassing bot checks.** The bot hands these to the owner in the live view.
- **Auto-posting without approval.** Breaks the anti-goal in the design doc.
- **A hosted cloud version.** It would move the browser profile off the owner's server, which is the point of the product.
- **A marketplace of workflows.** Premature until one workflow has real users.
- **Native Android beyond a Trusted Web Activity.** A native rewrite duplicates the web app.
- **Sending SMS or email alerts first.** Needs a sending domain or a carrier; push already reaches the phone.

## Not done in this round

- **Android Trusted Web Activity.** Not built. It needs a signing key, a Gradle build against the
  local SDK, and an `assetlinks.json` that Access does not block. Scheduled as the last item.
- **Competitor scan in depth.** Only the search above. Run `/founder-competitors` for a full pass.

## Round 2 (2026-11-21): decisions on the new feature list

Built, with tests: **Agent instincts** (`enabled` on a rule, a rule switched off stays out of every turn and
survives a tidy-up pass, `next time` counts as a correction) and **Event triggers** (signed
`POST /api/events/:workspace/:trigger`, dedup, cooldown, one-field condition, kill switch, the event
body fenced as outside data). Design note: `docs/superpowers/specs/2026-11-21-instincts-and-event-triggers-design.md`.
Operator steps: `docs/OPERATIONS.md`, "Event triggers and memory switches".

Already present, so not rebuilt: rule extraction from "always / never / from now on" (`shared/memory.js`),
the editable rulebook, push tags per message (a grouping change would reverse a deliberate fix),
quiet hours, approval cards.

Not built, with the reason:
- **Universal capture (share sheet, clipboard, voice).** Needs a PWA share target and a UI that is not
  checked in a browser yet. Worth doing next; importing must stay separate from acting.
- **Intelligent interruptions beyond quiet hours.** Needs a decision inbox screen first.
- **Failure-to-improvement.** The rule endpoint is the mechanism; the "Fix this behaviour" button is UI.
- **Natural-language event conditions.** Replaced by a structured condition: testable, and it cannot be
  talked around by the sender.
- **Shadow mode, hybrid deterministic engine, budget autopilot, project rooms, live presence,
  walkie-talkie, skill packs, task-first onboarding, workspace pulse.** Each is a product or UI project;
  none has a design yet. Shadow mode also needs an opt-in data policy before any code.
- **Agent tournament.** Dropped, as agreed.

## Round 3 (2026-11-25): daily-use pack

Built, with tests:
- **Health alerts and session expiry** (Keep items 1 and 4): `src/health-watch.js`. A computer gone quiet while
  schedules wait, or background work running late, is one urgent phone notice and one "back" notice. A scheduled
  task that a site signed out tells the owner at once instead of leaving a card in a chat nobody opens.
  `tests/health-watch.test.js`.
- **Per-site daily limit** (Keep item 2): `perSite` in `shared/limits.js`, Settings → Limits "Pages a day on one
  site". Off by default. `tests/site-limit.test.js`.
