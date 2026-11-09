# Changelog

## Unreleased

The JSON store is gone, one list decides what ships, and the app opens without
a network.

### Added
- **One list of served files**: `shared/assets.js`. `scripts/build-pages.js` and
  `src/server.js` both import it, so a module imported by `index.html` reaches
  the Pages bundle and the Node server, or neither. `tests/assets.test.js`
  walks the import closure against it.
- **`npm run check` walks the tree**: `scripts/check.mjs` checks every `.js` and
  `.mjs` file under `src/`, `shared/`, `agent/`, `extension/` and `scripts/`
  (75 files) instead of a list kept by hand.
- **An offline shell.** The service worker caches the app shell as it installs
  and serves it when the server or the network is down; `/api/*` is never
  cached. A notification tap opens the app on the screen that message is about.
- **Per-account sign-in limit.** Sign-in and forgot password count attempts
  against the named account as well as the client address, 8 per 15 minutes
  each, so burning addresses does not buy unlimited guesses at one mailbox. A
  request that names no account does not touch an account bucket.
- **Unsaved admin typing survives the repaint** a click on the page triggers. A
  reveal used to blur the credential field on another row and drop it.
- **Five wire protocols for a provider.** A saved provider speaks
  `openai-chat` (`POST {base}/chat/completions`, bearer token),
  `openai-responses` (`POST {base}/responses`, bearer token), `anthropic`
  (`POST {base}/messages` with `x-api-key` and `anthropic-version`), `gemini`
  (`POST {base}/models/{model}:generateContent` with `x-goog-api-key` and
  `systemInstruction`/`contents`/`generationConfig`) or `azure-openai` (`POST
  {base}/openai/deployments/{deployment}/chat/completions?api-version=` with an
  `api-key` header, no `model` in the body). The ids and the preset endpoints
  live once in `shared/ai-presets.js`, so the server and the settings page
  cannot disagree. Presets cover OpenAI, Anthropic (Claude), Google Gemini,
  xAI, Groq, Mistral, DeepSeek, OpenRouter, Together, Fireworks, Perplexity,
  Cerebras, Cohere, Qwen, Moonshot, Zhipu, DeepInfra, Hyperbolic, Nebius, NVIDIA
  NIM, GitHub Models, Azure OpenAI, LiteLLM, Ollama, LM Studio, vLLM/llama.cpp,
  LocalAI, Jan and a custom endpoint; the local ones ignore the key.
- **A provider can carry custom headers and an Azure API version.** The form
  takes headers as one `Name: value` per line, up to eight, sent with every
  request and applied last (so a gateway may replace the auth header). Only the
  header names are ever listed again; the values join the key in the encrypted
  vault. Azure's version field falls back to `2024-10-21`, and the model id
  there is the deployment name.
- **`Test` proves a provider with one small call.** `POST
  /api/ai/providers/:id/test` sends a 16-token request with the stored key and
  reports the model and the round-trip time, so a wrong key or model shows up in
  the settings page instead of in a later drafting failure.
- **Saving a provider reads its own model catalogue** with the key just given
  (`GET {base}/models`; Anthropic paging on `has_more`, Gemini on
  `nextPageToken` with embedding-only models hidden; an Ollama `/v1` endpoint
  without `/v1/models` falls back to `/api/tags`). Both the chat-capable ids and
  the full list the key can see are stored, so a hidden model can still be typed
  by hand. A failed read is stored as `modelsError` and shown next to the
  provider without losing the save: a refresh keeps the last good list, and a
  changed endpoint, key, header set or API version starts a fresh one. Anthropic,
  Gemini and Azure need a concrete model id, so a fresh provider starts on the
  first model the catalogue reported rather than `auto`.
- **A provider can be edited, not only replaced.** `PATCH
  /api/ai/providers/:id` renames it, re-points it, rotates the key without
  deleting it — a blank key keeps the stored one — and changes its headers or
  API version; any of those re-reads the catalogue. The vault ciphertext is
  replaced in place and nothing secret is ever returned.
