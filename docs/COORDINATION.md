# Bot-to-bot coordination contract — v0.3

## Scope

The platform keeps named bots with distinct instructions and gives every group a shared conversation. Group messages use bounded, explicit handoffs. This follows common AI team designs but does not claim feature parity with Grok Bot or OpenAI Dots.

## How a group message is routed

1. The server validates the authenticated user and selected group.
2. `@Writer`, `@Reviewer`, `@bot-id`, and named bot mentions select the recipients in mention order.
3. `@everyone` selects at most six members.
4. A message without a mention selects the group's standard pipeline. X-engage uses Scout → Ranker → Researcher → Writer → Reviewer. Other groups use up to three bots in roster order.
5. The engine creates a run ID and an ordered recipient list. The list cannot be changed by model-generated text.
6. The engine gives one bot the user objective, its lasting instructions, and the previous bot's bounded output.
7. After a step completes, the engine appends a sender-identified handoff to the group chat and advances to the next recipient.
8. The last step completes the run. Human approval remains mandatory for outward-facing actions; the coordinator has no publication tool.

The group chat exposes the bot's name, the next recipient, time, run ID (stored), and result. The Node server persists each step before continuing. A restart marks unfinished runs as `interrupted` rather than blindly repeating an uncertain model call.

## Boundaries and safety

- **Maximum six bot steps per run**; no self-recursion or automatic agent-created loops.
- **No cross-group handoffs**; every recipient must belong to the selected group.
- **No self-reported authority**; outputs from other bots are untrusted input and cannot grant permission.
- **No secret or account access** from text-only model workers.
- **No X read/scroll/post automation** from group chat. X posts still require user-selected context and a manual final action.
- **No fabricated research**: current Researcher has no external evidence retrieval tool.
- **No external action without a separate approval**. A bot's agreement is not a human approval.
- **Per-group single-flight** on the Node worker to avoid overlapping runs; bounded, serial steps; persisted trace and failure state.
- **No on-prem/cloud always-on guarantee** until a durable cloud executor is deployed.

## GitHub Pages demonstration

`shared/coordination.js` contains the routing policy shared by the Node engine and the Pages demo. `shared/group-simulator.js` implements a visible deterministic demonstration. It passes context between mock specialists and can create **pending template drafts** through the existing browser-local mock API. It never calls a model. Both chat history and the run trace are saved in `localStorage`. Data is not synchronized across devices.

Try X-engage → Group chat → `Check the latest candidate and prepare a draft`. The group will show Scout → Ranker → Researcher → Writer → Reviewer. Try `@Writer @Reviewer Draft and check one reply` to route only to two specialists.

## Local Node engine (real model calls)

Start `npm start` with an AI provider configured — `AI_API_KEY` plus `AI_BASE_URL` for any OpenAI-compatible endpoint, or `OPENAI_API_KEY` for OpenAI itself — and `DASHBOARD_PASSWORD` set in the **server process environment** (or in a git-ignored `.env`). Authenticate to obtain the HTTP-only `agent_session` cookie.

- `POST /api/groups/:groupId/chat` with `{"message":"Check this topic","directBotId":null}` returns HTTP 202 with `runId` and `status`.
- `GET /api/groups/:groupId/chat` returns the persisted group `messages` and `runs` for polling.

Only the user-authenticated API can start a run. Node workers call a real AI model with each recipient bot's instructions and the previous step's text. This is **model-to-model sequential coordination**, not independent long-running agents with their own browsers, memory stores, or autonomous delegation permissions. The current hosted Pages UI cannot talk to the local Node server without an explicitly configured authenticated backend.

The Node server stores the run state in `data/state.json` and must not be exposed without private networking, HTTPS, and an access gateway. Its session handling is a private-prototype implementation, not production SaaS authentication.

## Testing

Run `npm run check && npm test`. `tests/coordination.test.js` checks routing, group isolation, context passing, the mock chain, persisted Node execution, interruption handling, and error states. The browser smoke check (development environment with Chromium/Playwright installed) exercises the group chat and subsequent human approval.

## Not implemented yet

Autonomous role selection by a model, agent-initiated cross-chat DMs, per-agent permissions beyond the text-only model boundary, multi-user identity isolation, real web research, cloud execution, shared device synchronization, and model-based chat on GitHub Pages.
