# Build plan — complete except host/push verification

All v0.2/v0.3 roadmap items that can ship in this repo are delivered. Every
phase ended green (`npm run check && npm test && npm run build:pages`). The
open item is hardware: push on a physical phone and Apple's push service, on
a host that stays on. The items below are the record of what shipped; new
work should be added as a fresh section.

## Phase A — transactional store
- [x] `node:sqlite` store behind the existing `read()`/`update()` interface (launched with the `--experimental-sqlite` flag the npm scripts and the Dockerfile pass)
- [x] Schema v1 + `schema_meta` migration ledger
- [x] Legacy `state.json` import on boot (mtime-guarded, supports operator JSON restore)
- [x] Atomic WAL transactions; `recoveredFrom` quarantine kept
- [x] Schema v9; a database written by a newer build is refused at boot with both versions in the message
- [x] The JSON store removed: `src/store.js` and `STORE_BACKEND` are gone and `src/server.js` opens SQLite directly
- Also landed: completed the in-flight `.env` loader + provider-agnostic AI client (now five wire protocols, provider presets, custom headers, Azure API version)

## Phase B — multi-user control plane
- [x] users, server-side sessions (revocable), password reset tokens
- [x] workspaces + membership roles (owner/admin/member/viewer)
- [x] First-run owner bootstrap from `DASHBOARD_PASSWORD`; `/api/login` unchanged
- [x] Authz matrix on every route; session list/revoke endpoints
- [x] Sign-in limited per client address (the rightmost `X-Forwarded-For` hop behind `TRUST_PROXY=1`) and per account

## Phase C — structured tasks + durable queue
- [x] `shared/tasks.js` transition rules (pure, replaces reminder events)
- [x] `src/queue.js` worker: idempotency keys, leases, backoff, crash recovery
- [x] One heartbeat renews every task in a claimed batch, so a slow handler cannot let a waiting task's lease expire and be executed twice
- [x] `schedules` → tasks migration; scheduler keeps draft release + task dispatch (the draft release and the reminder tasks were removed in Phase Z; task dispatch stays)

## Phase D — source evidence model (removed in Phase Z)
- [x] `shared/evidence.js`: link, claim, confidence, verification status, reuse
- [x] Evidence attached to drafts; Researcher describes supplied evidence (it does not emit evidence rows from model output)
- [x] UI: add/review evidence on draft cards

## Phase E — bot contracts + tool permissions
- [x] `shared/contracts.js`: versioned bot schema, declared I/O, action permissions
- [x] Coordination engine validates outputs; actions gated by permissions
- [x] UI: edit contract + permission toggles (publish always denied)

## Phase F — local agent
- [x] Pairing codes (hashed, short-lived) + HMAC-signed outbound protocol
- [x] `agent/agent.mjs` device process: heartbeat, poll, execute, report
- [x] Permission-scoped task kinds; browser adapter behind explicit opt-in
- [x] Disconnect/duplicate-delivery recovery tests

## Phase G — credentials, retention, deletion, backups
- [x] AES-256-GCM vault (`MASTER_KEY` / local dev keyfile)
- [x] Retention pruning, account deletion, checksum-protected JSON backup export/import

## Phase H — notifications
- [x] Preferences (in-app/webhook/email) + dispatcher w/ retry

## Phase I — deployment readiness
- [x] Optional TLS termination, HSTS, startup validation, `docs/DEPLOYMENT.md`

## Phase J — UI surfaces
- [x] Run timeline visualization + failure reporting
- [x] Human checkpoint gates between bot steps
- [x] Tasks, evidence, credentials, agents, notifications, users panels

## Phase K — tests
- [x] Disconnect, duplicate delivery, partial-execution recovery
- [x] Adversarial prompt-injection suite
- [x] Authorization matrix tests
- [x] Serialized store `update()`, scheduler ticks and boot-order retention, and lease recovery from a dead process
- [x] `npm run check` walks every source file under `src/`, `shared/`, `agent/`, `extension/` and `scripts/` (75 files) instead of a hand-kept list

## Phase L — docs
- [x] ROADMAP/README/COORDINATION updates, AGENT-PROTOCOL.md, SECURITY.md

