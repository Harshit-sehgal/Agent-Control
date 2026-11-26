# Automation, phone approvals and remote access — design

Status: approved in scope by the owner on 2026-11-20 ("implement all these things"). Choices marked **(my call)** were settled by the author and can be changed.

## Intent and why
The owner wants the agent to do recurring work on its own: read the owner's feeds, prepare drafts, run checks, and report back, with the owner approving anything that changes something outside the agent. The agent's own browser and computer (the server) must be reachable from the owner's phone and laptop without opening the server to the public internet, and without SSH.

## Goals
1. Schedule any task, not only bot messages: a bot message, a group run, an agent job, a notification, a browser read. One schedule model for all of them.
2. Recurrence rules a person can read: every day, weekdays, a named weekday, every N minutes, once at a date and time, plus a stop date and a maximum number of runs.
3. Pause, resume, edit and cancel a schedule from the web app and from the phone.
4. Approvals and notices reach the owner's phone, with approve and deny in one tap.
5. Remote access: a private tunnel (Cloudflare Tunnel) plus a Cloudflare Access policy that only lets the owner's email in.
6. Android app: a Trusted Web Activity around the installable web app.
7. Nightly encrypted backups of the server's data volume, with a tested restore.

## Non-goals
- Public sign-up or multiple owners.
- Solving captchas or bypassing bot checks. The owner solves them in the live view.
- Running the browser from the owner's home IP. Parked until the owner asks for it.
- Telegram. Dropped for now; the web app and the Android app cover notices.

## Anti-goals
- A schedule that runs a post, like, delete or payment without an approval step.
- Any secret written to the repo, a log, or a backup that is not encrypted.
- An exposed port on the server.

## Constraints
- Zero npm runtime dependencies (AGENTS.md). Node 22 and up.
- Shared code stays browser-safe. Tests run offline with `npm test`.
- The server runs in Docker from `deploy/compose.cloudflare.yaml`. No host changes to other services.

## Approaches

### Scheduling
- **A. Extend the existing task queue (chosen).** Add a schedule kind for each payload kind, and a recurrence rule on top of `enqueueTask`. Reuses the leases, retries and status the queue already has. Cost: moderate.
- **B. New scheduler service.** Clean, but a second queue beside the first. Rejected: AGENTS.md asks for extending existing helpers, not adding a parallel pattern.
- **C. OS cron on the host.** Simple, but schedules live outside the app, cannot be edited from the phone, and cannot respect approvals. Rejected.

### Phone approvals and notices
- **A. Web push through the existing VAPID keys (chosen).** The service worker already exists; push works on Android Chrome and as an installed app. **(my call)**
- **B. Email.** Slower and needs a sending domain. Rejected for now.

### Remote access
- **A. Named Cloudflare Tunnel plus Access on the owner's email (chosen).** Already designed in the repo; the owner's Cloudflare account holds the policy.
- **B. Tailscale.** Also private. Kept as the fallback if Access causes trouble on the phone.

### Android
- **A. Trusted Web Activity (chosen).** Smallest native shell; the web app is the product. Needs an `assetlinks.json` that Access does not block.
- **B. Capacitor or React Native.** More code to keep in step with the web app. Rejected for now.

## The design
- **Schedule record:** `{id, kind, payload, rule, stopAt, maxRuns, paused, runs, nextAt}`. `rule` is one of `every:<minutes>`, `daily:<HH:MM>`, `weekdays:<HH:MM>`, `weekly:<day>:<HH:MM>`, `once:<ISO>`. The existing `scheduleRows` and `whenWords` produce the words the owner reads.
- **Runner:** the existing worker claims due tasks. Each run is logged with its result. Two failures in a row pause the schedule and notify the owner.
- **Approvals:** a scheduled task that would act outside the agent creates the same approval card a live request does. The schedule waits; it does not act without a yes.
- **Notices:** a push when an approval is waiting, a schedule pauses, or a task fails.
- **Remote:** the tunnel's ingress is the app's loopback. The Access policy and the app's own password are two separate locks.
- **Backups:** nightly `tar` of the data volume, encrypted with a key held outside the server, copied off the server, with a restore test.

## What is left to the builder
- Exact UI layout for the schedule editor and the approval inbox.
- Which recurrence rules get tests first (start with every and daily, then the rest).
- How the Android shell is signed and where the APK is kept.

## Order of work
1. Tunnel and Access (blocked on the owner signing in to Cloudflare in the built-in browser).
2. Recurrence rules and the generic schedule record, test first.
3. Runner integration and failure pausing.
4. Approvals and push notices.
5. Schedule editor and approval inbox in the web app.
6. Backups and a tested restore.
7. Android Trusted Web Activity.
8. Documentation.
