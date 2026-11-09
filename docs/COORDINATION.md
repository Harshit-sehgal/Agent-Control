# Bot-to-bot coordination contract — v0.4

## Scope

The platform keeps named bots with distinct instructions and gives every group a shared conversation. Bots can be called into any chat with an @mention, can pass work to each other, and can run on a schedule. Every step is bounded and recorded. A bot reaches a browser only through the opt-in `browser.use` permission. This follows the Grok-bot pattern (mention a bot anywhere and it answers in context) but does not claim feature parity with Grok or any hosted agent product.

## Settings a user controls

Each bot and each group carries settings (`shared/bot-settings.js`). The Node server and the Pages demo validate them through the same module.

**Bot settings** (bot profile → Behaviour):

| Setting | Values | Effect |
|---|---|---|
| `enabled` | on / off | An off bot never answers, is skipped by pipelines, and its scheduled tasks are skipped. |
| `replyLength` | short / medium / long | Output budget of 500 / 1500 / 3000 tokens. Medium keeps the earlier default. |
| `temperature` | empty, or 0–2 | Empty leaves the provider default. |
| `style` | text, ≤600 chars | Added to the bot's job as tone guidance. |
| `contextMessages` | 0–30 | How many recent messages of the chat the bot reads. |
| `memory` | on / off | Keep a per-model rulebook and a per-chat recap for this bot's turns. Off leaves this bot out of memory entirely. |
| `summonable` | on / off | May be @mentioned from a chat outside its own group. |
| `canHandoff` | on / off | May pass work on by @mentioning another bot. |
| `tint` | colour 0–5 (six palette slots) | Avatar colour, stored on the server so it follows you. |

The model provider and model per bot are set in the same profile (see BYOK in the README). Permissions stay in the bot contract; no setting can grant an action, and publishing is never grantable.

**Group settings** (group info → Group settings): name, description, routing mode, pipeline order, step limit (1–12, default 6), approve between steps, whether bots may hand off, and who keeps a task on track. **I'll direct them** (`direct`): you @mention who you want, or the no-mention **routing** above runs; the primary bot does not run a tracked plan. **One bot keeps it on track** sends a plain message to the primary bot through a plan of only the bots that request needs, then checks the outcome. **Show me the plan first** waits for Start. X-engage begins on “one bot keeps it on track.” Bots can be added, removed, and switched off; a group other than X-engage can be deleted by an admin.

## How a message is routed

1. The server validates the authenticated user and the conversation's group.
2. Explicit mentions win: `@Name` or `@bot-id` picks those bots in mention order. A mention may name a **guest**: a switched-on, summonable bot from another group. `@everyone` picks every switched-on bot of the group.
3. Without a mention, a direct chat asks its own bot. A group chat follows its routing mode:
   - **pipeline**: the pipeline order (X-engage: Scout → Ranker → Researcher → Writer → Reviewer; other groups: every bot in roster order unless reordered);
   - **mentions**: only the first pipeline bot (the lead) answers;
   - **everyone**: every switched-on bot answers.
4. Switched-off bots are dropped, and the list is capped at the group's step limit.
5. Each step gets the user objective, the bot's lasting instructions, the previous bot's bounded output, the last N messages of the chat (`contextMessages`), and the teammates it may hand off to. It also gets the workspace memory for its own model and this chat: a bounded rulebook and a rolling recap, marked as context rather than new instructions. All of it is marked as untrusted data.
6. **Handoffs.** When a bot's reply @mentions a teammate, the engine may append that teammate to the run. It does so only when the group allows handoffs and the bot may hand off. The teammate must be a roster bot or a live guest, not the speaker, and not already in the run, and the run must stay within the step limit. Model text can extend a run only through this check (`handoffTargets` in `shared/coordination.js`).
7. Each step is persisted and written into the conversation the run started from, with the sender's name. The last step completes the run.
8. **Tracked runs.** When the group is set to one bot keeping it on track, a plain message to the primary bot does not use the routing above. `planTracked` picks bots by what the message asks (a feed read includes Scout and Ranker; a draft or a suggestion includes Writer and Reviewer). A message that names no job, and questions about status, reminders or making a bot, stay with the primary bot. The group chat still runs the pipeline. The primary bot is not a worker, unless they are the only source bot and the message asks for the home feed. In that case they still open the page. The run stores the outcome it is aiming at. If that outcome is missing, the bot that owns it is asked once more. The closing line says what is waiting. Posting stays with the user. A request to read or scroll the feed files one read-only home-feed request for the source bot first (`scroll` and `read` only). The other bots wait until that page comes back, and they do not run if the request is refused or the bot lacks `browser.use`. Showing the plan does not switch those bots on. Start does, then files the feed read if one is needed. Cancel leaves them off. A second message waits while a plan or a checkpoint is open.

A restart marks a run that was still calling a model, queued, or waiting on a page as `interrupted`, rather than repeating an uncertain model call. A shown plan and a checkpoint stay, so Start and Continue still work.

## Scheduled bot tasks

A chat's info panel → Scheduled tasks (or the composer's + → Schedule a task) asks a bot or a group to run a prompt once or every N minutes. The task is a `bot-task` queue record with retries and leases. When it fires, the chat shows `Scheduled task: …` and the run's replies follow. Scheduling the task is the approval, so **Show me the plan first** does not make a timer wait for Start. If the bot is switched off or no AI provider is configured, the chat says the task was skipped. On Pages, scheduled tasks run the deterministic simulator while the page is open.