## Phase M — chat-first redesign
- [x] Chat list, thread, and info panel shell; one pane at a time on phones
- [x] Drafts and posts as in-thread cards with in-place actions
- [x] Workspace tabs folded into the X-engage chat info panel
- [x] In-app sheets replace native confirm and prompt dialogs
- [x] UI split into `shared/ui-*.js` modules with a pure view-model layer
- [x] Single stylesheet (`shared/app.css`), system fonts, tightened CSP
- [x] Tests and Playwright smokes updated for the new UI
- [x] Command palette as a combobox with `aria-activedescendant`, error toasts announced assertively, `100dvh` panes with notch and home-indicator insets, 16px text fields, 44px touch targets

## Phase N — server structure and durable history
- [x] Route table with declared access per route (`src/router.js`, `src/routes-*.js`)
- [x] Lossless restarts: every workflow record keeps its whole document (schema v3)
- [x] Reminders survive a restart
- [x] Conversations stored with the workspace, with a one-time import from the browser
- [x] Sheets take focus as they open (fixes text landing in the wrong field)
- [x] Group runs report into their conversation from the server
- [x] `shared/assets.js` as the only list of served UI files, imported by both `scripts/build-pages.js` and `src/server.js`

## Phase O — adversarial security review
- [x] Owner-only backup and restore; restore validates roles, links and column names
- [x] A restore refuses a document whose memberships name no workspace, or that carries account rows with no accounts in the first workspace, and reports the workspaces it had to start empty
- [x] Hashed session ids; one answer for unknown address and wrong password
- [x] Sign-in and forgot-password attempts counted before the body is read
- [x] Capture token withheld from viewers; request-made notification tasks refused
- [x] Local agent refuses private-network targets; model calls and posts are bounded
- [x] Only the server can mark a chat message as model output or name its sender
- [x] A stored message id cannot be reused by a client to replace the bot's reply
- [x] Webhooks refuse private-network targets unless allowed on purpose

## Phase P — workspaces, push, browser reader, deploy files
- [x] One database per workspace; sessions carry a workspace and can switch (schema v5)
- [x] Create, rename and delete workspaces; members invited per workspace
- [x] Web Push without a library: encryption, VAPID, queue delivery, service worker, manifest
- [x] Service worker caches the app shell so it opens offline, and a notification tap opens the screen it is about
- [x] Local agent reads allowlisted pages with the installed browser over DevTools
- [x] Dockerfile, Compose with Caddy, and a systemd unit
- [x] Push delivered end to end through Google's push service to desktop Chrome
- [ ] Push verified on a physical phone and through Apple's push service; server running on an always-on host

## Phase Q — bots that work together, settings you control
- [x] Bot settings: on/off, reply length, temperature, tone, chat memory, summonable, hand-off, colour (`shared/bot-settings.js`)
- [x] Group settings: routing mode (pipeline, lead only, everyone), pipeline order, step limit up to 12, approve between steps, bot handoffs
- [x] Edit, remove and switch off bots; edit and delete groups
- [x] @mention any bot in any chat, including summonable bots from other groups, with the chat's recent messages as context
- [x] Bot-to-bot handoff: a reply that @mentions a teammate extends the run, within the step limit
- [x] Scheduled bot tasks that post their results into the chat, on the server and in the Pages demo
- [x] Composer @mention suggestions
- [x] Tests for every item above; check, test and build:pages green

## Phase R — local browser control for bots
- [x] `browser.use` permission on any bot; envelope and system prompt describe the browser block only to bots holding it
- [x] Fenced `browser` blocks validated (`shared/bot-browser.js`): public http(s) only, 25 steps, 2 per reply, 3 round trips per turn (click/type on X allowed since 2026-11-12; a Post asks)
- [x] Approve/Decline card in the chat; per-bot "Browser requests" setting (ask, or run without asking)
- [x] Dispatch to a paired local agent with the needed permission; result posted in the chat and the bot continues (`src/bot-browser.js`)
- [x] Steps may name a control by the index in the last result, so a bot can act on a page it has only read once (`agent/browser.mjs`)
- [x] `BROWSER_RUNTIME`: the server runs a browser of its own (one child process, serial, closed when idle) when it has an allowlist and a browser, else a paired agent (`src/browser-runtime.js`)
- [x] Requests persisted in SQLite; Pages demo explains it needs the Node build
- [x] **Take over the page to sign in:** a kept browser context a person drives by screenshot (`POST /api/browser-sessions`, click/type/navigate), handed back so the bot continues from the page they reached (`shared/ui-takeover.js`, `agent/browser.mjs` `open`, `src/browser-runtime.js` live registry)
- [x] Tests (`tests/bot-browser.test.js`, `tests/browser-runtime.test.js`, `tests/agent-browser.test.js`); check, test and build:pages green

