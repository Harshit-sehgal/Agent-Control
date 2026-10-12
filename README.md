# Agent Control — working prototype v0.6

A local-first dashboard for creating bot groups, reviewing AI-assisted drafts, and coordinating human-approved workflows. **X-engage is the first demo group.** It does not use an X developer API key, automatically crawl X, or automatically publish to X.

## Interface: a chat-first, messenger-style workspace

The interface is organized like a messenger. The Node server and the GitHub Pages demo render the exact same UI from `shared/`, styled by one stylesheet (`shared/app.css`) that uses system fonts only.

- **Three panes.** A chat list, the open thread, and an info panel. On phones one pane shows at a time.
- **Chat list.** Every group chat and every bot. The search box filters chats. The filters are All, Needs you, Groups, and Bots. The **+** button opens **New chat** (a new bot or a new group). The **…** button opens **You**: notifications, admin pages, about, and sign out.
- **X-engage workspace in the chat.** The old workspace tabs now sit in the X-engage chat's info panel (tap the chat header): Drafts (Waiting on you), Posts found, Reminders, Runs, and Voice and timing. There is no Overview tab.
- **Drafts in the thread.** Posts and drafts appear as messages in the X-engage thread. A draft is a card you answer in place: **Approve**, **Edit**, **Skip**, or **Rewrite**. After approval the card offers **Ready now**, **Copy text**, **Open post**, and **I posted it**. An amber "N need(s) you" pill in the chat header opens the drafts waiting on you.
- **Composer + sheet.** The **+** button in the composer opens **Share a post**, **Set a reminder**, **Load sample posts**, and **Add a bot**.
- **In-app sheets.** Confirmations and prompts appear as sheets inside the app, not as native browser dialogs.
- **Colour themes:** a clean light theme and a soft warm-grey dark theme. The app follows your system setting; to pin one, open **You** and choose it under Colours. Each bot has its own face and pastel colour, used for its bubbles too. The choice is saved in this browser.
- **Quick navigation:** press **Ctrl+K** (Windows/Linux) or **⌘K** (macOS), or choose **You → Jump to anything**. Search chats and pages, use arrow keys and Enter to navigate, and Escape to close.
- **Accessibility.** Visible `:focus-visible` rings on every control, focus returned to the trigger when a sheet closes, a focus trap inside sheets and quick navigation, `role="log"` live regions for conversations, and a `prefers-reduced-motion` path that removes every transition.
- Small-screen layout and reduced-motion preferences are validated in a headless browser.
- Tests: `tests/ui-model.test.js` and `tests/ui-polish.test.js` (Node), `tests/polish_smoke.py` and `tests/usability_smoke.py` (optional Playwright browser validation).

The Pages version remains **a browser-local, non-AI simulation**: its data and conversations stay in that one browser. On the Node server, conversations are stored with the workspace, so they follow your account to every device you sign in on. Do not enter secrets into the public Pages demo.

## Bot coordination: group chat and handoffs

**Group chats now route tasks between specialist bots.** You can mention `@Writer`, `@Reviewer`, or `@everyone` to select recipients. Without an explicit mention, X-engage uses Scout → Ranker → Researcher → Writer → Reviewer. Every result is attached to the bot identity, handed to the next bot, and shown in the shared conversation. Human review is required before any external action.

- **GitHub Pages:** Deterministic, browser-local coordination demonstration. Handoffs produce distinct message records, pass task context, and can create an **unapproved template draft**. No real AI is run on Pages.
- **Node API:** Real, *text-only* multi-bot execution. Messages you send in a group chat run on the server orchestrator: each specialist is called with the accumulated context and hands off to the next, and every step is recorded as a run with a full trace. Enable **"Approve between steps"** to gate each handoff behind your approval. Configure a **server-side** AI provider (`AI_API_KEY` + `AI_BASE_URL`; any OpenAI-compatible endpoint, including FreeLLMAPI, OpenRouter, Groq, a local Ollama/vLLM, or OpenAI itself). Each run is limited to six steps, with bounded context and group isolation. Model outputs never receive browser or publication tools.
- **Run timeline & admin.** The **Runs** section of a group's info panel (tap the chat header) shows every run with per-step traces, failures and a Retry action. Admins reach **Team & access** (users/roles/sessions), **Local agents** (pairing/permissions), and **Data & security** (credential vault, retention, encrypted backups) from **You**, where notifications are also listed.
- The platform is **not** a cloud-hosted autonomous agent swarm; it runs where you run it and stops for human approval. See [`docs/COORDINATION.md`](docs/COORDINATION.md) for the exact behavior, security boundaries, and API contract.