- **Protocol and keys from the environment.** `AI_API_STYLE` accepts `chat`,
  `responses`, `anthropic`, `gemini` and `azure` (aliases `messages`/`claude`,
  `google`, `openai`/`compatible`), and infers the protocol from the host when
  blank. With no base URL, `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` alone
  point the app at Anthropic, `GEMINI_API_KEY`/`GOOGLE_GENAI_API_KEY` alone at
  Gemini, and `AZURE_OPENAI_ENDPOINT` plus `AZURE_OPENAI_API_VERSION` reach
  Azure; `AI_API_KEY` and `OPENAI_API_KEY` keep working.

### Fixed
- **A tool block the model puts last keeps its closing fence.** The reply
  cleanup that unwraps a ```` ```markdown ```` answer also stripped a trailing
  closing fence, so an `ask` or `create-bot` block that ended the reply arrived
  unclosed at the parser. An unclosed block is plain text, so the bot's request
  silently never happened and the raw JSON reached the draft. Tool fences are
  now held back from that cleanup, and a long reply is sliced only when it
  carries no tool block (`tests/ai-protocols.test.js`).
- **The turn after a teammate answers keeps its own requests.** That turn was
  run through the control-block stripper, which threw away a `create-bot`,
  `browser` or `spawn` block the bot wrote after its question was answered, so
  asking a teammate silently disabled every other capability for that step. The
  peer's answer is still stripped (it is untrusted); the bot's own reply is only
  checked for a second ask (`tests/bot-link.test.js`).
- **A claimed batch keeps every lease alive.** One heartbeat renewed only the
  task being run, so a batch behind a slow model call looked dead to the next
  sweep and a waiting task could be executed twice. The heartbeat now renews
  every claimed task until its own turn ends.
- **A client cannot post under a run id.** A message whose id is already stored
  is skipped, and only a trusted server write of a run it executed replaces one.
  A client could otherwise reuse an id it was handed and swallow the bot's
  reply (`tests/chats.test.js`).
- **Behind `TRUST_PROXY=1` the client address is the rightmost
  `X-Forwarded-For` hop**, the one the proxy wrote; the leftmost one a caller
  invents no longer earns a fresh attempt bucket.
- **The command palette is a combobox** (`aria-controls`,
  `aria-activedescendant`, `aria-autocomplete="list"`), and an error toast is
  announced assertively while the rest stay polite.
- **Panes use `100dvh` and honour the notch and home-indicator insets**, text
  fields are 16px so iOS stops zooming on focus, and the small controls are
  44px on a coarse pointer.
- **Every untrusted URL is validated before it reaches an `href`.** The four
  sinks — a captured post's URL, an evidence link, the post a draft is about
  and the page a bot asked to open — go through `validHttpUrl`, so a
  `javascript:`, `data:` or credentialed URL never survives as a link, and a
  draft whose URL does not validate renders no link at all.
- Tests for the store's serialized `update()` path, the scheduler's ticks and
  its boot-order retention sweep, and a task re-armed from a dead process while
  a live lease is left alone.

### Changed
- **The JSON store is removed.** `src/store.js` and `STORE_BACKEND` are gone;
  `src/server.js` opens the SQLite store directly. A `state.json` written by 0.6
  is still imported once and left beside the database.
- **`node:sqlite` needs `--experimental-sqlite` below Node 23.4.** `npm start`,
  `dev`, `test`, `test:coverage`, `backup` and the Dockerfile `CMD` pass it, and
  the server no longer re-execs itself to add it.
- **A database written by a newer build is refused at boot**, with both schema
  versions in the message, instead of being opened against columns this build
  cannot write.

## Unreleased — bots, settings and browser control

Bots that work together, with settings you control.

### Added
- **Bot settings**: on/off, reply length, temperature, tone, chat memory,
  summonable, hand-off and colour, validated by `shared/bot-settings.js` on both
  transports and stored in SQLite (schema v7).
- **Group settings**: routing mode (pipeline, lead only, everyone), pipeline
  order, step limit up to 12, approve between steps, bot handoffs. Edit and
  delete groups; remove bots.
- **@mention any bot in any chat**, including summonable bots from other groups,
  with the chat's recent messages as context. Composer mention suggestions.
- **Bot-to-bot handoff**: a reply that @mentions a teammate extends the run,
  revalidated by `handoffTargets` and bounded by the step limit.
- **Scheduled bot tasks** (`bot-task` queue kind) that post into the chat.
- **A primary bot that can keep a task on track.** Group settings choose
  “I'll direct them” or “One bot keeps it on track” (X-engage starts on the
  second). The primary bot plans only the bots the request needs, can wait
  for Start, checks the result, and asks the owner once more if it is missing.
  You still edit and post.
- **Local browser control for any bot** (`browser.use`, opt-in): a bot asks
  for a page in its reply, the chat shows an Approve/Decline card (or the bot
  is set to run without asking), a paired local agent opens it, and the bot
  continues with the result. Click and type on X are refused.
- **Sub-agents on demand** (`subagent.spawn`, opt-in): a bot may hand one small
  job to a helper model by putting a fenced `spawn` block in its reply. The
  helper runs as a separate call with no permissions, no tools, no web access
  and no memory of the chat, its own reply is never parsed for a block, and its
  answer goes back to the bot that asked, which writes the real reply. One
  helper per reply; a failed helper never costs the reply.
- **Bots remember the chat and keep a rulebook** (schema v9): every bot turn
  receives a recap of the conversation and the rules learned for *its* model,
  and leaves both behind. Durable instructions a person writes in the chat
  become rules immediately; on a cadence one extra model call rewrites the
  book and the recap into something compact. The recap is bounded, rebuilt from
  stored messages when no provider is set, kept for `CONSOLIDATE_AFTER` turns
  after a model rewrite, and a forgotten chat stays forgotten until a newer
  message arrives. Memory is context, never a second system prompt: the task
  still wins, and a bot can be set to leave memory out entirely.
- **Bots ask each other** (`bot.ask`, opt-in): a bot may put one fenced `ask`
  block in its reply and a teammate answers as itself, on its own model and
  rulebook, with no permissions and no tools. The asker gets one more turn with
  the answer marked as untrusted text; the exchange is one round deep, a
  control block in the answer is stripped, and a refused or failed ask never
  costs the asker's reply.
- **Bots create bots** (`bot.create`, opt-in): a bot may put one fenced
  `create-bot` block in its reply, and the new bot becomes a normal roster
  record — always `custom`, no permissions, no model, no contract escalation.
  The permission is checked again against the roster inside the write, the name
  must be free, the group limit is enforced for people too, and a reply with two
  blocks creates one and says why. Schema v10 keeps who created it and how.
- **Reset password from the sign-in screen.** Forgot password asks
  `POST /api/auth/forgot`; the server still prints the one-time token in its
  log. A second form submits that token to `POST /api/auth/reset`.
- **Draft cards from a group run.** A bot with `draft.create` whose reply
  names a captured post URL files that reply as a pending draft. A second
  model call is not made.
- **Home-feed read.** A tracked request to scroll or read the feed asks the
  source bot to scroll and read `x.com/home` first. The other bots wait for
  that page, and they do not run if it is refused or the bot lacks `browser.use`.
- **Email relay.** With `EMAIL_RELAY_URL` set, the email channel POSTs
  `{to, title, body, meta, at}` to that gateway (`EMAIL_RELAY_TOKEN` as a bearer
  token when set). Operators point the URL at their own HTTPS gateway; this
  repo still does not speak SMTP. An unset relay still fails the delivery
  instead of marking the mail sent.

### Fixed
- A bot that asks for a page pauses that same run until the result is back. The
  next bot no longer runs as if the page had arrived, and the result is not
  queued as a new run (which 409'd while the first run was still going).
- Saving one X-engage group setting no longer writes the "every bot" pipeline
  over Scout → Ranker → Researcher → Writer → Reviewer.
- A scheduled task posts its chat line only after the run queues, so a busy
  group or a validation error is not logged as a run that started.
- Duplicating the primary bot no longer leaves two primaries.
- A home-feed capture that puts page text in `actions[].text` still counts as a real feed.
- Restoring a backup interrupts in-flight group runs, so a missing browser-request card cannot 409 the group forever.
- The Node build ignores leftover GitHub Pages demo runs in the chat list, thread, Runs panel, and Continue. Those leftovers used to paint Approve on a live server.
- Continue reports the run's real status after the next step (a pause or done), not a fake `running`.
- A send that comes back already paused at a checkpoint no longer claims the others are working.
- Declining a page on a checkpointed run pauses before the next bot, instead of skipping the gate.
- Grant browser access grants `browser.use` instead of only opening the profile editor, including on Pages.
- A Pages scheduled task occupies the group while it runs, then frees it.
- The Pages demo pauses for Approve between steps, same gate as Node, then continues from that bot. A paused run keeps its gate and input in the local log, and the Runs panel shows Approve next step.
- A checkpoint in a one-to-one chat counts on that chat, not the group. The drafts pill no longer counts a paused run as a draft. Continue and Start follow the run's conversation. The group home lists paused runs on Runs, not Drafts. A waiting plan or page is listed there too.
- A 1:1 browse result returns the agent POST before the follow-up model call, so the agent's 15s timeout does not abort it. The next bot turn gets the captured page (up to 3600 chars), not only the short chat summary.
- Members can read Voice and timing; only an admin can save it. Viewers cannot send, create, approve drafts, share posts, or save group settings.
- A structured contract is checked after browser fences are stripped, so a bot
  that holds `browser.use` can still ask for a page.
- Showing a tracked plan no longer switches bots on. Start does. Cancel leaves
  them off. A plan or a checkpoint counts as a live run, so a second one waits.
- Starting a shown feed plan files the home-feed read before any bot runs.
- A restart no longer cancels a shown plan or a checkpoint.
- The Pages demo refuses a second send while a plan is on screen or a group
  run is still painting.
- A Pages scheduled task waits when a plan is already on screen, and a nested
  demo API call no longer starts a second scheduled run.
- A Pages chat send occupies the group before it fetches state, so a due
  scheduled task cannot cut in.
- Browser fences at the end of a long reply are still filed; two pages in one
  reply wait for both results before that bot continues.
- An oversized run envelope is shrunk field-by-field so the model still
  receives valid JSON.
- A dispatched page that is holding a group run can be declined, the same as a
  home-feed read already sent to the device.
- Invited members can sign in with their email. Change password lives on You.
- A summonable guest keeps its real name in a group chat.
- Clearing a group chat also drops the run log, so a later stream cannot
  refill it.
- A 1:1 browse continues that bot instead of starting a group run.
- Declining a page that is holding a run keeps following the thread.
- Failed scheduled bot tasks can be retried from the chat.
- A reply that is only a browser fence still pauses for approval instead of
  becoming raw JSON the orchestrator never files. A long reply keeps a
  trailing fence instead of slicing it off at 3000 characters.
- Clearing a Pages chat (or removing its bot or group) cancels the local
  run log that was blocking the group, and a refresh interrupts a leftover
  `running` simulation. Cancel is on those stuck run cards. Clearing the
  team chat also ends a busy run that lived on a bot DM of that group.
- Clearing a chat denies waiting browser requests and cancels that
  conversation's busy runs, so a later send is not stuck behind a 409.
  Removing a bot or a group does the same for the work it was holding.
- Pages Start puts the plan back if another run in that group is already
  active, instead of leaving it queued with no Start button.
- Delete my account is on You. Disable or Enable an account is on Team.
- The invite form's temporary password matches the server (8 characters).
- A tracked plan is Handoff's own chat; the X-engage group chat still runs
  the pipeline unless you @mention one bot.
- Operator docs match the running server: route table (not `WRITE_ROUTES`),
  optional `TLS_CERT`/`TLS_KEY`, owner-only restore, `AI_TIMEOUT_MS` default
  180s, `TRUST_PROXY`, `RESET_TOKEN_CONSOLE`, `browser.action` in the agent
  protocol, and those knobs in `.env.example`.
- A run waiting on two pages of one reply keeps the second page even when the
  first request's status flip commits before its page is appended (the page is
  consumed atomically with the wait-decision), and a retried agent result is
  appended once, not twice.
- A 1:1 page result no longer flows page text back in the task message: it
  travels in its own `page` field, marked untrusted text rather than a new
  instruction.
- Browser blocks are capped at two per reply total, valid or invalid, so a
  reply cannot flood the chat with error cards.
- Queue handlers renew their lease while running, so a long model call is not
  re-claimed mid-flight, and the configured lease length actually reaches
  `claimTasks` (it was silently dropped).
- `recoverAgentTasks` counts browser-action failures as settled; removing the
  first workspace answers 409, not 500. Notification prefs PATCH is back to
  `member`; `POST /api/auth/reset` has the same per-IP throttle as login.
- Writes to X and Twitter are refused through the WebSocket upgrade too (it
  hides inside a GET), and an email relay must use https except under the
  private-network opt-in.

### Changed
- A group without a pipeline now runs every switched-on bot (up to its step
  limit) instead of the first three.
- The "Approve between steps" gate is a server-side group setting, not a
  per-browser toggle.

## 0.7.0

Bring-your-own-key AI, permissioned local-agent actions, and a hardening pass.

### Added
- **BYOK AI providers** — add any OpenAI-compatible provider (OpenAI, Groq,
  OpenRouter, Ollama/vLLM, a router) under *You → AI and models*. Keys are
  AES-256-GCM encrypted in the workspace vault; model lists come from the
  provider's own `GET /v1/models`. A workspace sets a default provider + model,
  and each bot can override both.
- **Permissioned local-agent browser actions** — a `browser.action` task kind
  drives an allowlisted page (navigate/click/type/waitFor/read, ≤25 steps)
  through the agent's real browser, inside the same allowlist and private-address
  proxy as a read, in a fresh profile unless `AGENT_BROWSER_PROFILE` opts in.
- **Opt-in signed-in journeys** — set `AGENT_BROWSER_PROFILE` to keep a browser
  profile; `TRUST_PROXY=1` makes the rate limiter and secure-cookie hint use
  `X-Forwarded-For`/`X-Forwarded-Proto` behind a reverse proxy.
- Operations runbook (`docs/OPERATIONS.md`), deployment units
  (`deploy/*.service`, `deploy/cloudflared-config.yml`) and a proven
  backup/restore drill.

### Fixed
- Output contracts validate every declared field **type**, not just presence.
- Pairing codes carry the admin's permission scope; a device can only narrow it.
- The agent's plain HTTP checks are pinned to the vetted address (no DNS-rebind
  window) and the SSRF guard decodes 6to4/NAT64 and more reserved ranges.
- Backups require a checksum, omit agent secret ciphertext, and clear sessions on
  restore; restore accepts documents larger than 128 KB.
- Agent task attempts are counted once (max-attempts off-by-one); retry backoff
  starts at 1s; task kinds validate the field they need.
- A corrupt stored password hash is refused instead of throwing; changing your
  password keeps your own session.
- Route/UI fixes: the AI admin page is a real route, legacy tabs map only for
  x-engage, history depth is read from the entry, clearing a conversation lets
  queued sends land first, overlapping sends keep the typing indicator, the push
  subscription key is validated at subscribe, and idle ticks no longer rewrite
  the store.

## 0.6.0 and earlier
See the git history and the delivered phases in `docs/BUILD-PLAN.md`.