## Phase S — sub-agents a bot can spawn
- [x] `subagent.spawn` permission on any bot; envelope and system prompt describe the spawn block only to bots holding it
- [x] Fenced `spawn` blocks validated (`shared/subagents.js`): one per reply, task capped at 2000 characters, JSON only
- [x] The helper runs as a separate model call with no permissions, no tools, no web access and no conversation memory; its reply is never parsed for a block, so the tree is one level deep
- [x] The bot that asked gets one more turn carrying the answer, marked as untrusted data, and writes the real reply; a failed helper never loses that reply
- [x] Started/answered/refused lines in the chat, and the helpers each run spawned kept on the run record
- [x] Tests (`tests/subagents.test.js`); check, test and build:pages green

## Phase T — durable memory
- [x] `shared/memory.js`: per-model rulebook and per-chat recap, bounded (50 rules, 40 books, 120 chats) and pure
- [x] Durable user sentences captured deterministically; one model consolidation pass on a cadence, with a cooldown and an injectable executor (`src/memory.js`)
- [x] Memory block in every bot envelope and system prompt; per-bot `memory` setting can leave a bot out
- [x] Memory persisted with the workspace (schema v9 `memory` table) and carried by backups
- [x] A model-written recap is not thrown away by the next deterministic digest (it lasts `CONSOLIDATE_AFTER` turns); a forgotten chat stays forgotten until a message written after the forget arrives
- [x] An unreadable consolidation reply still spends the cooldown, so one bad answer cannot buy a paid call every step
- [x] A durable sentence must address the bot, not merely contain a modal, so "we must ship today" is not kept as a rule
- [x] UI: bot profile memory section with rule add/delete, chat forget, and an explicit "update rulebook" action (`/api/memory`)
- [x] Tests (`tests/memory.test.js`, `tests/memory-routes.test.js`); check, test and build:pages green
- [x] (Phase 2) Memory is per bot: each bot keeps its own rulebook (`bot:<id>`) and every bot reads one company notebook it cannot write (`company`); the owner adds, edits (`PATCH /api/memory/rules/:id`) and deletes lines from a bot's profile (`GET /api/memory?bot=<id>`); a model's old book is copied into each bot that used it, once (`migrateModelBooks`); context needs no setting (the newest lines that fit, the recap for the rest) and `contextMessages` is gone

## Phase U — bots that ask each other
- [x] `bot.ask` permission on any bot; envelope and system prompt describe the block only to bots holding it
- [x] Fenced `ask` blocks validated (`shared/bot-link.js`): one per reply, JSON only, capped question length
- [x] The teammate answers as itself on its own model and rulebook, with no tools; the asker gets one more turn with the answer marked as untrusted text
- [x] Refused, missing or failed asks never lose the asker's reply
- [x] (Phase 2) Any bot asks any bot, no grant needed (`bot.ask` is basic kit); the asked bot may ask on. Checkpoints, not walls: 6 bots deep, 12 messages per pair, 60 per task, or one question three times with no new answer pauses the run (`awaiting_limit`) with Keep going / Keep going, don't ask again / Stop (`shared/ask-limits.js`)
- [x] Started/answered/refused lines in the chat, and asks kept on the run record
- [x] A control block in a teammate's answer is stripped before the asker sees it; hand-offs switched off for the group refuse the ask without costing the reply
- [x] Tests (`tests/bot-link.test.js`); check, test and build:pages green

