# Watch and tell

Written 2026-11-25. Keep item 5 in `docs/FEATURE-RESEARCH.md`: "a scheduled page read that notifies only when it changes".

## What the owner gets

On a bot's profile, **Watch a page**: an address, how often (every hour, every 6 hours, every day), and optionally
"only tell me when these words appear" (for "in stock", "tickets available", a name). The owner's phone gets one
notice when the page changes (or the words appear), with the first new line, and the bot's chat gets one line. Nothing
is said while the page stays the same. The list shows each watch's last check, last change and any problem, with
Check now, Pause and Remove.

## Why it is not a bot task

A scheduled message ("check this page and tell me if it changed") would run the model every time, cost tokens, and
let model text decide what "changed" means. A watch never runs the model: the page text is compared by code. So it
reads nothing into a model turn, and the outside-read rules (`tainted`, `outsideRead`) have nothing to guard. A watch
only ever notifies the owner; it never sends, posts or clicks.

## Rules it keeps

- **A watch belongs to a bot**, and opens its page as that bot would: the bot's per-site rules decide (`decide` in
  `shared/asks.js` over `browserNeeds`). A plain read is basic access, so it goes through unless the owner set that
  site to Ask each time or Deny, or switched Browse and read without asking off. A watch never asks: there is nobody to
  answer at 3 a.m. It stops and tells the owner how to let it through.
- The per-site daily limit (`perSite`) counts each check.
- The kill switch (`schedulesPaused`) holds watches like schedules.
- It goes through `dispatchBrowserRequest`: the server's browser or a paired computer, the activity log line, and the
  10-minute wait (`expireBrowserTasks`) are the same as a bot's page.

## Shape

- `shared/watches.js` (pure, browser-safe): `state.watches` (at most 20), `addWatch`, `setWatchOn`, `removeWatch`,
  `dueWatches`, `pageFingerprint` (whitespace-normalised text hashed with FNV-1a), `watchChange` (first check is a
  baseline and says nothing; then changed or not, and the added lines), `watchNotice`.
- `src/watches.js`: `startWatches(ws, {notify})` on `startSweep` every minute. Each pass first reads finished watch
  requests (`browserRequests` with `watchId`, not yet `watchSeen`) and compares, then starts the due checks. Reading
  results on the next pass keeps `finishBrowserRequest` free of a new hook: it only learns to say nothing in the chat
  and hand nothing to a bot when a request has a `watchId`.
- Three failed checks in a row are one notice, and a plain notice when it works again.
- Routes: `GET/POST /api/watches`, `PATCH/DELETE /api/watches/:id`, `POST /api/watches/:id/check` (member). The Pages
  demo keeps watches but has no browser, so it says checks need the full app.

## Not in this version

Steps before reading (sign in, click a tab), a diff view, and asking a bot to summarise a change. Each would put the
page back into a model turn and needs the outside-read rules thought through.