## GitHub Pages: chat-first UI

Visit **https://harshit-sehgal.github.io/Agent-Control/** after the Pages workflow completes. The browser-only UI now includes:

- A chat list of named bots and groups, each with its own saved conversation. The Node server stores conversations with the workspace; the Pages demo keeps them in the browser.
- Create bot, create group, and edit lasting bot instructions in the interface.
- X-engage group chat, with drafts and posts shown in the thread and its workspace sections (Drafts, Posts found, Reminders, Runs, Voice and timing) in the chat info panel.
- Share post candidates, create template drafts, edit and approve revisions, and prepare manual X posting handoffs.
- A phone layout that shows one pane at a time.

**Demo limitations:** Chat replies are deterministic local commands, not generated by an AI model. GitHub Pages has no server-side worker, live X integrations, secure key storage, push notifications, or cross-device sync. Never paste private account credentials or API keys into this public demo. The separate Node application still supports optional real AI drafting when deployed locally with a server-side provider key.


## GitHub Pages UI: usability controls

The static Pages dashboard includes functional navigation controls (not real AI execution):

- **Bot profile actions** in the bot's info panel: edit profile, pin to top or unpin, and duplicate. Duplication creates a new profile with its own empty conversation.
- **Group info actions**: add a bot, copy the conversation, or clear the conversation. The group info panel also holds the "Approve between steps" toggle.
- **Create Bot templates** for Scout, Researcher, Writer, Reviewer, and Coordinator. Templates fill **editable instructions**; they do not connect to an AI provider.
- **Posts found search, status filter, and sorting** (newest, oldest, best/worst score), in the X-engage chat info panel. Search matches author, topic, post text, or the source URL, so pasting a captured post link finds it. Filtering does not modify stored candidate records.
- **Drafts status and sort controls** in the X-engage chat info panel, for To decide, Scheduled, Ready to post, Posted, Skipped, and Everything drafts.
- **Clear chat** from group info. Clearing a conversation asks for confirmation in a sheet. On the Node server it clears the conversation for everyone in the workspace.
- **Conditional reminder fields** in the New reminder sheet: exact-time reminders require a timestamp; interval reminders require an interval.
- **Persisted UI preferences:** sort and filter options remain in browser local storage across reloads.
- **Confirmation sheets** before marking a draft as posted, removing a reminder, or clearing a conversation.

Use `npm test` for Node unit tests. For a local Chromium UI smoke test, install Python Playwright and Chromium, then run `python tests/usability_smoke.py`. The Pages edition remains a browser-local simulation without authenticated cloud agents, X browsing, or automatic posting.

## What works now

- Responsive web dashboard with password login (desktop/mobile browser).
- Persistent candidate inbox; add URLs/text directly or capture one visible post from a Chrome extension.
- Built-in X-engage bots: Scout, Ranker, Researcher, Writer, Reviewer, Manual Handoff.
- Deterministic topic-based relevance ranking. This is a heuristic, not a learned engagement predictor.
- Real AI drafting through any OpenAI-compatible provider (chat-completions or OpenAI Responses), with template-only fallback when no provider is configured.
- Editable drafts; revisions invalidate earlier approvals and scheduled publication handoffs.
- Random delay after approval, configurable from 0 to 1440 minutes. When due, the draft becomes **ready for manual posting**; no automatic posting occurs.
- Copy approved text, open source URL, and manually confirm publication.
- Create custom bot groups and custom text bots; run custom bots when an AI key is configured.
- Persistent once-only and recurring reminder events, stored with task history.
- Event/activity log, strict capture token, local file persistence, HTTP-only session cookie, basic login rate limiting.
- Zero npm runtime dependencies. Requires Node.js 22+.

### Important boundaries

