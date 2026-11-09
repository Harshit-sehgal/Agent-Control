# AGENTS.md

Guidance for agents (and humans) changing this repo. Any `CLAUDE.md` still applies; this file is the project-level contract.

## What this is
Local-first, **zero-npm-runtime-dependency** multi-bot dashboard with human-approved X drafting. Node `>=22` (`.nvmrc`).

- `shared/` — code used by **both** the browser UI and the Node server. Must stay browser-safe (no Node builtins). The chat UI is split into `shared/ui-*.js`: `ui-kit.js` (string builders: icons, avatars, rows, time labels), `ui-model.js` (pure view models: chat list rows, thread timeline, needs-you count, routes), `ui-store.js` (single state object, API wrapper, navigation), `ui-chat.js` (what happens after send), `ui-views.js` (chat list and thread), `ui-panel.js` (chat info panel and You pages), `ui-sheets.js` (sheets, quick navigation, sign-in), `ui-admin.js` (admin pages), `ui-dialogs.js` (toast, sheet, confirm/ask), and `ui-actions.js` (action and form lookup tables). Conversation history rules live in `shared/chats.js` and bot/group settings rules in `shared/bot-settings.js`; both transports use them. Model text may only add run recipients through `handoffTargets` in `shared/coordination.js`. `ui-model.js` and `ui-kit.js` must stay pure (no DOM, no globals) because Node tests import them.
- `src/` — Node-only: server, stores, auth, queue, scheduler, AI client, local agent, vault. `server.js` only starts services and dispatches; API routes live in `src/routes-*.js` and are registered through `src/router.js` with the access each one needs (`public`, `agent`, or a least role). Add a route there, never as a branch in `server.js`. A route handler uses `c.store`, the store of the session's workspace (`src/workspaces.js` keeps one database per workspace); only accounts, sessions, memberships and push subscriptions live in the first workspace's store.
- `docs/` — the GitHub Pages bundle. JS/CSS/HTML copied from `shared/` are generated (`npm run build:pages`); hand-written markdown in this folder is edited in place.
- `extension/` — Chrome capture extension. `agent/` — the local device process.
- `tests/` — `node --test`. `docs/BUILD-PLAN.md` tracks the roadmap phases.

## Commands — every change must leave these green
- `npm run check` — syntax-check every source file (`node scripts/check.mjs` walks `src/`, `shared/`, `agent/`, `extension/`, `scripts/`).
- `npm test` — unit/integration tests.
- `npm run build:pages` — regenerate `docs/` from `shared/`.
- `npm run test:coverage` — tests with V8 coverage.
CI (`.github/workflows/ci.yml`) runs `check`, `test`, and a **docs-drift** check (re-builds and fails if `docs/` is stale).

## Hard invariants (each is enforced by a test — do not work around them)
1. **Asset registry.** Every module reachable from the `index.html` scripts (`app.js`, `local-api.js`, `transport.js`) must be listed in `shared/assets.js`. Miss one and the served UI dies on a bare 404. → `tests/assets.test.js`.
2. **Syntax coverage.** Every file under the `check` script's roots must be walked by `scripts/check.mjs`. → `tests/check-coverage.test.js`.
3. **No docs drift.** Copied UI assets in `docs/` are generated. Edit `shared/`, then `npm run build:pages`; CI + `tests/pages-bundle.test.js` fail otherwise. Hand-written markdown in `docs/` is edited in place.
4. **CSP parity.** The `Content-Security-Policy` meta in `shared/index.html` must equal the `CSP` constant in `shared/core.js` (also sent as a header). → `tests/security-headers.test.js`.

## Adding a shared module (the #1 source of regressions)
1. Create `shared/<name>.js` (browser-safe).
2. Add `'<name>.js'` to `shared/assets.js` — the one list read by both `scripts/build-pages.js` and `src/server.js`.
3. `npm run build:pages`.
`tests/assets.test.js` walks the import closure, so step 2 cannot be forgotten silently.

## Working alongside other agents
More than one agent may edit this tree at the same time. To stay safe:
- Prefer **small, additive, scoped** changes; avoid whole-file rewrites of "hot" files.
- Never `git add -A` or commit another agent's half-finished work — stage only your own files.
- When unsure, add a **new** file/test instead of editing a file that is mid-change.
- Re-run `check` + `test` immediately before you finish, and leave the tree green.

## Security
- `.env` is git-ignored and loaded at startup by `src/env.js`. **Never commit or print secrets.** Set `AGENT_SKIP_DOTENV=1` to ignore it (tests do this).
- AI providers are the environment (`AI_BASE_URL`, `AI_API_KEY` or `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY`, `AI_MODEL`, `AI_API_STYLE` `chat` | `responses` | `anthropic` | `gemini` | `azure`, `AI_TIMEOUT_MS`) plus saved BYOK providers in the workspace vault (**You → AI and models**). Five wire shapes are spoken (`shared/ai-presets.js` is the one list of protocols and provider presets): OpenAI chat completions, OpenAI responses, Anthropic Messages, Google Gemini and Azure OpenAI. Azure takes the resource endpoint plus an API version, and its model id is a deployment name; custom request headers are stored as a vault credential like the key. Saving a provider reads that provider's own model catalogue with the pasted key, so the picker offers models the key can use; `PATCH /api/ai/providers/:id` renames, re-points or rotates the key. A key is never returned and never printed. Never commit or print keys.
- Model output never gets publication/filesystem tools; the **final Post click is always human**. A bot reaches a browser only through the opt-in `browser.use` permission: it requests a page in its reply, a member approves (or set that bot to auto), and a paired local agent runs it (`shared/bot-browser.js`, `src/bot-browser.js`). Click/type on X is refused in validation; keep it that way.

## Commits
- Imperative, conventional subjects matching history (`feat: …`, `fix: …`).
- One phase/feature per commit; end every phase green.
- Tick items in `docs/BUILD-PLAN.md` as they land.

## Coverage notes
`npm run test:coverage` uses V8 coverage, which only counts files the test process imports. The browser-only files (`shared/app.js`, the DOM-bound `shared/ui-*.js` modules, and `shared/transport.js`) and `extension/popup.js` therefore show as *absent*. They are exercised by the Playwright smokes (`tests/polish_smoke.py`, `tests/usability_smoke.py`), which are not part of `node --test`. `shared/ui-model.js` and `shared/ui-kit.js` are imported by Node and are covered by `node --test`.