## Phase V — bots that create bots
- [x] `bot.create` permission on any bot; envelope and system prompt describe the block only to bots holding it
- [x] Fenced `create-bot` blocks validated (`shared/bot-create.js`): one per reply, bounded name and job, JSON only
- [x] The new bot is a lasting roster record: always `custom`, no permissions, no model/contract escalation, capped by the group's bot limit
- [x] A group with an explicit pipeline adds the new bot at the end; created bots are reviewed and editable like any other
- [x] Refused, duplicate and over-limit requests say why in the chat and write nothing
- [x] `bot.create` is re-checked against the roster inside the write, so a permission revoked while the reply was written still refuses; schema v10 keeps `origin` and `created_by` across a restart
- [x] Tests (`tests/bot-create.test.js`); check, test and build:pages green
- [x] (Phase 2) Any bot may make a bot with no grant (`bot.create` is basic kit): one sentence is the job and the name is optional; it reports to its creator (a lead) or the creator's manager; no 40-bot cap (500 safety cap); more than about 50 creations or 300 bot-started runs in five minutes pauses everything bots start, and the owner chooses Keep going or Stop (`shared/runaway.js`, `POST /api/guard`)

## Phase W — a provider client that survives real gateways
- [x] A gateway that answers `text/event-stream` without being asked is folded back into a reply for every protocol, and an error delivered as a stream keeps the provider's own words
- [x] A `400` that asks for `max_completion_tokens`, or refuses a custom temperature, is retried once with that fix; any other `400` is reported as-is
- [x] Azure's newer `/openai/v1` base uses `/chat/completions` with the model in the body and reads its catalogue from `/models`, while the classic `/openai/deployments/{name}` base still works
- [x] The catalogue parser reads rows from `data`, `models`, `value`, `result`, a nested `data.models` or a bare array; Gemini rows are kept whole so the chat filter, not the parser, decides
- [x] A base URL keeps a real `/openai` segment on every protocol but Azure, where the bare segment is the resource path and is stripped
- [x] The Responses API's convenience `output_text` is read when `output` is absent
- [x] **Test** names the first model the key lists instead of reporting "Connected · auto", and a viewer's provider row carries the chat ids so the per-bot picker is not empty
- [x] Tests (`tests/ai-protocols.test.js`, `tests/ai-providers.test.js`, `tests/ai-presets.test.js`); check, test and build:pages green

## Phase X — an email channel that needs no relay
- [x] SMTP client on `node:net`/`node:tls` (`src/mail.js`): greeting, `EHLO`, `STARTTLS`, `AUTH PLAIN`/`LOGIN`, `MAIL FROM`/`RCPT TO`/`DATA`/`QUIT`, idle timeout
- [x] `STARTTLS` is required by default: a server that does not offer it fails the send before `AUTH`, so no password goes out in cleartext. `SMTP_REQUIRE_TLS=0` is the explicit opt-out for a relay on your own network
- [x] Implicit TLS on submission port 465 (`SMTP_SECURE=1`); certificates are always verified, with no knob to turn that off
- [x] One recipient per message, a header value can never contain a line break, non-ASCII text becomes folded RFC 2047 words, and the base64 body keeps CRLF endings
- [x] `SMTP_HOST` wins when both it and `EMAIL_RELAY_URL` are set; with neither, delivery still throws so the queue retries instead of claiming the mail left
- [x] A failure carries the server's own reply code, and redacts the password, the user and the recipient from the message that reaches the notification feed
- [x] Docs: `.env.example`, `docs/DEPLOYMENT.md`, `docs/ROADMAP.md`, `SECURITY.md`
- [x] Tests (`tests/smtp.test.js` against a scripted loopback server, plus the relay/SMTP precedence case in `tests/notifications.test.js`); check and test green

## Phase Y — the moves an approval queue was missing (removed in Phase Z)
- [x] **Approve at a time you pick**: `PATCH/POST /api/drafts/:id/approve {dueAt}` pins the exact instant (a minute to 7 days out, refused otherwise and the draft stays pending), through the same `scheduleApprovalAt` the delay window now uses, so the frozen text and revision are identical either way
- [x] `Schedule…` on a pending draft card opens the one field that matters, in local time; the server only ever sees an ISO instant
- [x] **Restore a skipped draft** (`POST /api/drafts/:id/restore`, `restore-draft`): a confirmed skip is reversible, because the captured post and its evidence were never touched
- [x] **Say where a post went** when marking a draft posted: the link is optional, validated as a web address, and rendered as one on the posted row
- [x] **Copy as thread**: a draft over X's 280 is cut on word boundaries by `threadParts` (`shared/ui-model.js`), nothing dropped, and the card says how many posts it needs
- [x] **The palette searches text**, not only names: drafts and captured posts match by their words and open the section they live in
- [x] Tests: `tests/workflow.test.js` (pinned approval, its three refusals, restore, posted link), `tests/ui-model.test.js` (`threadParts`, threaded length line), `tests/usability.test.js` (the posted question records a link); check and test green