- The Scout **does not automatically scroll, scrape, or search your X feed**. The Chrome extension captures one post after you deliberately invoke it. X restricts non-API scripting; a test account does not negate that restriction.
- The Researcher role **does not independently fact-check web claims** yet. Drafts carry a source and a warning to verify claims. Do not treat any generated text as verified reporting.
- The scheduler runs on the host computer. For 24/7 service, run the container or the systemd unit in `deploy/` on a machine that stays on (see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)).
- An installation can hold several workspaces, each with its own data and members, but it is self-hosted software for people you trust, not a hardened multi-tenant SaaS.
- Custom bots run text-only prompts; they do not have browser or file-system tool access yet.
- Push notifications reach a phone or desktop only after you turn them on for that device under **You → Notifications**, and only when the server is served over HTTPS (or on `localhost`). On an iPhone or iPad the app must first be added to the Home Screen.
- No external accounts, secrets, or private files are transmitted unless you explicitly configure a paid AI provider for text drafting.

## Quick start (Linux/macOS/Windows with Node 22+)

```bash
# Unzip the download, then open its project folder.
cd agent-control-prototype
npm test
npm start
```

Open **http://127.0.0.1:4173**. On first startup without environment variables, the terminal prints a randomly generated dashboard password. This password changes after a restart. For a stable password:

```bash
# Linux/macOS
DASHBOARD_PASSWORD='use-a-long-random-password' npm start
```

Windows PowerShell:

```powershell
$env:DASHBOARD_PASSWORD = 'use-a-long-random-password'
npm start
```

Optional real AI drafting through any OpenAI-compatible provider:

```bash
# Option A — a `.env` file next to package.json (git-ignored, loaded at startup):
#   AI_BASE_URL=http://127.0.0.1:3001/v1   # FreeLLMAPI router, or any compatible endpoint
#   AI_API_KEY=freellmapi-...              # your provider key
#   AI_MODEL=auto                          # "auto" lets a router choose, or a concrete model id
DASHBOARD_PASSWORD='use-a-long-random-password' npm start

# Option B — inline environment variables (override .env):
AI_BASE_URL='https://api.openai.com/v1' AI_API_KEY='YOUR_OWN_KEY' AI_MODEL='gpt-4.1-mini' DASHBOARD_PASSWORD='use-a-long-random-password' npm start
```

