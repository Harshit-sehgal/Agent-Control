# Phase 4: Subscription models, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. TDD per task.

**Goal:** Bots can run on the owner's Claude and ChatGPT subscriptions. The paired local agent spawns the unmodified `claude` and `codex` CLIs, which the owner has signed in to in their own terminal. The app never sees, stores or forwards those logins.

**Spec:** `docs/superpowers/specs/2026-11-11-primary-bot-platform-design.md`. Read these sections:
- "Constraints" (subscription terms)
- "Models: API keys plus subscriptions"
- "No token streaming for `local-cli` bots in v1"

## Global Constraints

- Zero npm runtime dependencies: spawn the CLIs with `node:child_process`. Use no SDK packages.
- Never read, copy, log or send the CLIs' credential files or tokens. Sign-in status comes only from the CLI's own status command (or a harmless probe it documents), run on the owner's machine.
- `claude -p` must not use `--bare`. Disable the CLIs' built-in file and shell tools. Before you use any flag, confirm it in the local `claude --help` / `codex exec --help` output and record each flag in the ledger. A bot must not touch the owner's filesystem.
- Model output never gets publication or filesystem tools. App actions (handoff, ask, create bot, browser) still travel as text fences, as they do for API bots.
- Tests never call the real CLIs: use a fake executable on `PATH` in a temp dir. Do not run the real CLIs in any test, because that would spend the owner's subscription.
- The usual repo gates (AGENTS.md) apply.

## Tasks

1. **Provider kind `local-cli` with engines `claude` and `codex`** (`shared/ai-presets.js`, `src/ai-providers.js`). A provider record holds no key. It names the engine and an optional model. A bot can choose it like any other provider. Tests: saving one needs no key; listing it never shows a secret.
2. **Agent task `model.run`.** Add it to `AGENT_ACTIONS` in `src/agent.js`. The agent handles it in `agent/` with a new `agent/cli-model.mjs`:
   - It builds the argv and spawns the CLI with a timeout and an output cap.
   - It parses stream-json / `--json` into the final text.
   - It maps "not signed in", "usage limit" and a missing binary to clear error codes.
   - The prompt goes in through stdin, never through argv, so it cannot show in `ps`.

   Tests use a fake CLI that echoes and also fails each way.
3. **Server side of a `local-cli` bot turn.** `executeCustomBot` / `runBotTurn` enqueue `model.run` for a paired agent holding that permission, then wait for the result: poll the agent task with the run's timeout, and keep the run `running` meanwhile. The UI's "working…" line stays.
   - No agent paired: the run fails with "Pair a local agent and run `claude` on that machine to sign in."
   - Limit hit: the run fails, and a chat line of kind `model-limit` offers "Switch this bot to <other connected model>" through the existing bot PATCH.
   - Tests: `tests/local-cli.test.js` covers success, not signed in, limit, no agent, and timeout.
4. **Sign-in status in the heartbeat.** The agent reports `{claude: 'signed-in'|'signed-out'|'missing', codex: …}` by checking the CLI's own status, cached for 10 minutes. `GET /api/agents` exposes it. Settings → Models and keys shows it later, in the UI work.
5. **Docs.** Update `docs/DEPLOYMENT.md` and README with a "Use your Claude / ChatGPT subscription" section. Tick Phase 4 in `docs/BUILD-PLAN.md`.

## Review Focus

1. A prompt that contains shell metacharacters or begins with `-`. Nothing may be interpreted.
2. A CLI that hangs forever. Kill it at the timeout and fail the run cleanly.
3. A CLI that prints megabytes. Cap the output and keep the agent alive.
4. Two runs at once on one agent. Neither run's output crosses into the other.
5. The CLI binary is missing. Show a clear message and never crash.