## Boundaries and safety

- **Hard cap of 12 bot steps per run** (`MAX_STEPS_LIMIT`), whatever a group sets; no self-handoff and no repeated recipient.
- **Guests are opt-in per bot** (`summonable`), keep their own permissions and contract, and report into the host conversation only.
- **No self-reported authority**: outputs from other bots and chat history are untrusted input and cannot grant permission.
- **No secret or account access** from text-only model workers.
- **No X post automation** from chat. A bot with `browser.use` may read an X page through the local agent, but click and type there are refused. X posts still require a manual final action.
- **Browser use is opt-in per bot** (`browser.use`), runs only on a paired local agent, asks for approval by default, and is capped at 2 requests per reply and 3 round trips per turn (`shared/bot-browser.js`). A page request pauses that run (`awaiting_browser`) until the result is back, then that same bot continues; a home-feed read still uses `awaiting_feed`.
- **Sub-agents are opt-in per bot** (`subagent.spawn`), one per reply and one round per task (`shared/subagents.js`). The helper is a separate model call with no permissions, no tools, no web access and no conversation memory, and its reply is never parsed for a block, so it cannot spawn a helper of its own. Its answer goes back to the bot that asked, marked as untrusted text, and that bot writes the real reply; a failed helper never costs the reply. It is extra thinking, not extra authority.
- **Peer asks are opt-in per bot** (`bot.ask`), one per reply and one round deep (`shared/bot-link.js`). The teammate answers on its own model and rulebook, with no tools, and its answer comes back marked as untrusted text. The teammate's reply is never parsed for another ask. A failed or refused ask never loses the asker's reply.
- **A created bot starts unprivileged** (`bot.create`), one per reply (`shared/bot-create.js`). It is always a custom bot with no permissions and the default contract; the creating model cannot set its type, model, contract or permissions. It is capped by the group's bot limit, and a person reviews it like any other roster entry.
- **Memory is workspace data, not authority** (`shared/memory.js`). It is bounded, persisted with the workspace (schema v9 `memory` table) and carried by backups. It is context a model reads, never a permission or an instruction that widens what a bot may do; a person can edit or forget it, and a bot's `memory` setting can leave it out.
- **No external action without a separate approval**. A bot's agreement is not a human approval.
- **Per-group single-flight** on the Node worker; a scheduled task that meets a busy group retries with backoff.

## API

- `POST /api/groups/:group/chat` `{message, directBotId, checkpoints, chatKey}` → 202 `{runId, status}`.
- `GET /api/groups/:group/chat` → persisted group `messages` and `runs`.
- `POST /api/groups/:group/runs/:run/continue` (member) → 202. Resume a run paused at `awaiting_checkpoint`.
- `POST /api/groups/:group/runs/:run/plan` `{approve}` (member) → 202. Start or cancel a shown plan.
- `PATCH /api/groups/:group` `{name?, description?, settings?}` (member). `DELETE /api/groups/:group` (admin).
- `POST /api/groups/:group/bots`, `PATCH /api/groups/:group/bots/:bot` `{name?, instructions?, contract?, permissions?, settings?}`, `DELETE /api/groups/:group/bots/:bot` (member).
- `POST /api/browser-requests/:id/approve`, `POST /api/browser-requests/:id/deny` (member): decide on a bot's browser request.
- `POST /api/tasks` `{kind: 'bot-task', payload: {groupId, botId|null, message, label?, kind: 'once'|'interval', intervalMinutes?, nextAt?}}`; `DELETE /api/tasks/:id`.
- `GET /api/memory` → `{rulebooks, chats}` (viewer). `POST /api/memory/rules` `{model, text}` (member), `DELETE /api/memory/rules/:id?model=…` (member), `POST /api/memory/forget` `{model?, chat?}` (member), `POST /api/memory/consolidate` `{botId, chat?}` (member): one explicit memory rewrite.

## GitHub Pages demonstration

`shared/coordination.js` holds the routing policy shared by the Node engine and the Pages demo. `shared/group-simulator.js` is a deterministic demonstration that follows the same routing, guests, handoff, and checkpoint rules without calling a model. Data stays in `localStorage`. The demo cannot open pages; that gate is a paired local agent on the Node build.

## Testing

`npm run check && npm test`. `tests/coordination.test.js` and `tests/bot-flex.test.js` cover routing modes, settings validation, guests, handoff bounds, thread context, scheduled tasks, and persisted execution. `tests/memory.test.js`, `tests/memory-routes.test.js`, `tests/bot-link.test.js` and `tests/bot-create.test.js` cover durable memory and its storage/backup round trip, peer asks, and created bots.

A bot with `draft.create` that names a captured post URL in the run files that reply as a pending draft. The Pages simulator still creates its template draft through the candidate process route.

## Not implemented yet

These stay out on purpose. Model-chosen routing would let model text pick the first roster; the initial plan stays the keyword plan in `planTracked`, and model text can only add someone through `handoffTargets`. Real web research is the opt-in `browser.use` read, not a fetch of whatever URL the model writes. Cloud execution needs an always-on host. Model-based chat on GitHub Pages would need a key in the browser.