`AI_API_STYLE` picks the wire format (`chat` for `/v1/chat/completions`, `responses` for OpenAI's `/v1/responses`); it is inferred from `AI_BASE_URL` when unset. `AI_TIMEOUT_MS` (default 90000) budgets slow free-tier routing. The startup banner prints the active model and endpoint.

Secrets are read **only on the server**. Never place an AI provider key in the browser extension or Git repository. When a key is configured, draft creation may incur API charges. If the provider request fails, the backend reports an error; it does not pretend to have generated a successful AI answer.

### Try the full workflow

1. Log in to the dashboard. The chat list opens.
2. Open the **X-engage** chat. Tap **+** in the composer and select **Load sample posts**, or select **Share a post** to add your own.
3. Select **Draft reply** on a post, either in the thread or in **Posts found** in the chat info panel. A draft card appears in the thread.
4. Select the amber "N need(s) you" pill in the chat header to see drafts waiting on you. Select **Edit** on a draft, change the text, and save. This creates a new revision.
5. Select **Approve** on the draft card. The delay window is set in **Voice and timing** in the chat info panel. Default window: 2–10 minutes. To test instantly, set both values to 0 before approval.
6. Wait for the card to show **ready**, or select **Ready now** to accelerate an approved draft.
7. Select **Copy text**, select **Open post**, and **personally** click Post on X.
8. Select **I posted it** on the card to mark the task complete in the dashboard.

The exact revision displayed when you approve is locked. Editing after approval revokes that approval and removes its schedule.

## Chrome extension

1. Open `chrome://extensions/` in Chrome, Edge, or another compatible Chromium desktop browser.
2. Enable **Developer mode** and select **Load unpacked**.
3. Select the `extension/` folder.
4. In the dashboard open **You** (the ... button in the chat list) and choose **Copy capture token**.
5. Click the extension icon, enter `http://127.0.0.1:4173` and the token.
6. If the dashboard runs on a port other than `4173`, the extension asks Chrome for access to that origin on first capture. Approve the prompt; the bundled permission only covers the default port, so custom ports are granted per-origin rather than up front.
7. Open `http://127.0.0.1:4173/demo-feed.html` to test on a controlled page. Highlight text in one example post, then click **Capture selected post** in the extension.
8. Open the **X-engage** chat, open **Posts found** in the chat info panel, and draft the captured post.

On an X feed, explicitly select text in the post you are viewing before capturing. The extension does not scroll, click through, or read the entire feed. The dashboard also supports manual URL/text entry.

**Capture-token permissions:** The token only permits `POST /api/capture`. It does not permit draft approval, editing, or posting. If you expose the backend over the internet, protect it behind a private network / access gateway and use HTTPS.

## Remote access from your phone

### Fastest private setup: Tailscale

1. Install Tailscale on your laptop and phone, and sign in to the same tailnet.
2. Start the server listening on the Tailscale interface or a private-network interface:

```bash
# Use only while Tailscale/private firewall access is configured.
HOST=0.0.0.0 DASHBOARD_PASSWORD='use-a-long-random-password' npm start
```

3. On your phone, open `http://<your-laptop-tailscale-ip>:4173` over your private tailnet.
4. For production, use HTTPS and an access proxy; do not forward TCP port 4173 on your public router.

If the laptop sleeps or shuts down, the dashboard and scheduler stop. This prototype has **not** yet split the execution plane across cloud and local workers. The intended cloud/local design is documented in [`docs/ROADMAP.md`](docs/ROADMAP.md).

### Cloud deployment

`deploy/` holds what a host that stays on needs: a `Dockerfile` at the repository root, a Compose file that puts Caddy in front for HTTPS, and a systemd unit for hosts without Docker. [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) walks through each. **Do not expose the server without HTTPS and a long `DASHBOARD_PASSWORD`.** Nothing in this repository deploys it for you; choosing and paying for a host is yours.

## Tests

```bash
npm run check
npm test
npm run build:pages   # regenerate the static GitHub Pages bundle in docs/
```

The suite checks scoring, invalid URLs, scheduling boundaries, state persistence, recovery across reloads, and a live HTTP end-to-end lifecycle including auth, extension-token intake, editing, double-approval rejection, manual publishing confirmation, and cross-origin protection.

## Repository creation

To create a private repo after downloading/unzipping the project:

```bash
cd agent-control-prototype
git init -b main
git add .
git commit -m "feat: initial working agent dashboard and X-engage prototype"
gh auth login
gh repo create Harshit-sehgal/agent-control-prototype --private --source=. --remote=origin --push
```

`gh` is the official GitHub CLI (`https://cli.github.com/`). If already signed in, skip `gh auth login`. Confirm `data/` and `.env` are not tracked (`git status --short` should not list them). The repo must not already exist under that name.

## Architecture

```text
Browser (phone / desktop) ---- authenticated HTTP ----> Node dashboard/API
                                                     |
                                                     +-- SQLite store (local)
                                                     +-- scheduler
                                                     +-- topic ranker
                                                     +-- AI provider (optional)
Chrome extension ---- capture-only token ------------> /api/capture

Note: Browser actions that X does not authorize are not enabled.
```

### Key paths

- `src/server.js`: starts the services (store, auth, queue, scheduler), then dispatches each request through the route table.
- `src/router.js`: the route table. Every route is registered with the access it needs (`public`, `agent`, or a least role), so a permission cannot be forgotten.
- `src/routes-*.js`: the routes themselves, grouped by area: `public` (sign-in, capture, local-agent protocol), `workflow` (posts, drafts, evidence, tasks), `groups` (groups, bots, runs, conversations) and `account` (users, sessions, agents, vault, backups), `workspaces` and `push`.
- `src/workspaces.js`: one database file per workspace. A request works on its session's workspace and no other.
- `src/push.js`: Web Push (message encryption and VAPID signing) with `node:crypto`, no library.
- `agent/browser.mjs`: the local agent's real-browser reader, driving an installed Chrome over the DevTools protocol.
- `src/http.js`: JSON responses with the security headers, bounded body readers and the same-origin check.
- `src/sqlite-store.js`: the default store. Each record is kept whole next to its typed columns, so a restart reads back exactly what was written.
- `shared/chats.js`: conversation history rules, shared by the server and the browser-local transport.
- `shared/workflow.js`: the single source of workflow transitions (candidates, drafts, approval, schedules) plus the versioned schema migration.
- `shared/core.js`: validation, ranking, scheduling state transitions.
- `src/ai.js`: optional provider adapter and clearly labeled offline fallback.
- `src/store.js`: the older JSON store, kept behind `STORE_BACKEND=json` for tests.
- `src/scheduler.js`: due-task and reminder reconciliation.
- `shared/`: the dashboard UI, its browser-safe logic, and the local transport. The Node server serves this folder directly.
- `scripts/build-pages.js`: copies `shared/` into `docs/` for the static GitHub Pages build (`npm run build:pages`).
- `extension/`: Manifest V3 capture extension.
- `tests/`: unit tests, the HTTP integration test, and optional Playwright smoke tests.
- `docs/ROADMAP.md`: phased path to the production architecture.

### One UI, two transports

The dashboard in `shared/` is the only UI. At runtime `shared/transport.js` picks a backend:

- Under the Node server it calls same-origin `/api/*` and shows a password sign-in.
- On the static Pages build it calls the browser-local `localStorage` implementation in `shared/local-api.js`.

Both paths run the same `shared/workflow.js` rules, so the demo and the real dashboard cannot drift. Edit `shared/`, then run `npm run build:pages` to regenerate `docs/`.

## Security and operational notes

- Set a strong, stable `DASHBOARD_PASSWORD` before exposing the server beyond localhost.
- State lives in a transactional SQLite database (`DATA_FILE`); sessions are server-side and revocable, so a restart no longer signs users out.
- Secrets (paired-agent secrets, stored credentials) are AES-256-GCM encrypted; the master key is `MASTER_KEY` or a `0600` keyfile beside the database. **Back the key up with the data.**
- Roles are `viewer < member < admin < owner`; every route is registered with the least role it needs (`src/router.js`, `tests/authz-matrix.test.js`).
- Sign-in and password-reset requests are rate-limited per address, and the attempt is counted before the request is read. An unknown address and a wrong password get the same answer.
- The session cookie is `HttpOnly` + `SameSite=Strict`; the database holds only a hash of each session id. Cross-origin writes are rejected.
- **Backup and restore are for the owner only.** A backup carries every account's password hash, and a restore replaces accounts and roles. A restore rejects unknown roles and any link that is not http(s).
- The extension capture token is a write credential, so viewers do not receive it.
- The local agent refuses `http.check` targets on private or local networks and does not follow redirects. Set `AGENT_ALLOW_PRIVATE=1` on the device to allow private addresses on purpose.
- At most `AI_MAX_CONCURRENCY` model calls (default 4) run at once; a workspace holds at most 2000 collected posts.
- Model output in a chat carries an **AI** mark that only the server can set, on runs it executed itself. A browser can add built-in command replies to a conversation, but it cannot mark them as model output or give them a sender the conversation does not have.
- Each workspace keeps its data in its own database file (`state.ws-<id>.db` beside `state.db`). Accounts and memberships live in the first one. Only an owner of the first workspace can create workspaces; people are invited to one workspace at a time.
- Push subscriptions belong to the account that made them. The installation's push key pair is generated on first use and stored encrypted with the vault key. A push endpoint must be a public https address.
- Webhook notifications are not delivered to private or local addresses, and redirects are not followed. Set `WEBHOOK_ALLOW_PRIVATE=1` to allow a relay on your own network.
- Captured posts are **untrusted external content**; input is escaped and URL schemes validated. Model output never receives browser or publishing tools, and **the final Post click is always human**.
- Run behind an HTTPS reverse proxy; enable `HSTS=1` only after TLS works. See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).
- Full threat model: [`SECURITY.md`](SECURITY.md). Agent protocol: [`docs/AGENT-PROTOCOL.md`](docs/AGENT-PROTOCOL.md).

## License

No open-source license has been selected. The default is all rights reserved until the repository owner chooses a license.
