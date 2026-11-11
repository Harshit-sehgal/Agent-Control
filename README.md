# Agent Control — working prototype v0.7

A local-first personal bot platform. One owner runs a primary bot, **Atlas**, in a **Home** group, adds other bots in groups of their own, and lets them work together in group runs with handoffs. Bots run on your own AI provider keys, keep durable memory, and can use a browser through a paired local agent. Anything that acts outside the app stops for your approval first.

## Interface: a chat-first, messenger-style workspace

The interface is organized like a messenger. The Node server and the GitHub Pages demo render the exact same UI from `shared/`, styled by one stylesheet (`shared/app.css`) that uses system fonts only.

- **A company of bots.** A new workspace opens with **Atlas**, the primary bot, in a company that holds every bot. Atlas is pinned by default. Bots can report to a manager, a manager hands work to its team, and any bot may ask any bot or make a new one. A **thread** is a chat that Atlas owns and runs with whichever bots the work needs. There are no groups to create.
- **Chats home.** On a laptop (1024px and wider) the bots live in a left sidebar and the chosen chat opens on the right; on a phone home has two sections, **Bots** and **Threads**, switched by swiping. Pinned bots sit in a row of large faces; every other bot is a chat row with its last message.
- **The whole bot is the handle.** Right-click (or the menu key, Shift+F10, or touch and hold on a phone) opens the options menu: Message, Profile, Pin, Move to…, Hide, Delete…. Press and move (or long press) drags a bot: drop it on the pinned row to pin it, drag a pinned face out to unpin, drop it on a manager's row to move it to that team, or among its team to reorder. Alt+arrows move the focused bot. Pins and order are saved per person in the browser.
- **Basic access without asking.** Every bot opens web pages and reads your connected apps on its own. Sending, posting, deleting, changing something in a connected app and paying still ask. **Settings → Permissions → Browse and read without asking** turns that off, and a site you set to Ask each time or Deny still asks or refuses. Once a run has read your mail or files, opening a site that bot has no Always allow for asks first.
- **Asks, not refusals.** A bot never says it lacks permission: it asks. The ask card sits in the chat where the bot works (and as a "Needs you" line in Atlas's chat) with the asking bot's waiting face above one sentence and three buttons: **Decline**, **Allow**, **Always allow for this bot**. A payment only offers Decline and Allow. An answered card collapses to one muted line. Each bot's rules (Always allow, Ask each time, Deny, per site or account) are listed on its profile under Permissions and for every bot under Settings → Permissions, and **Settings → Activity** logs what left the app, permission changes and bots made, moved or paused. **Bots running** off pauses everything bots start, with a banner ("All bots are paused. Nothing runs until you resume.") and a Resume button on every screen.
- **Profile, Settings and Company.** A bot's profile has its job, memory, activity, permissions, model and team. The round avatar opens one **Settings** page (General, Appearance, Models and keys, Connectors, Permissions, Usage, Computer) with Activity and the Company chart one link away.
- **In-app sheets.** Confirmations and prompts appear as sheets inside the app, not as native browser dialogs.
- **Colour themes:** a clean light theme and a soft warm-grey dark theme. The app follows your system setting; to pin one, open **Settings → Appearance**. Each bot has its own face and pastel colour, used for its bubbles too. The bot colour is stored on the server (`settings.tint`) so it follows the account.
- **Search:** press **Ctrl+K** (Windows/Linux) or **⌘K** (macOS), **T** or **/** to focus search (the sidebar's on a laptop, the bottom bar on a phone). It lists bots by name and job and threads by title.
- **Accessibility.** Visible `:focus-visible` rings on every control, focus returned to the trigger when a sheet closes, a focus trap inside sheets and quick navigation, `role="log"` live regions for conversations, and a `prefers-reduced-motion` path that removes every transition.
- Small-screen layout and reduced-motion preferences are validated in a headless browser.
- Tests: `tests/ui-model.test.js`, `tests/ui-company.test.js`, `tests/ui-profile-model.test.js`, `tests/ui-asks.test.js`, `tests/ui-reorder.test.js` and the other `tests/ui-*.test.js` (Node), `tests/polish_smoke.py` and `tests/usability_smoke.py` (Playwright browser validation).

The Pages version remains **a browser-local, non-AI simulation**: its data and conversations stay in that one browser. On the Node server, conversations are stored with the workspace, so they follow your account to every device you sign in on. Do not enter secrets into the public Pages demo.

## Bot coordination: group chat and handoffs

**Group chats now route tasks between specialist bots.** You can mention `@Writer`, `@Reviewer`, or `@everyone` to select recipients. Without an explicit mention, the group's routing setting decides who answers. Every result is attached to the bot identity, handed to the next bot, and shown in the shared conversation. Human approval is required before any external action.

- **GitHub Pages:** Deterministic, browser-local coordination demonstration. Handoffs produce distinct message records and pass task context. **Approve between steps** pauses the simulation the same way as Node. No real AI is run on Pages.
- **Node API:** Real multi-bot execution. Messages you send in a group chat run on the server orchestrator: each specialist is called with the accumulated context and hands off to the next, and every step is recorded as a run with a full trace. Turn on **Approve between steps** in Group settings to gate each handoff behind your approval. Configure AI under **Settings → Models and keys**, or with `AI_API_KEY` + `AI_BASE_URL` (any OpenAI-compatible endpoint). A run has no step limit by default; a group or **Settings → Permissions → Limits** can set one, and a safety stop at 30 steps always applies. A run that fails three times in a row (pages that never load, or asking for pages it already has) stops and notifies you. Bots from other groups join only when @mentioned and summonable. A bot reaches a browser only with the opt-in `browser.use` permission, and only after you approve the page. Model outputs never receive publication tools.
- **Run timeline & admin.** The **Runs** section of a group's info panel (tap the chat header) shows every run with per-step traces, failures and a Retry action. Admins reach **Team & access** (users/roles/sessions), **Local agents** (pairing/permissions), and **Data & security** (credential vault, retention, checksum-protected JSON backups) from **You**, where notifications are also listed.
- The platform is **not** a cloud-hosted autonomous agent swarm; it runs where you run it and stops for human approval. See [`docs/COORDINATION.md`](docs/COORDINATION.md) for the exact behavior, security boundaries, and API contract.

## Bots that work together, settings you control

Bots behave like Grok bots on X: mention one anywhere and it answers in that chat, with the recent messages as context.

- **Tell the primary bot what you want.** Atlas is the primary bot, and a group set to “One bot keeps it on track” is led by its primary bot. For now a plain message **in that bot's own chat** stays with the primary bot, which can hand parts to teammates; choosing the owning bot automatically arrives with the primary bot's routing step (Phase 2). A message in a **group** chat still runs the group's routing unless you @mention one bot. Group settings can choose **I'll direct them** (no tracked plan) or **Show me the plan first**. You can mark a different bot as primary. An @mention still talks to just that bot.
- **@mention any bot in any chat.** In a one-to-one chat with Writer, `@Reviewer check this` makes Reviewer answer there. Bots from other groups can be called in too, unless their profile turns off "Can be @mentioned from other chats". The composer suggests names as you type `@`.
- **Bots hand work to each other.** When a bot's reply mentions a teammate (`@Reviewer please check`), that teammate takes the next step. The step limit still applies, no bot hands off to itself, and you can turn handoffs off per bot or per group.
- **Bot profile → Behaviour:** switched on or off, reply length, creativity (temperature), tone and style, how many recent messages it remembers, whether other chats can call it, whether it can hand off, and its colour. The model provider and model per bot are set on the same page.
- **Group info → Group settings:** name and description; routing (bots take turns in order, only the first bot answers unless you mention others, or every bot answers); pipeline order and members; step limit (1 to 30); approve between steps; and bot handoffs. You can remove bots from a group, and an admin can delete a group.
- **Quick questions get a quick answer:** a greeting, a thank-you, a short fact or a question about the bot itself is answered by the bot you asked, in one reply; a lead hands work to a teammate only when the work needs that teammate's job, tools or sites.
- **Your bots know the app and set it up for you:** every bot is told the connected models, each bot's model and how it is set, how each team runs, whether this computer is online and signed in to `claude` / `codex`, the connectors, your saved Always allow / Deny rules, what is waiting on you and the open threads (never a key). Ask in chat ("put Replier on Haiku", "rename Replier to Mailer", "keep your replies shorter", "always let Mailer open github.com", "switch Mailer off", "give Replier a new job", "ask me before each step") and the bot answers with a card; **Apply** makes the change through the same route Settings uses. Anything only you can do, such as pasting a key or typing the command for an MCP server, is a button that opens the right Settings page. Nothing changes until you tap, a payment is never Always allow, and no bot can make itself the primary bot. The Pages demo reads the same plain requests without a model and shows the same cards.
- **No pairing step on your own computer:** a server listening on this computer pairs it and runs the local agent itself, so the browser, your `claude` / `codex` sign-in and stdio MCP servers (added in Settings → Connectors → On my computer, with the command that starts them) work after `npm start` (`LOCAL_AGENT=0` turns that off; see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#the-local-agent-starts-with-the-server)). With no model yet, the first message is a card whose **Use this computer's sign-in** adds the Claude (or ChatGPT) sign-in it finds, makes it the default and asks your message again.
- **Browser control for your bots:** a bot asks for a web page in its reply and it opens. A step that sends, posts, deletes or pays shows an ask card with the site and the steps, with **Decline**, **Allow** and **Always allow for this bot**, and that step waits until you answer unless an earlier Always allow already covers that bot, action and site. Allowed requests run in a headless browser — this server's own when it has one (`BROWSER_RUNTIME`, see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)), otherwise your paired local agent (`agent/agent.mjs`, see [`docs/AGENT-PROTOCOL.md`](docs/AGENT-PROTOCOL.md)) — and the bot continues with the result. Your saved rules are listed under **Settings → Permissions**, where you can remove them. A payment is asked every time. Bots may read X but can never click or type there.
- **Take over a page to sign in:** a page behind a sign-in or a 2FA prompt is one the headless browser cannot pass alone, so the card also offers **Take over**. A sheet shows you a picture of the page with its controls numbered; click, type and open other pages from there, then **Hand back to the bot** to continue it from the page you reached. Everything still obeys the allowlist and the egress proxy, X still refuses click and type, and the sign-in is discarded when the takeover ends — so the next page a bot opens is signed out again.
- **One browser for all your bots:** on the device that runs the local agent with `AGENT_BROWSER=1`, every bot shares one Chrome with a saved profile (`browser-profile/` next to the agent config, mode 0700, never uploaded or backed up by the app). Sign in to a site there once, by taking over a bot's browser from the app, and every bot is signed in. Each bot has its own tab and one drives at a time. While you drive, bots wait; hand back and the bot answers with the page as you left it. To wipe it, stop the agent and delete that directory. Setup and limits: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#one-browser-for-all-your-bots-sign-in-once). Open a bot's profile and its **Computer** row to watch the tab live and take over; the Pages demo has no browser and says so.
- **Sub-agents on demand:** tick `subagent.spawn` in a bot's profile (What it may do) and that bot can hand one small job to a helper model. The helper has no tools, no web access and no memory of the chat, cannot spawn another helper, and its answer comes back to the bot, which writes the reply. One helper per reply.
- **Durable memory:** every model keeps a rulebook of lasting instructions and a rolling recap of each conversation, stored in the workspace, so a later turn starts with the context instead of a blank slate. Durable user sentences ("always…", "from now on…") are captured immediately, and one bounded model pass occasionally condenses both. The memory is per model, not per bot, and you can read, correct or forget it in the bot profile or through `/api/memory`. Switch **Memory** off on a bot to leave that bot's turns out of it.
- **Bots that ask each other:** tick `bot.ask` and a bot can put one `ask` block in its reply to get a direct answer from a named teammate. The teammate answers as itself, on its own model and rulebook, and the asker gets one more turn with the answer marked as untrusted text. One round only; the teammate cannot ask anyone else.
- **Bots that add a teammate:** tick `bot.create` and a bot can add one lasting bot to its group with a name and a job. The new bot is a normal roster record with **no permissions** and a custom type; a person reviews it and grants anything it needs. A model can never mint itself extra authority.
- **Scheduled tasks:** a bot's profile → Schedule runs a prompt once or every day, hour or week at a time of day, and lists what is queued with a Stop button. Any bot can propose one from chat ("sum up my inbox every morning at 8") as a card the owner applies with one tap, and stop one the same way. Each run posts into that bot's chat.

Settings are validated by one shared module (`shared/bot-settings.js`), so the server and the Pages demo accept the same values. The exact routing and safety rules are in [`docs/COORDINATION.md`](docs/COORDINATION.md).

## AI: bring your own key (BYOK) and model selection

Bots run on **your own** models. Open **Settings → Models and keys** (admin) and add a provider. A bot's **Model** page (or the model chip in its chat header) is one list of every connected provider's models, with "Another … model…" to type any model id, and an **Effort** choice (Default, Low, Medium, High) for how hard it thinks; the workspace default has the same choice, and you can just tell a bot "make Replier think harder". A provider is a name, an endpoint, an API key and one of five wire protocols, so Claude, Gemini and Azure are first-class instead of "an OpenAI URL":

| protocol | it calls | auth header | when you need it |
|---|---|---|---|
| `openai-chat` | `POST {base}/chat/completions` | `authorization: Bearer <key>` | the default; almost every gateway, router and local server speaks it |
| `openai-responses` | `POST {base}/responses` | `authorization: Bearer <key>` | OpenAI's newer shape; `api.openai.com` is detected as this |
| `anthropic` | `POST {base}/messages` | `x-api-key` plus `anthropic-version: 2023-06-01` | Claude; the system prompt travels as its own field |
| `gemini` | `POST {base}/models/{model}:generateContent` | `x-goog-api-key` | Google AI Studio keys; the body is `systemInstruction`, `contents` and `generationConfig` |
| `azure-openai` | `POST {base}/openai/deployments/{deployment}/chat/completions?api-version=…` | `api-key` | Azure OpenAI; the model id is the deployment name and the API version is required |

A preset fills the endpoint and the protocol. There are 29: OpenAI, Anthropic (Claude), Google Gemini, xAI, Groq, Mistral, DeepSeek, OpenRouter, Together, Fireworks, Perplexity, Cerebras, Cohere, Qwen (DashScope), Moonshot, Zhipu (GLM), DeepInfra, Hyperbolic, Nebius, NVIDIA NIM, GitHub Models, Azure OpenAI, LiteLLM, Ollama, LM Studio, vLLM/llama.cpp, LocalAI, Jan, and a custom endpoint. Azure and a custom endpoint ask you to type the URL; the local servers ignore the key, so any string works.

- **Any OpenAI-compatible endpoint works.** Cohere's compatibility endpoint, GitHub Models, NVIDIA NIM, a Cloudflare-style gateway, LiteLLM, an Open WebUI-style proxy or a local server all speak `openai-chat`: pick **Custom endpoint** and paste its URL. The protocol is auto-detected from the host (`api.anthropic.com` → anthropic, `generativelanguage.googleapis.com` → gemini, `*.openai.azure.com` → Azure, `api.openai.com` → responses, anything else → chat completions), and **Protocol** overrides the guess.
- **Keys and custom header values are stored encrypted** in the workspace vault (AES-256-GCM) and are never shown again; only the provider name, host, model list and the header *names* are visible.
- **Custom headers** are optional: one `Name: value` per line in the provider form, sent with every request, up to eight. Yours are applied last, so a gateway that wants `x-api-key` instead of a bearer token works. Values are write-only: an empty box keeps the saved set and typing replaces the whole set.
- **Azure needs its API version.** The form shows an **API version** field for that protocol, and a blank one means `2024-10-21`. The model id is the deployment name you created. The catalogue is read from `GET {base}/openai/deployments?api-version=…`; if that list comes back empty, type the deployment name into the model field.
- **The model list is read from the provider with the key you saved.** Saving a provider immediately fetches its own catalogue, so the picker lists the models that key can actually use: `GET {base}/models` for the OpenAI shapes, `GET {base}/models?limit=1000` paging on `has_more` for Anthropic, and `GET {base}/models?pageSize=200` paging on `nextPageToken` for Gemini, which hides embedding-only models. An Ollama `/v1` endpoint without `/v1/models` falls back to `GET /api/tags`.
- **The whole catalogue is kept.** Both the chat-capable ids and the full list the key can see are stored with the provider, so the row reads `12 model(s) (+30 listed)`, and a model the filter hides can still be typed by hand. **Refresh models** re-reads the list.
- **A gateway that streams is understood.** Some proxies (self-hosted vLLM, LiteLLM, a router with a streaming default) answer `text/event-stream` even when `stream` was never asked for. The client folds those events back into a reply for every protocol instead of failing the turn, and an error that arrives as a stream still reaches you with the provider's own words.
- **Newer OpenAI reasoning models work unchanged.** `o1`, `o3` and `gpt-5`-style ids reject `max_tokens`, and some reject any custom temperature, with a `400` that names the parameter. The client retries once with `max_completion_tokens`, dropping the temperature only when that is what the error complained about, so a parameter spelling does not cost a turn. An unrelated `400` is still reported as-is.
- **Azure has two endpoint shapes.** The classic resource endpoint (`https://NAME.openai.azure.com`) uses `/openai/deployments/{deployment}` with the deployment in the path; a newer resource's `/openai/v1` base uses `/chat/completions` with the model in the body. Whichever base you paste is honoured, and `api-version` rides in the query either way.
- **A failed catalogue read costs freshness, not the provider.** On a refresh the error is recorded and shown on that row while the last good list stays. A save that changes the endpoint, key, header set or API version starts a new list instead, because the old one no longer describes the provider; the provider is saved either way.
- **Test** sends one tiny request with the stored key and reports the model and the round-trip time, which separates a working key from a plausible one without waiting for a bot to fail.
- **Anthropic, Gemini and Azure need a concrete model id**, so a fresh provider starts on the first model its catalogue reported rather than "auto".
- Choose a **default provider + model** for the workspace, then **override it per bot** in the bot's profile (Edit profile → Model provider / Model). Different bots can run on different models.
- **Edit or rotate a key without deleting the provider**: open it, change its name, endpoint, key, API version or headers, then save. A blank key keeps the stored one, and a changed endpoint, key, version or header set re-reads the catalogue. Routes: `POST /api/ai/providers`, `PATCH /api/ai/providers/:id`, `DELETE /api/ai/providers/:id`, `POST /api/ai/providers/:id/models`, `POST /api/ai/providers/:id/test`, `PATCH /api/ai`, `PATCH /api/ai/bots/:bot`.
- **Model ids and endpoints:** most gateways need `/v1` in the base URL. A pasted full endpoint (`…/chat/completions`, `…/responses`, `…/messages`, `…/models`) is trimmed back to the base for you. A 404 usually means the `/v1` suffix is missing and a 401 usually means the key belongs to another provider; the app appends that hint to the provider's own error.
- Resolution order at run time: **the bot's override → the workspace default → the server environment** (`AI_API_KEY`).

A Claude, Gemini or Azure key in three steps:

1. **Settings → Models and keys → Add a provider**, pick **Anthropic (Claude)**, **Google Gemini** or **Azure OpenAI** — the preset fills the endpoint and protocol, and Azure also asks for your resource URL and API version — then paste the key from that provider's console and **Save provider**.
2. The model list arrives from the provider with that key. Pick the workspace **default model** from it, or type a deployment name for Azure.
3. Leave it as the workspace default, or point individual bots at it in **Edit profile → Model provider / Model**. **Test** confirms the key before anyone runs a bot.

The server still accepts a provider from the environment, which is what runs when no saved provider is chosen:

| var | values |
|---|---|
| `AI_BASE_URL` | the endpoint, e.g. `https://api.groq.com/openai/v1`. Unset, it falls back to `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL` or `AZURE_OPENAI_ENDPOINT`, then to `https://api.openai.com/v1` or the endpoint implied by a key below |
| `AI_API_KEY` | the key. `OPENAI_API_KEY` works in its place, and a saved workspace provider is used when the bot or the workspace default points at one |
| `AI_MODEL` | a model id, or `auto` for a router that chooses (default `gpt-4.1-mini`; `OPENAI_MODEL` is the older name) |
| `AI_API_STYLE` | wire protocol: `chat`, `responses`, `anthropic`, `gemini`, `azure`. Aliases `messages`/`claude` mean anthropic, `google` means gemini, `openai`/`compatible` mean chat; blank infers it from the host (`api.anthropic.com` → anthropic, `generativelanguage.googleapis.com` → gemini, `*.openai.azure.com` → azure, `api.openai.com` → responses, anything else → chat) |
| `AI_TIMEOUT_MS` | request budget in milliseconds (default 180000; values under 1000 are ignored) |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` | work in place of `AI_API_KEY`. With no base URL, either one alone points the app at `https://api.anthropic.com/v1` |
| `GEMINI_API_KEY` / `GOOGLE_GENAI_API_KEY` | same, for Gemini: alone and without a base URL they point the app at `https://generativelanguage.googleapis.com/v1beta` (`GOOGLE_API_KEY` is the older name) |
| `AZURE_OPENAI_API_KEY` / `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_API_VERSION` | Azure: the key, the resource endpoint (`https://NAME.openai.azure.com`) and the API version (default `2024-10-21`). The endpoint has to be set for Azure; a bare Azure key does not pick an endpoint of its own |

`AI_API_KEY` and `OPENAI_API_KEY` keep working, and a saved workspace provider is used when the bot or the workspace default points at it. No SDK is involved: every protocol is plain HTTPS from the server, no key is sent to the browser, and no model gets a publication tool — the final Post click stays yours.

### Use your Claude / ChatGPT subscription

Instead of a key, a bot can run on your own plan. The paired local agent starts the unmodified `claude` or `codex` command that you signed in to in your own terminal; the app never sees, stores or forwards that login. Add a provider of kind `local-cli` (a name, an engine `claude` or `codex` and an optional model, no key; Settings → Models and keys has the form, and shows each machine's sign-in), run the server on that machine (it starts its own local agent; another machine needs `node agent/agent.mjs run`), and pick the provider for a bot. The prompt goes to the CLI on stdin, its own file, shell and web tools are off, and the agent reports whether each CLI is signed in (`GET /api/agents` → `cli`). If no computer is connected the run says so and how to connect one; on a usage limit, a rejected key, an empty quota or a model the plan does not offer it fails with that reason and offers to switch that bot to another connected model. A computer that goes offline mid-run fails the call within a few minutes instead of waiting out the full timeout, and a page sent to a browser on it is failed after 10 minutes so the run carries on. Subscription providers are for the owner's own machine only, and there is no token streaming. Setup, limits and timeouts are in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#use-your-claude--chatgpt-subscription).

### Connectors: Gmail, Drive and MCP servers

Bots reach Gmail, Google Drive and any MCP server through connectors, and reading needs no answer; a send, a draft or any tool that changes something goes through the ask card (a tool with no read-only annotation counts as a write). The card shows the recipient, subject and start of the body, or the tool's arguments. What comes back reaches the bot as untrusted data. Google runs on your own Google Cloud OAuth client (PKCE; the client secret and refresh token are encrypted in the vault, never returned, logged or backed up), and while the consent screen is in Testing Google ends the sign-in after 7 days and the connector shows reconnect. An email send you have Always-allowed is held for 30 seconds with an Undo and logged as having left the app. MCP servers work over HTTP (called from the server) or over stdio (a program named in the paired agent's own config). Settings → Connectors opens on **Connect apps**: a searchable catalogue of known MCP servers (Notion, GitHub, Slack, Linear, Figma, Atlassian, Supabase, Filesystem, Brave Search and more) in categories, where Connect asks only for the token or folder that app needs and adds it as a stdio server on this computer or an HTTP server at the vendor's address. Anything else goes under **Add a custom server**. A connector whose server stops answering during a run (down, a rejected token) shows as a problem there until a call reaches it again. The Google setup form sits on the same page; the routes, the Google Cloud steps and the MCP setup are in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#connectors-gmail-drive-and-mcp-servers).

The static Pages demo has no providers; it stays a browser-local simulation (group handoffs and offline commands, no live model).

## GitHub Pages: chat-first UI

Visit **https://harshit-sehgal.github.io/Agent-Control/** after the Pages workflow completes. The browser-only UI now includes:

- A chat list of named bots and groups, each with its own saved conversation. The Node server stores conversations with the workspace; the Pages demo keeps them in the browser.
- Create bot, create group, and edit lasting bot instructions in the interface.
- Group chat with the deterministic simulator, and the group's info panel (Runs, Group settings, Scheduled tasks).
- A phone layout that shows one pane at a time.

**Demo limitations:** Group chat uses the deterministic simulator (including Approve between steps). Direct chats answer a small command set. Nothing is generated by an AI model. GitHub Pages has no server-side worker, secure key storage, push notifications, or cross-device sync. The browser-local demo requires Web Locks for safe multi-tab run coordination. The demo answers the same coordination routes the server does — `POST/GET /api/groups/:group/chat` and `runs/:run/continue|plan|cancel` — and keeps its runs in the same workspace snapshot, so the UI never branches on which build it is. Never paste private account credentials or API keys into this public demo. The separate Node application runs real bots when deployed locally with a server-side provider key.


## GitHub Pages UI: usability controls

The static Pages dashboard includes functional navigation controls (not real AI execution):

- **Bot profile actions** in the bot's info panel: edit profile, pin to top or unpin, and duplicate. Duplication creates a new profile with its own empty conversation.
- **Group info actions**: add a bot, copy the conversation, or clear the conversation. Group settings hold routing, pipeline order, the step limit and "Approve between steps".
- **Create Bot templates** for Scout, Researcher, Writer, Reviewer, and Coordinator. Templates fill **editable instructions**; they do not connect to an AI provider.
- **Clear chat** from group info. Clearing a conversation asks for confirmation in a sheet. On the Node server it clears the conversation for everyone in the workspace.

Use `npm test` for Node unit tests. Three browser layers sit on top, each optional and each needing Python Playwright plus Chromium:

- `npm run test:ui` drives the generated Pages bundle: layout, navigation, first run, keyboard, phone panes.
- `npm run test:e2e` starts the real server on a free port with a temporary database and a stub OpenAI-compatible endpoint, signs in through the UI, sends a message, and checks that a bot answers, that the provider received the key, the model id and the user's text, that the reply survives a reload, and that a rejected key is reported in the conversation instead of failing silently.

The Pages edition remains a browser-local simulation without authenticated cloud agents or a live model.

## What works now

- Responsive web dashboard with email and password login (desktop/mobile browser). The owner account can omit the email. Change password lives on You.
- A primary bot (Atlas) in a Home group, plus bots and groups you create. Bots have their own profile, behaviour settings, colour and model.
- Group chat with routing, handoffs and group runs, each recorded with a step-by-step trace and a Retry action.
- Bring-your-own-key AI through any provider speaking OpenAI chat completions, OpenAI Responses, Anthropic Messages, Google Gemini or Azure OpenAI. With no provider configured, bots answer with a clearly labelled offline reply.
- Durable memory per model, scheduled tasks, and in-app and push notifications.
- A paired local agent that runs approved browser tasks, and an optional server-side headless browser.
- Accounts, roles, several workspaces, a credential vault, retention settings and checksum-protected JSON backups.
- Event/activity log, local file persistence, HTTP-only session cookie, basic login rate limiting.
- Zero npm runtime dependencies. Requires Node.js 22.5 or newer: before Node
  23.4, `node:sqlite` needs `--experimental-sqlite`. The scripts that load it
  pass the flag (`start`, `dev`, `test`, `test:coverage`, `backup`), and so
  does the Dockerfile.

### Important boundaries

- Bots do not browse on their own. A bot reaches a page only through the opt-in `browser.use` permission, and only after you approve it. Click and type on X stay refused: the final Post click is always human.
- Bots **do not independently fact-check web claims**. Do not treat any generated text as verified reporting.
- The scheduler runs on the host computer. For 24/7 service, run the container or the systemd unit in `deploy/` on a machine that stays on (see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)).
- An installation can hold several workspaces, each with its own data and members, but it is self-hosted software for people you trust, not a hardened multi-tenant SaaS.
- Bots have no file-system access. Browser access is the same opt-in `browser.use` permission as any other bot, and it still needs your approval and a paired local agent.
- Push notifications reach a phone or desktop only after you turn them on for that device under **Settings → Notifications**, and only when the server is served over HTTPS (or on `localhost`). On an iPhone or iPad the app must first be added to the Home Screen. The service worker caches the app shell, so the installed app opens when the network is down, and tapping a notification opens the screen that message is about.
- Email notifications are **outbound only**: set `SMTP_HOST` (STARTTLS on 587, or `SMTP_SECURE=1` for TLS on 465) and the app submits the mail itself, or point `EMAIL_RELAY_URL` at an HTTPS gateway. There is no inbox read and no IMAP. With neither configured, sending fails loudly rather than pretending it went out.
- No external accounts, secrets, or private files are transmitted unless you explicitly configure an AI provider, and then only the text a bot is working on.

## Quick start (Linux/macOS/Windows with Node 22.5+)

```bash
# Unzip the download, then open its project folder.
cd agent-control-prototype
npm test
npm start
```

`npm start`, `dev`, `test`, `test:coverage` and `backup` pass `--experimental-sqlite` for you, and so does the Dockerfile. If you run `node src/server.js` yourself, pass the flag too.

Open **http://127.0.0.1:4173**. On first startup without environment variables, the terminal prints a randomly generated dashboard password. Later restarts may print a different random string that does not update the stored owner password — set `DASHBOARD_PASSWORD` or change password under **You**. For a stable password:

```bash
# Linux/macOS
DASHBOARD_PASSWORD='use-a-long-random-password' npm start
```

Windows PowerShell:

```powershell
$env:DASHBOARD_PASSWORD = 'use-a-long-random-password'
npm start
```

Optional AI through any OpenAI-compatible provider (or add a provider in the app under **Settings → Models and keys**):

```bash
# Option A — a `.env` file next to package.json (git-ignored, loaded at startup):
#   AI_BASE_URL=http://127.0.0.1:3001/v1   # FreeLLMAPI router, or any compatible endpoint
#   AI_API_KEY=freellmapi-...              # your provider key
#   AI_MODEL=auto                          # "auto" lets a router choose, or a concrete model id
DASHBOARD_PASSWORD='use-a-long-random-password' npm start

# Option B — inline environment variables (override .env):
AI_BASE_URL='https://api.openai.com/v1' AI_API_KEY='YOUR_OWN_KEY' AI_MODEL='gpt-4.1-mini' DASHBOARD_PASSWORD='use-a-long-random-password' npm start
```

`AI_API_STYLE` picks the wire format (`chat` for `/v1/chat/completions`, `responses` for OpenAI's `/v1/responses`, `anthropic` for Claude's `/v1/messages`, `gemini` for Google's `generateContent`, `azure` for an Azure deployment; aliases and the host-based default are in the BYOK section above). `AI_TIMEOUT_MS` (default 180000) budgets slow free-tier routing. The startup banner reports the environment provider when `AI_API_KEY` is set. Saved providers under **Settings → Models and keys** are used at run time even when the banner says none.

Secrets are read **only on the server**. Never place an AI provider key in a Git repository. When a key is configured, bot replies may incur API charges. If the provider request fails, the backend reports an error; it does not pretend to have generated a successful AI answer.

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

The suite checks scheduling boundaries, state persistence, recovery across reloads, group runs and handoffs, the AI protocol adapters, and a live HTTP end-to-end lifecycle including auth and cross-origin protection.

`npm run check` syntax-checks every `.js`/`.mjs` file under `src/`, `shared/`, `agent/` and `scripts/`; `npm test` runs the Node suite.

## Repository creation

To create a private repo after downloading/unzipping the project:

```bash
cd agent-control-prototype
git init -b main
git add .
git commit -m "feat: initial working personal bot platform"
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
                                                     +-- AI provider (optional)
Local agent (paired device) ---- agent token -------> /api/agent/*

Note: Bots never click or type on x.com; the final Post click is always human.
```

### Key paths

- `src/server.js`: opens the store and the real services, then listens. It wires them into `src/app.js` and does nothing else.
- `src/app.js`: the request dispatcher without a listener — the route table, the anonymous-then-role check, the static file server and the per-workspace background services. Importing it opens no port, so the dispatcher every route passes through is exercised in-process (`tests/app-seam.test.js`).
- `src/router.js`: the route table. Every route is registered with the access it needs (`public`, `agent`, or a least role), so a permission cannot be forgotten.
- `src/routes-*.js`: the routes themselves, grouped by area: `public` (sign-in, password reset, local-agent protocol), `workflow` (workspace snapshot, tasks, retention), `groups` (groups, bots, runs, conversations), `account` (users, sessions, agents, vault, backups), `workspaces`, `push`, and `ai` (BYOK providers).
- `src/workspaces.js`: one database file per workspace. A request works on its session's workspace and no other.
- `src/push.js`: Web Push (message encryption and VAPID signing) with `node:crypto`, no library.
- `agent/browser.mjs`: the headless browser engine, without a browser-automation library: allowlisted reads plus `browser.action` click/type/read/scroll against an installed Chrome over the DevTools protocol, and a numbered list of the controls on each page. Click and type on X are refused. One process can serve a whole burst of requests, each in a fresh, empty context; the same engine opens a page a person takes over, in a context the runtime keeps until they hand it back.
- `src/browser-runtime.js`: who opens the page for a `browser.use` request — this server's own browser (one child process, serial, closed when idle) or a paired local agent (`BROWSER_RUNTIME`). It also owns live takeovers: one at a time, ended on handback, on close, or on their own idle and hard clocks.
- `shared/ui-*.js`: the chats UI. Pure view models (`ui-model`, `ui-company`, `ui-feed`, `ui-profile-model`, `ui-asks`, `ui-reorder`) are tested in Node; the DOM modules are `ui-shell` (sidebar, phone chrome and home, search), `ui-conversation` (a bot chat or a thread), `ui-face` (the faces), `ui-profile` (profile, Edit, New bot, the options menu), `ui-settings` (Settings, Company, Activity), `ui-gestures` (drag, long press, right-click, Alt+arrows), `ui-store`, `ui-chat`, `ui-dialogs`, `ui-fx` and `ui-actions`. Styles are `app.css`, `shell.css` and `profile.css`.
- `agent/shared-browser.mjs`: the one browser on the device. One Chrome on one persistent profile, a tab per bot, a first-come queue so one bot drives at a time, the owner's takeover and hand back, the screencast of the watched tab and the owner's input. `agent/live-channel.mjs` is its line to the server and `agent/live-input.mjs` the one normaliser for owner input.
- `src/browser-live.js` and `src/routes-live.js`: the live view between the device and the owner's page, in memory only (a frame, a page address and queued input are never stored), plus the Computer list derived from the run records.
- `shared/ui-takeover.js`: the takeover sheet — a picture of the page, its numbered controls, and the click/type/navigate actions that drive it.
- `src/http.js`: JSON responses with the security headers, bounded body readers and the same-origin check.
- `src/sqlite-store.js`: the store. Each record is kept whole next to its typed columns, so a restart reads back exactly what was written. A database written by a newer build is refused at boot instead of being opened.
- `shared/assets.js`: the one list of files that make up the UI. Both `scripts/build-pages.js` and `src/app.js` import it, so a module imported by `index.html` cannot ship to one and be missing from the other.
- `shared/chats.js`: conversation history rules, shared by the server and the browser-local transport.
- `src/bot-turn.js`: the one sequence a bot step runs — sub-agent round, peer ask, new-bot block — shared by the group loop and a 1:1 chat so the two cannot drift apart.
- `shared/reply-blocks.js`: the one fence grammar every control block (`ask`, `spawn`, `create-bot`, `browser`) is parsed and stripped with, so no two parsers disagree about what a block is.
- `shared/run-state.js`: the one vocabulary for a run's life — which statuses are busy, interruptible or stoppable — shared by the orchestrator, the Pages demo and the UI.
- `shared/core.js`: validation and the helpers shared by the server and the browser.
- `src/ai.js`: optional provider adapter and clearly labeled offline fallback.
- `src/scheduler.js`: due-task reconciliation and scheduled bot tasks.
- `shared/`: the dashboard UI, its browser-safe logic, and the local transport. The Node server serves this folder directly.
- `scripts/build-pages.js`: copies the files in `shared/assets.js` into `docs/` and marks the page browser-local, for the static GitHub Pages build (`npm run build:pages`).
- `tests/`: unit tests, the HTTP integration test, and optional Playwright smoke tests.
- `docs/ROADMAP.md`: phased path to the production architecture.

### One UI, two transports

The dashboard in `shared/` is the only UI. At runtime `shared/transport.js` picks a backend:

- Under the Node server it calls same-origin `/api/*` and shows a password sign-in.
- On the static Pages build it calls the browser-local `localStorage` implementation in `shared/local-api.js`.

Both paths run the same shared rules, so the demo and the real dashboard cannot drift. **Both also answer the same coordination routes** (`POST/GET /api/groups/:group/chat`, `POST /api/groups/:group/runs/:run/continue|plan|cancel`), and both keep a run in the workspace snapshot the way `src/coordination.js` does; the demo's offline engine lives in `shared/local-api.js`, so `shared/ui-chat.js` and `shared/ui-actions.js` no longer branch on the build to drive a run. Edit `shared/`, then run `npm run build:pages` to regenerate `docs/`.

## Security and operational notes

- Set a strong, stable `DASHBOARD_PASSWORD` before exposing the server beyond localhost.
- State lives in a transactional SQLite database, and there is no other store. `DATA_FILE` is the JSON sibling path (default `data/state.json`); the SQLite file is the same name with `.db` (`data/state.db`), or `DATA_DB` when set. A `state.json` written by 0.6 is imported once, then left beside the database. A database written by a newer build is refused at boot with both schema versions in the message, instead of being opened. Sessions are server-side and revocable, so a restart no longer signs users out.
- Secrets (paired-agent secrets, stored credentials) are AES-256-GCM encrypted; the master key is `MASTER_KEY` or a `0600` keyfile beside the database. **Back the key up with the data.**
- Roles are `viewer < member < admin < owner`; every route is registered with the least role it needs (`src/router.js`, `tests/authz-matrix.test.js`).
- Sign-in is rate-limited to 8 attempts / 15 minutes per client address and per account+address, and to 32 per account across addresses: the account bucket is deliberately looser so guesses spread over many addresses are still cut off without one client locking the mailbox. Forgot-password allows 8 per account. The attempt is counted before the request body is read. Behind `TRUST_PROXY=1` the client address is the rightmost `X-Forwarded-For` hop; the leftmost is whatever the caller sent. Reset itself consumes a one-time token. An unknown address and a wrong password get the same answer. Forgot password prints a one-time token in the server log unless `RESET_TOKEN_CONSOLE=0`.
- The session cookie is `HttpOnly` + `SameSite=Strict`; the database holds only a hash of each session id. Cross-origin writes are rejected.
- **Backup and restore are for the owner only.** A backup of the primary workspace carries every account's password hash; other workspaces export only their own rows. Restore replaces data in the current workspace database (credentials, sessions and paired-agent credentials are excluded). Restored agent records are revoked and queued or running agent tasks fail; pair devices again after restore. The file is checksum-protected JSON, not encrypted — protect it like the database. A restore rejects unknown roles and any link that is not http(s).
- The local agent refuses `http.check` targets on private or local networks and does not follow redirects. Set `AGENT_ALLOW_PRIVATE=1` on the device to allow private addresses on purpose.
- At most `AI_MAX_CONCURRENCY` model calls (default 4) run at once.
- Model output in a chat carries an **AI** mark that only the server can set, on runs it executed itself. A browser can add built-in command replies to a conversation, but it cannot mark them as model output or give them a sender the conversation does not have.
- Each workspace keeps its data in its own database file (`state.ws-<id>.db` beside `state.db`). Accounts and memberships live in the first one. Only an owner of the first workspace can create workspaces; people are invited to one workspace at a time.
- Push subscriptions belong to the account that made them. The installation's push key pair is generated on first use and stored encrypted with the vault key. A push endpoint must be a public https address.
- Webhook notifications are not delivered to private or local addresses, and redirects are not followed. Set `WEBHOOK_ALLOW_PRIVATE=1` to allow a relay on your own network.
- Page text a bot reads and anything it is handed from outside is **untrusted external content**; input is escaped and URL schemes validated. Model output never receives publishing tools; a bot opens pages only through your own paired local agent, when you grant it `browser.use`, and a bot it spawns through `subagent.spawn` has no tools at all; and **the final Post click is always human**.
- Run behind an HTTPS reverse proxy, or set `TLS_CERT` and `TLS_KEY` together for in-process HTTPS; enable `HSTS=1` only after TLS works. See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).
- Full threat model: [`SECURITY.md`](SECURITY.md). Agent protocol: [`docs/AGENT-PROTOCOL.md`](docs/AGENT-PROTOCOL.md).

## License

No open-source license has been selected. The default is all rights reserved until the repository owner chooses a license.