## Phase Z — primary bot platform (design: `docs/superpowers/specs/2026-11-11-primary-bot-platform-design.md`)
- [x] Remove X-engage and its example bots
  - [x] Capture extension and capture token removed
  - [x] Draft, post, evidence, reminder and voice UI removed
  - [x] X home-feed reading removed
  - [x] Pages engine without X routes
  - [x] Server X routes, the draft tick and `makeDraft` removed
  - [x] X domain code removed; a new Atlas seed replaces the example bots
  - [x] X database tables dropped in schema v11; old backups still restore
- [x] One primary bot at first sign-in; bots can exist without a group; any bot creates bots
- [x] (Phase 2, backend) Company model, threads run by Atlas, leads route to their team, out-of-job replies, any bot asks any bot behind checkpoints, any bot makes a bot behind the runaway guard, per-bot memory with a company notebook; the Pages demo runs the same company offline with canned replies (`shared/offline-bots.js`) through the same shared rules
- [x] (Phase 2, UI) The chats shell: a desktop sidebar and a phone home with Bots and Threads sections, bot chats and Atlas-owned threads with one live progress pill and handoff cards, the waiting face above a card, the bot profile, Edit, New bot, Settings (one page, seven sections), Company and Activity, pin and reorder by drag, long press, right-click and Alt+arrows (`shared/ui-gestures.js`, `shared/ui-reorder.js`), all from one per-person `localStorage` (pins, order, hidden, muted). The old chat list, info panel and You pages are gone. Changing a bot's job by telling it in chat later is not wired (the first message in a new bot's chat is its job).
- [x] (Phase 3, backend) The ask mechanism: ask records and per-bot grants (`shared/asks.js`, schema v12, backups), runs park as `awaiting_ask` and go on at the owner's answer (`POST /api/asks/:id`, `POST /api/grants`, Pages twins; the old browser approve/deny are aliases), sends, posts, deletes and payments classified from the click, and an append-only activity log (`shared/activity-log.js`, `GET /api/activity`)
- [x] One Ask card (Decline / Allow / Always allow for this bot) replaces per-bot permission toggles (Phase 3, UI): the card in the bot's chat and Atlas's "Needs you" copy with the asking bot's waiting face, an answered card collapsing to one line, per-bot rules editable on the profile and in Settings → Permissions (spend never offers Always allow), the four Activity chips, and the pause banner with Resume (`shared/ui-asks.js`)
- [x] (Phase 4) Bots on the owner's Claude and ChatGPT subscriptions through the local agent: a `local-cli` provider kind (engines `claude` and `codex`, no key), the `model.run` agent task (`agent/cli-model.mjs`; prompt on stdin, the CLI's own tools off, timeout and output cap), the server side of a turn (`src/cli-model.js`, a `model-limit` chat line with a switch offer), and sign-in status in the heartbeat (`GET /api/agents` → `cli`). Settings → Models and keys adds a subscription (a name, an engine and an optional model, no key field), shows each paired agent's `claude` and `codex` sign-in with the hint, and a `model-limit` chat line offers Switch to the provider the server named (`shared/ui-connect-model.js`, `shared/ui-admin.js`).
- [x] (Phase 5, backend) One shared browser for all bots, with takeover from the app: the local agent keeps one persistent profile (`browser-profile/`, mode 0700) and one Chrome, a tab per bot and one bot driving at a time (`agent/shared-browser.mjs`); the owner watches a bot's tab live and drives it (`agent/live-channel.mjs`, `src/browser-live.js`, `GET /api/browser-live`, `…/:botId`, `…/input`), takes over and hands back (`POST …/takeover`, `…/handback`) with the bot's run parked meanwhile. The Computer view (profile row Idle / Browsing / You are driving, the live picture with address bar, Take over and Hand back, the pages of the run), the site chip on the progress pill and the "You are driving" line are Phase 5 UI (`shared/ui-computer.js`, `shared/ui-computer-view.js`); the Pages demo says it has no browser.
- [x] (Phase 6) Connectors: a hand-written MCP client over streamable HTTP and, through the paired agent, stdio (`mcp.call`; the command lives in the agent config only); Google sign-in with PKCE on the owner's own Cloud client (`src/google.js`, secrets only in the vault, `reconnect` when Google revokes the refresh token) with Gmail and Drive actions; a `connector` fence that goes through `verdict()` and the ask card (a tool with no annotations is a write); an email send held 30 seconds with an Undo and every write logged as left the app. Settings → Connectors lists, adds (an address with optional headers, or the name of a server on the agent), refreshes and deletes MCP servers, runs the Google setup form with its steps, redirect address and Testing note, and shows the connected account or Reconnect; a connector line in a chat names the account and a held send carries an Undo button (`shared/ui-connect.js`, `shared/ui-connect-model.js`). The Pages demo says these need the server.
- [x] (Phase 7) The app runs itself: a server on this computer pairs and runs its own local agent (`src/local-agent.js`, `LOCAL_AGENT`), Atlas is told the workspace (models, each bot's model, this computer, connectors; never a key) and proposes changes as `setup` cards the owner applies with one tap (`shared/setup.js`, `src/setup-cards.js`), a missing model is a card that opens Models and keys, a page a bot read folds into one line, and an ask card reads under the reply that asked.
- [x] (Phase 7) Any bot sets the app up from chat: rename, reply length and style, memory, on or off, manager, Always allow / Deny rules, a team's "Approve between steps" and step limit (`team` cards), and Switch on a model-limit card asks the failed message again on the new model. The brief tells each bot how every bot is set and how each team runs. The Pages demo reads the same plain requests without a model and shows the same cards. With no model yet, one tap on the first-message card uses this computer's Claude or ChatGPT sign-in and asks the message again.
- [x] (Phase 7) One model picker and an effort level: a bot's Model page is one list of every connected provider's models (the workspace default first, "Another … model…" to type any id) and four Effort pills (Default, Low, Medium, High); the workspace default has the same pills; a chip in a bot chat's header names its model and opens that page. Effort travels as each wire spells it (`reasoning_effort`, `reasoning.effort`, `output_config.effort`, Gemini `thinkingLevel`, `claude --effort`, codex `model_reasoning_effort`), and a provider or CLI that rejects it is asked once more without it. Bots set effort from chat with the model card. A bot pinned to another provider no longer inherits the default provider's model id.
- [x] (Phase 8) Calm runs that finish the job, from a 42-case sweep on a real model: a message sent while a bot is busy waits its turn (`src/follow-ups.js`, up to 5) instead of a 409; answers lead with the outcome; one live line with a rotating phrase ("Doing some reading", "Clicking through pages", "Checking with {name}", "Needs your input") replaces tool chatter; a reply that only went to fetch pages is a working step (`step` on the message) kept out of the chat, row previews and the memory recap; a page a bot already read is handed back with a note to open something else or answer; and the model input keeps the whole page (`boundBotInput`, 64k), so a bot no longer re-asks a page it was handed cut to a sliver.
- [x] (Phase 9) Find, brief and start faster: search reads what was said in every bot chat and thread (every word, any case or accent; `shared/message-search.js`) and a hit opens the chat at that line, lit once; a one-tap **Daily briefing** puts a schedule on the primary bot whose run is handed the workspace's facts of that morning (done in the last day, failed, waiting on the owner, coming up; `shared/briefing.js`, both engines' `runBotTask`); **task templates** as chips under an empty chat and the new thread box, plus a Templates button in the composer to save what you typed or delete a saved one (`shared/templates.js`, `shared/ui-templates.js`, `POST/DELETE /api/templates`, member). Saved templates live in the workspace's kv and, like limits, are not in a backup.
- [ ] **Move the server from the laptop to the Oracle VM** (it runs on the laptop first)
