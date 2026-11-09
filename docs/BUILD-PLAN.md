# Build plan — complete except host/push verification (38/39)

All v0.2/v0.3 roadmap items that can ship in this repo are delivered. Every
phase ended green (`npm run check && npm test && npm run build:pages`). The
open item is hardware: push on a physical phone and Apple's push service, on
a host that stays on. The items below are the record of what shipped; new
work should be added as a fresh section.

## Phase A — transactional store
- [x] `node:sqlite` store behind the existing `read()`/`update()` interface (Node 22 re-exec guard)
- [x] Schema v1 + `schema_meta` migration ledger
- [x] Legacy `state.json` import on boot (mtime-guarded, supports operator JSON restore)
- [x] Atomic WAL transactions; `recoveredFrom` quarantine kept
- Also landed: completed the in-flight `.env` loader + provider-agnostic AI client

## Phase B — multi-user control plane
- [x] users, server-side sessions (revocable), password reset tokens
- [x] workspaces + membership roles (owner/admin/member/viewer)
- [x] First-run owner bootstrap from `DASHBOARD_PASSWORD`; `/api/login` unchanged
- [x] Authz matrix on every route; session list/revoke endpoints

## Phase C — structured tasks + durable queue
- [x] `shared/tasks.js` transition rules (pure, replaces reminder events)
- [x] `src/queue.js` worker: idempotency keys, leases, backoff, crash recovery
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
- [x] Preferences (in-app/webhook/email-relay) + dispatcher w/ retry

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

## Phase N — server structure and durable history
- [x] Route table with declared access per route (`src/router.js`, `src/routes-*.js`)
- [x] Lossless restarts: every workflow record keeps its whole document (schema v3)
- [x] Reminders survive a restart
- [x] Conversations stored with the workspace, with a one-time import from the browser
- [x] Sheets take focus as they open (fixes text landing in the wrong field)
- [x] Group runs report into their conversation from the server

## Phase O — adversarial security review
- [x] Owner-only backup and restore; restore validates roles, links and column names
- [x] Hashed session ids; one answer for unknown address and wrong password
- [x] Sign-in and forgot-password attempts counted before the body is read
- [x] Capture token withheld from viewers; request-made notification tasks refused
- [x] Local agent refuses private-network targets; model calls and posts are bounded
- [x] Only the server can mark a chat message as model output or name its sender
- [x] Webhooks refuse private-network targets unless allowed on purpose

## Phase P — workspaces, push, browser reader, deploy files
- [x] One database per workspace; sessions carry a workspace and can switch (schema v5)
- [x] Create, rename and delete workspaces; members invited per workspace
- [x] Web Push without a library: encryption, VAPID, queue delivery, service worker, manifest
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
