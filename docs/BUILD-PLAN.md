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
- [x] `schedules` → tasks migration; scheduler keeps draft release + task dispatch

## Phase D — source evidence model
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
- [x] Fenced `browser` blocks validated (`shared/bot-browser.js`): public http(s) only, 25 steps, 2 per reply, 3 round trips per turn, no click/type on X
- [x] Approve/Decline card in the chat; per-bot "Browser requests" setting (ask, or run without asking)
- [x] Dispatch to a paired local agent with the needed permission; result posted in the chat and the bot continues (`src/bot-browser.js`)
- [x] Requests persisted in SQLite; Pages demo explains it needs the Node build
- [x] Tests (`tests/bot-browser.test.js`); check, test and build:pages green

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

## Phase U — bots that ask each other
- [x] `bot.ask` permission on any bot; envelope and system prompt describe the block only to bots holding it
- [x] Fenced `ask` blocks validated (`shared/bot-link.js`): one per reply, JSON only, capped question length
- [x] The teammate answers as itself on its own model and rulebook, with no tools; the asker gets one more turn with the answer marked as untrusted text
- [x] One round deep: the teammate's reply is never parsed for another ask; refused, missing or failed asks never lose the asker's reply
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
