# Primary bot platform: design

Date: 2026-11-11. Status: draft for owner review.

## Intent

Agent Control turns from an "X-engage drafting demo with extras" into a general personal bot platform. The owner signs in and finds one bot, the **primary bot**. Everything else grows from there: the owner (or any bot) creates bots, each with one job; bots talk to each other and hand work along but never do another bot's job; they share one browser the owner can take over; they run on the owner's own Claude and ChatGPT subscriptions as well as API keys; they reach Gmail, Drive and other services through connectors.

The owner's reference point is Grok's agent experience: lots of automated work, high flexibility, one bot can spawn many, bots organised into groups, work goes to whichever bot matches it.

Why now: the owner will only deploy and use the app daily once this structure exists. Success is the owner running real work through it every day.

## Goals

1. First sign-in shows exactly one bot: the primary bot. No preset bots, no preset groups.
2. Any bot can create any number of bots, from a one-sentence description of what the new bot is for.
3. Every bot has a clear job. Bots communicate and hand off, but a bot never does work that belongs to another bot.
4. A bot never answers "I can't do that" for lack of permission. It asks the owner, with three answers: **Decline**, **Allow**, **Always allow for this bot**.
5. One shared browser for all bots, with one set of sign-ins. If the owner signs in to Gmail there, every bot can use that session. The owner can take the browser over at any time and hand it back.
6. Bots can run on the owner's Claude subscription and ChatGPT subscription, not only on API keys.
7. Connectors for Gmail, Drive and more.
8. Few options on screen. Per-bot permission toggles and most per-bot/per-group settings go away.

## Non-goals

- Multi-tenant or hosted use by other people with their subscriptions. Subscription-backed bots are owner-only (see Constraints).
- An X-specific workflow. X-engage is deleted, not kept as a template.
- Publishing to the public web from the app without the owner being asked.

## Anti-goals (a failure even if it works)

- A screen full of switches and settings the owner has to understand before anything works.
- A bot replying "I don't have permission" instead of asking.
- Two bots doing the same job, or a bot drifting into another bot's job.
- The app storing or proxying the owner's claude.ai or ChatGPT login tokens.
- A runaway loop of bots creating bots that burns through subscription limits overnight.

## Constraints

- **Repo rules still hold** (`AGENTS.md`): zero npm runtime dependencies, browser-safe `shared/`, asset registry, docs drift, CSP parity, module graph. All new work keeps `npm run check`, `npm test`, `npm run build:pages` green.
- **Subscription terms** (checked 2026-11-11 against code.claude.com and learn.chatgpt.com docs):
  - Anthropic forbids third-party apps from offering claude.ai login, routing requests through Pro/Max plan credentials on behalf of users, or collecting/storing claude.ai tokens. It does not stop an end user from signing in to the unmodified Claude Code binary with their own subscription, and its usage limits "assume ordinary, individual usage of Claude Code and the Agent SDK".
  - OpenAI's Codex CLI supports "Sign in with ChatGPT"; docs recommend API keys for automation and say not to expose Codex execution in untrusted environments. OpenAI's "Sign in with ChatGPT" programme is the sanctioned route for third-party apps; not needed for owner-only use.
  - Google forbids using Gemini CLI OAuth in third-party tools. Gemini stays API-key only.
  - Consequence: subscription-backed bots run **only on the owner's machine, through the unmodified `claude` and `codex` CLIs, signed in by the owner in their own terminal**. The app never sees, stores or forwards those logins. Headless `claude -p` must not use `--bare` (bare mode ignores the subscription login; it may become the `-p` default later, so pass the opt-out explicitly once one exists).
- **Prompt injection**: every page and email a bot reads can carry hidden instructions. With a signed-in shared browser and Gmail connector, an injected instruction could reach the owner's accounts. The ask mechanism is the defence.

## Decided with the owner

- **One primary bot at first sign-in.** The owner can rename it and change its personality and model later.
- **Bots are created** by the owner directly or by asking any bot ("make me a bot that watches my inbox and flags client mail"). From that sentence the creating bot writes the new bot's name, job and instructions. The owner can edit them.
- **No limit** on how many bots any bot can create.
- **Basic kit, every bot, no asking:** chat with the owner; message and hand work to any bot; create bots; add bots to groups; its own memory of its job and past work; schedule its own recurring tasks; ask the owner for anything it lacks.
- **Asks first, every bot:** using the shared browser; using a connector; anything that sends, posts, deletes or spends.
- **Ask card:** Decline / Allow / Always allow for this bot. This replaces per-bot permission toggles, the `browserApproval` select, and "Grant browser access".
- **Primary-bot-only powers:**
  - sees every bot's work and runs; can pause, stop, edit or delete any bot;
  - settles ownership: when two bots' jobs overlap, or a task matches no bot, the primary decides who takes it (or creates a bot for it);
  - holds setup: connecting subscriptions and connectors, the default model for new bots;
  - answers "who is allowed what" and can revoke an Always allow;
  - cannot be deleted.
- **Runaway guard:** no cap on bot count, but if bot creation forms a loop or exceeds about 20 bots in a few minutes, all bot activity pauses and the primary asks the owner to continue.
- **X-engage and its five example bots are removed entirely.**

## Bots and threads are two different things (owner, 2026-11-11, mock v39)

This section wins over anything below about threads, routing or help between bots.

- **Bots: one continuous chat per bot**, like Grok's bots. The owner talks to any bot directly in its own chat, and that chat never splits into threads.
  - A plain bot answers itself.
  - A lead (a manager, or Atlas) can also be asked to get something done. It hands each part to the bot on its team whose job it is, those bots reply to the lead inside the same chat, and the lead gives the owner the result there.
  - Atlas's team is every bot; a manager's team is everything below it in the chart.
  - If no one on the team does the work, the lead offers to hire a bot for it. A manager hires under itself, or points the owner to Atlas.
- **Threads: a new chat every time, always run by Atlas.** Starting a thread never opens or reuses a bot's chat. Atlas is the orchestrator:
  - it decides which bots do which parts and hands each part out in the thread;
  - each bot replies to Atlas in the thread;
  - Atlas reports the final output to the owner.
  - Follow-up messages in a thread go to Atlas again. The owner does not pick bots in a thread (no @ there); Atlas does.
- **What the chat shows** (mock v41). While work is under way, the handoffs do not stack up. One small centred pill, in the same style as the other system pills, keeps updating in place. It shows the active bot's face and one line of text: "Atlas is working out who does what", "Asking Mailroom: …", "Mailroom is on it", "Planner needs your OK", "Atlas is putting it together". When the work ends, it becomes a quiet centred pill, "Planner and Mailroom helped · 4 messages ›", with no stacked faces. Tapping it opens a roomy card that lists each handoff ("Atlas to Planner" and the message) with space between them. The lead's reply follows. Permission asks appear as their own card.
- **Chat header** (mock v41): a round back button with no label, then the title and a status line using the full width. A bot chat also shows that bot's small face, which opens its profile. A thread shows no face, since Atlas runs every thread.
- **Faces and motion** (mock v44). Every bot face is turned about 30° to the right and tilted up about 30° toward the sky. The eyes sit in the top fifth of the face, the mouth just below the middle, and the blush between them, all right of centre. The eye highlights sit high, catching light from above. The far eye (on the right) is narrower. A soft shade sits on the far side and under the chin, and light falls from the top left. Atlas's star badge sits at the bottom left so it never covers the mouth. Changing pages fades the new view up in 240 ms. Buttons press in slightly when tapped. Both respect reduced motion. Draggable rows get no transform transition, so dragging stays immediate.
- **Lists stay separate.** The Threads section lists only threads, never bot chats. Bot rows preview only their own chat. Back from a bot chat goes to Bots; back from a thread goes to Threads. The thread header says "Atlas runs this thread". A bot chat's header says "One continuous chat", "Hands work to its team" or "Hands work to any bot".
- **Cost.** Routing is still one planning call by the lead (from names and jobs), not a broadcast. Bots outside the plan never see the message.

## Company model and threads (owner revision, 2026-11-11)

This revision replaces groups. Where it conflicts with anything below, this section wins.

- **Org chart, like a company.** Every bot has at most one manager (`reportsTo`, a bot id or none). A manager is an ordinary bot that has reports. The primary bot sits at the top. Managers can report to the primary or to other managers, to any depth. A bot may have no manager at all. It must stay a tree: one manager per bot, no cycles.
- **Routing is one cheap step, never a broadcast.** Bots do not each read the message and decide whether to react: that would cost one model call per bot per message. One routing call, made by the primary from every bot's name and job (memory excluded), picks the owner. When the match is clear it goes straight to the owning bot; managers are consulted only when the primary can't tell which of their reports owns it. Quiet bots never see the message. Owner's framing: the primary stays awake and every other bot sleeps until work is routed to it; the chart and chat list show sleeping, working and waiting-on-you states.
- **Threads and help between bots** now follow "Bots and threads are two different things" above.
- **No bot owns it:** the primary says so and offers to handle it once or create a bot for it, under whichever manager fits.
- **Managers' powers** within their own team (everything below them in the chart): create, edit, pause and reassign bots, and settle who owns a task. The primary has these powers over the whole company, plus everything listed under primary-only powers.
- **Context is automatic.** There is no per-bot context setting. Each turn the app assembles the bot's job, its memory, the thread so far and teammates' replies. The bot can ask for more (older thread messages, more memory) through a tool. When a thread nears the model's limit, older parts are summarised. `contextMessages` and similar settings are removed.
- **Memory per bot.** Each bot has its own private memory: what it learned about the owner and its job. The owner can see, edit and delete every line from the bot's profile. There is also one shared company notebook every bot can read. Build on the existing durable memory (`shared/memory.js`, Phase T); do not add a second memory system.
- **The top bar carries only the thread** (its title). No app-wide buttons live there. App-wide places sit in the sidebar, like Slack:
  - top: a status line that doubles as the pause control ("● Atlas on watch · others asleep", "Pause all" on hover; violet "All bots paused · Resume" when paused);
  - then *New thread*, then two rows with small icons: *Activity* and *Company* (the chart);
  - then Needs you, Threads, Direct;
  - bottom: the owner's own row with a gear for Settings.
  - On phones the same sidebar opens from the ☰ button.
- **Settings are not the company chart.** **Settings** holds only app-wide things: subscriptions (Claude, ChatGPT, with signed-in status), API keys, the default model for new bots, and connectors (Google, MCP servers).
- **Per-bot settings live on the bot.** A bot's profile holds its job, manager, model, memory and permissions. Nothing per-bot appears in Settings.
- **Per-bot permission choices.** Every permission a bot has been given is listed on that bot's profile, with a choice of **Always allow / Ask each time / Deny**. Payment permissions offer only Ask each time / Deny. Deny means the bot stops and tells the owner where to change it. This is how the owner takes back an Always allow.

## Interaction model (mock v12, the UX reference)

Layout (owner's design, 2026-11-11):
- **Home has four layouts, one at a time** (owner, 2026-11-11, mock v22): Desks, List, Chats and Orbit. The home page shows only the chosen one, with no switch on the page. **List is the default for everyone** (owner, 2026-11-11, mock v23); each person picks theirs under Settings → Appearance → Home view, and it is remembered.
- **Pin and move** (owner, 2026-11-11), in Desks, Chats and List:
  - **Pinned row** (owner, 2026-11-11, mock v21, after Grok's home): pinned bots sit in a centred row of large faces with names at the top of Desks, List and Chats. Atlas starts pinned for everyone and carries an orange star badge marking it as the primary; it can be unpinned like any bot; the star also shows on Atlas's face elsewhere at medium size and up. Pin from the menu or drag a bot up into the row (it outlines in mint); drag a pinned face down out of the row to unpin it, or sideways to reorder. In Chats, pinned bots leave the list. Desks themselves can still be pinned to the top.
  - **Gestures** (owner, 2026-11-11, mock v20). There are no pin or drag buttons; the whole bot is the handle. A small violet pin marks pinned items.
    - Phone: touch and hold a bot anywhere. It lifts with a short buzz. Move your finger to drag it; let go without moving to open its options sheet from the bottom.
    - Laptop: press on a bot and move to drag it; double-click-and-hold (the touchpad's tap-and-drag) and a long press also work. A single click still opens the chat. Right-click opens the options menu.
    - Keyboard: the menu key or Shift+F10 opens the menu, Alt+arrows move the focused item, Esc closes.
  - **Options menu**: Message, Profile, Pin/Unpin, Move to… (each manager, or Solo), Hide and Delete…. Atlas cannot be hidden or deleted. Delete asks first and says what goes (job, memory, permissions), that it can't be undone, and where its reports go (Solo); its threads stay. Hidden bots come back from a "Show N hidden" link under the home view.
  - **Move to another team by drag**: in Desks, drop a bot on another desk; in List, drop it on a manager's row (the team opens). The target is outlined in mint, and the bot's manager changes on drop. Managers with no reports still accept drops.
  - Pinned items stay on top. Dropping an item among the pinned ones pins it, and dragging a pinned one below them unpins it.
  - **Drag motion** (owner asked for smooth, 2026-11-11):
    - The item lifts with a deep shadow, grows 3% and rides under the pointer from the exact spot it was grabbed.
    - It tilts a few degrees with sideways speed, eased so it sways, not snaps.
    - Neighbours glide out of the way. Interrupted glides continue from where they are, so nothing jumps.
    - An item only swaps once the pointer crosses the middle of its neighbour.
    - On release it springs into its slot with a slight overshoot.
    - The page scrolls on its own near the top and bottom edges.
    - Arrow-key moves glide the same way.
  - Desks: whole desks move. Bots with no manager sit together at one **Solo** desk ("Report to Atlas directly"), so every desk has the same shape: a header, a dashed rule and seats. Desks pack like a masonry wall: a short desk lets the next one move up into the gap (owner, 2026-11-11), and seat descriptions stop at two lines. Seats also move within and between desks. Chats: Atlas is pinned by default, and moving is off while a team filter is on. List: pinned bots appear in a Pinned group above the tree, and rows move within their own team.
  - The order, the pins and the default view are saved per person.
  - **List:** the dropdown tree. Atlas is at the top, managers fall open under it and teams under them, with the fall-and-rise animation. Only "working" or "waiting on you" shows as a word.
  - **Chats:** WhatsApp-style rows sorted by latest activity, with Atlas pinned. Each row shows the face, name, last message and time. A working bot shows "working…" with moving dots; a waiting bot shows its ask in violet and a badge. Filter chips are All and one per manager's team.
  - **Orbit:** Atlas sits in the centre, managers on an inner ring, their bots on an outer ring, joined by faint dashed lines. A line turns mint and flows while that bot works. Faces float gently and pop in on load.
  - **Desks:** Atlas at the head, then one tinted table per manager with their bots seated as large faces with names. Bots with no manager get their own small table.
  - Lately (the five latest threads) sits under List, Orbit and Desks; Chats already is that.
- **New bot** (owner, 2026-11-11): the form asks only for a name, an optional manager and a colour (eight tints, the first unused one picked), with a live preview of the face. "Create and open chat" opens the bot's own chat, where it asks what it should do. Your first message there becomes its job (saved to its memory); you change the job the same way later.
- **Grok-style chrome** (owner, 2026-11-11, mock v24): top left is a round profile picture (the Google photo; initials such as "HS" when there is none) that opens settings, with no text label and a badge when something needs you. Top right is + New bot. At the bottom a wide Search pill sits beside a round New thread button. Focusing Search lists your threads (Waiting on you, Today, Earlier); typing searches bot names and jobs and thread titles. T or / focuses it. There is no separate Threads button; chat headers keep a threads icon.
- **Chat screens stay clean** (owner, 2026-11-11): in a thread and on the new-thread page the profile picture, the bottom bar and New bot are hidden; the header's Back and threads icon cover navigation.
- **Desktop layout** (owner, 2026-11-11, mock v26, after Grok's desktop app): at 1024px and wider the bots live in a left sidebar and the chosen chat opens on the right. The sidebar has search and + New bot at the top, the pinned bots as large faces (Atlas with its star), then every other bot as a chat row (face, name, last message or what it is doing, a badge when it waits on you), and at the bottom your profile picture and name (opens the menu) beside New thread. The desktop app opens on the primary bot's (Atlas's) chat (owner, 2026-11-11). With no chat open, the right side says "Select a chat" with a link to start a new thread (owner, 2026-11-11); the home views are the phone's. Pinned bots in the sidebar show as large faces (72px), like the pinned row on the phone. The floating profile picture, + and bottom search bar are phone-only. The phone layout is still to be detailed by the owner.
- **Sidebar gestures** (owner, 2026-11-11, mock v30): the same gestures as the phone work in the desktop sidebar. Right-click a bot for its menu. Press and drag (or double-click and hold) to move it: drop it in the pinned area to pin it (no space is reserved for pins: with nothing pinned, a "Drop to pin" area appears only while a bot is being dragged; pinning from the menu just adds the face at the top), drag a pinned face out to unpin it, drop it on the middle of a manager's row to move it to that team (the row outlines in mint), or drop it near a row's edge to reorder. Making a bot report to Atlas directly is in its menu (Move to… → Solo).
- **The sidebar keeps its order** (owner, 2026-11-11): opening or messaging a bot does not move it to the top; bots stay where they are until you drag them.
- **No "Jump to"** (owner, 2026-11-11): Search covers it. ⌘K / Ctrl+K focuses Search (the sidebar search on desktop, the bottom bar on a phone).
- **One Settings page** (owner, 2026-11-11, mock v25, after Grok's settings): the drawer has a single Settings entry instead of separate Models, Connectors and Appearance links. On a laptop it opens a large dialog with sections on the left (General, Appearance, Models and keys, Connectors, Permissions, Usage, Computer) and that section's settings on the right, grouped into cards of rows. On a phone it is a full page: the section list first, tap one to open it, Back returns to the list. General holds the account (profile picture, name, Add account, Sign out), the Bots running switch and the primary bot. Permissions lists every grant across bots, editable in place; payments never offer Always allow. Computer says where bots run (this laptop now, the Oracle VM later) and the shared browser. Esc, the close button or a click outside closes it.
- **Phone settings and home** (owner, 2026-11-11, mock v32, after Grok's phone settings): the phone Settings page opens on grouped cards with large rows and a round close button top left, with no title. The first card has the account (initials, name, "Signed in with Google"), Usage with this week's percentage, and Models and keys. Next comes a Connect apps card. A "Bots" group holds the Bots running switch (it works in place), Permissions with its rule count, and Computer. An "App" group holds Appearance. Each row with a chevron opens its section, and Back returns to the cards. On the phone home there is no date line, no "Your bots" title and no gesture hint: the avatar and + sit above the pinned row. While Atlas is pinned, the list starts with Atlas's reports instead of showing Atlas twice. Tree rows drop the Profile link, which is in the options menu. The new-thread lineup is one row that scrolls sideways.
- **Back from a bot's profile** (owner, 2026-11-11, mock v33): the back arrow on a bot's profile never goes to the Company page. Opened from a thread, it returns to that thread; opened anywhere else, it opens the chat with that bot. Chat and new-thread headers have no threads button: threads are found only through the search bar.
- **Bot profile** (owner, 2026-11-11, mock v34, after a reference template): the profile has a round back button (to the bot's chat) and a round ⋯ button that opens the bot's options menu (Message, Pin, Move to, Hide, Delete). Below them, centred, are the bot's big face, its name, its role and team, its job in one or two lines, and an Edit pill. Edit changes the name, manager and colour; the job is still changed by telling the bot in its chat. One card of rows with icons opens a page each: Memory (note count), Activity (count), Permissions (rule count; payments never get Always allow), Model (model and automatic context) and, for managers, Team. A second card holds a Notifications switch, with a caption saying it tells you when the bot finishes or is waiting for you. Sub-pages have a round back button to the profile. Deleting the bot from ⋯ closes the profile, and closes its chat if that chat is open. The old tab bar and the Message button are gone.
- **Profile picture opens Settings** (owner, 2026-11-11, mock v35): tapping the profile picture (HS) opens the Settings page directly, on phone and in the desktop sidebar footer. There is no side drawer any more. Activity and Company moved into Settings: a "Go to" card on the phone, and two links under the sections on desktop. The profile picture carries no badge; the waiting count stays on the new-thread button. The bottom bar is pinned 16px from each edge, so it cannot run off narrow phones. A fade sits behind it, so list rows no longer show through. The top buttons and the bar are flat, with no shadow halo.
- **New bot page** (owner, 2026-11-11, mock v36, after a reference template): + opens a full page (the right panel on desktop) with a round close button and the title "New bot". At the top is a large live preview of the face. Below it are a big "Name your bot" field, a grid of ten face shapes (rounded square, circle, hexagon, pebble, drop, shield, arch, egg, blob, bean; only the hexagon has corners) drawn in the chosen colour, two rows of five pastel colours, and an optional Manager picker. A note says the job is set in the chat. A full-width Create button at the bottom stays disabled until the bot has a name; it creates the bot and opens its chat. A bot keeps the shape it was given (`shape` on the bot). Bots without one keep the role default: circle for Atlas, hexagon for managers, rounded square for the rest. Shape can be changed later from the profile's Edit page. Sizes stay modest (mock v37): an 84px preview with a calm, blinking face rather than a grin, 32px shape choices in a 5-column grid, 26px colour dots, a 48px Create button, and an 84px face on the profile.
- **Bots and Threads sections on phone** (owner, 2026-11-11, mock v38, like the Chat/Code switch in the Claude app): the phone home has two sections, Bots and Threads. Swipe left on Bots to reach Threads, and swipe right on Threads to go back. The page slides a short way as it changes, or switches instantly with reduced motion. Top centre, between the profile picture and +, sits a small indicator with both names and a pill under the current one. It is an indicator, not a button: only a swipe switches. Swipes that start on the pinned row, the filter chips or the bottom bar are ignored, so those can still scroll sideways. Threads lists every thread grouped as Waiting on you, Today and Earlier. Opening a thread from either section and pressing back returns to that section; the back label names it. With its own Threads section, the phone Bots page drops the Lately list. Desktop keeps the sidebar and has no sections.
- **Settings opens a drawer from the left:**
  - the owner and how many bots they have
  - a power switch, "Bots are running", which is Pause all; switched off it reads "Everything is paused"
  - Needs you, only when something waits
  - Go to: Activity, Company, Jump to ⌘K
  - Settings: Models and keys, Connectors, Appearance
  - **This week, at the bottom** (owner, 2026-11-11): the share of the subscription limit in large type, then one bar split by bot in each bot's tint, so the bar shows who used it, with a legend of faces and percentages and the key spend cap below
  - a footer line saying where the server runs (the laptop now, the Oracle VM later)
  - Threads moved out of the drawer: they are on the home screen under Lately and in ⌘K.
- **Details slide over from the right**: Company, Activity, Settings, New bot and every bot profile. Esc, the close button or a click outside closes them.

Characters and looks:
- **Dark grey by default** (owner, 2026-11-11). The app opens on neutral dark grey (`#1a1a1d`), not near-black. Light and Follow system are choices under Settings → Appearance, and the choice is remembered.
- **Faces are simple and natural, never glowing** (owner, 2026-11-11). Each face is a soft fill of its tint with a faint shade at the bottom, soft round blush and a small catch-light in each eye. On dark grey the tints are slightly muted so they don't glow.
- **Cute, calm animations** (owner, 2026-11-11):
  - Sleeping bots breathe slowly and drift a small "z".
  - Awake faces glance left and right now and then.
  - Point at a sleeping bot and it peeks with its eyes open. Any face gives a tiny squash on hover, and pressed rows and buttons shrink slightly.
  - All motion stops under reduced motion.
- **Faces are characters.**
  - Each face has a tint gradient, eyes that blink and gently follow the pointer, and a small mouth.
  - States: asleep (closed eyes), awake, reading (working), waiting and wake (lifts up).
  - **Role shapes:** a circle for the primary, a rounded hexagon for managers, a rounded square for bots. There are no per-bot shapes.
- **Live routing preview.** While the owner types a new thread, the bot that would own it wakes in the lineup ("Planner would take this. Everyone else stays asleep."). An @mention wakes the picked bot.
- **Three looks to compare:**
  - Soft studio: off-white with soft depth. It follows the system's light or dark setting.
  - Ink & paper: warm paper, a serif display face and flat faces. It also follows the system's light or dark setting.
  - Night desk: always dark, with glowing tints.
  - The look is picked under Settings → Appearance. The floating switch is gone from the home screen. The build ships the chosen look plus light and dark.

Threads:
- **Header:** a back link to Bots, the owner's face (which opens the profile), the title and one live line ("Waiting on you", "Scholar and Quill working"). A soft wash of the owner's tint sits behind the top of the thread.
- **Messages, WhatsApp-style:** the owner's messages are mint bubbles on the right. Each bot reply is a bubble on the left, lightly tinted in that bot's colour, with the face beside it and the name on top. **No routing chatter:** no route line, no "N stayed asleep", no "Wrong bot?" and no "Used N memories" line (owner, 2026-11-11). Who owns the thread shows in the header.
- **System lines are centred pills,** like WhatsApp date and system notes: side conversations ("Scholar messaged Quill", tap to reveal the message), answered asks ("You allowed it once"), direct-thread notes, and memory lines (mint).
- **Asks keep the bot on screen.** While an ask card waits, the asking bot's face stays above it in a waiting state: it sways gently, looks down at the card, and shows three pulsing violet dots ("Planner is waiting on you"). It goes back to reading once the owner answers. The card is the only raised surface: one sentence and three buttons (Always allow / Allow once / Decline). An answered card collapses to one muted line.
- **Contacting one bot:** tap its card on the home screen, use "Message <bot>" on its profile, use ⌘K, or type @ in any composer. A message that starts with @Name skips routing. Follow-ups stay with the thread's owner.
- **Bot profile** has three tabs: Overview (job, model, manager, automatic context, team, and permissions with Always allow / Ask each time / Deny), Memory and Activity (local to the bot).
- **Motion:** only transform and opacity animate, with short ease-outs, and none at all under reduced motion. The waiting animation is CSS, not three.js. It stays light and dependency-free, and it is enough for faces this small.

## Activity log and Pause all (owner asked for both; the log must stay clean)

- **Where it lives.** Three places, each showing only what fits there, so nothing is repeated:
  - *The thread* already shows its own story (route, bot-to-bot lines, asks, reply). The log never repeats this chatter.
  - *Activity* is a sidebar row (clock icon) above Company. It opens in the side panel, not a full page.
  - *Each bot's profile* has its own activity section, local to that bot: its five newest entries grouped by day, and "Show all N" expands the full list in place. It never leaves the profile.
- **What gets an entry.** Only events the owner might need to find later: anything that left the app (email sent, page opened with a signed-in session, file changed, event added, post, payment), permission changes, and bots created, moved, paused or deleted. Never routing, thinking, bot-to-bot messages or reads inside the app.
- **How it reads.** One plain sentence per entry with the bot's face and the time ("Mailroom sent an email to Northwind: 'Wednesday works. 11:00?'"). Grouped by day (Today, Yesterday, then dates), newest first. Tapping an entry opens its thread.
- **Filters are four chips**, default first: *Left the app* · *Permissions* · *Bots* · *All*. No search box or date picker in v1.
- **Undo window.** An Always-allowed email send is held for 30 seconds; its entry and the thread show Undo during that window.
- **Pause all.** The sidebar's status line stops every bot-initiated run at once and shows a banner "All bots are paused. Nothing runs until you resume." with Resume. Pausing and resuming are logged under *Bots*. It reuses the runaway guard's pause mechanism.
- Storage: one append-only table (`activity`: id, at, botId, kind `outside|perm|bots`, text, threadId, undoUntil). Retention follows the existing retention rules.

## Architecture (builder's latitude inside these lines)

### Bots, jobs and the primary

- The existing bot record (`TABLE_SHAPES` bots in `src/sqlite-store.js`) gains `primary` (exactly one per workspace) and keeps `contract` as the bot's job. The seed in `SqliteStore.init` (`sqlite-store.js:513-520`) and `initialState()` (`shared/core.js:50-59`) creates one primary bot and no groups.
- **1:1 chats are first class.** Today bots live inside `state.groups[].bots[]`. A bot must exist without a group (the primary does). My call: make bots top level and groups a list of bot ids; migrate existing data. Builder may choose another shape if migration is simpler, as long as a bot can exist ungrouped and belong to several groups.
- **Duty routing**: a message goes to the bot it is addressed to (direct chat or @mention). In a group without a mention, the primary's ownership rule picks the bot whose job matches. A bot that receives work outside its job hands it to the owning bot via `handoffTargets` (`shared/coordination.js:324`, still the only way model text adds recipients), or to the primary if no owner exists. Each bot's system prompt states its job and the names and jobs of the other bots.
- The X-specific "tracked" mode (`planTracked`, `assessTask`, `awaiting_feed`) is deleted with X-engage.

### One ask mechanism

- New shared module (e.g. `shared/asks.js`, registered in `shared/assets.js`): an ask record `{id, botId, action, target, detail, status: pending|allowed|declined, scope: once|always, createdAt}`, plus a per-bot grants list for Always allow.
- `canBot` (`shared/contracts.js:97`) becomes: granted → proceed; not granted → create an ask and pause that step (run status `awaiting_ask`), resume on answer. Existing `awaiting_plan` and `awaiting_checkpoint` flows fold into the same record and card if that is cheap; otherwise leave them and remove later.
- Actions: `browser.use`, `connector.<name>.read`, `connector.<name>.write`, `send`, `post`, `delete`, `spend`. Basic-kit actions (`bot.create`, `bot.ask`, handoff, `schedule.set`, memory) are always granted and never asked.
- The ask card renders in the thread where the bot is working and in the primary's chat (one "Needs you" list). Amber pill count = pending asks.

### Models: API keys plus subscriptions

- Keep `src/ai.js` and `shared/ai-presets.js` as they are for API-key providers.
- Add a provider kind `local-cli` with two engines, `claude` and `codex`. A bot on `local-cli` runs as a local-agent task, not a server fetch: new agent task kind `model.run` (next to `browser.capture`, `browser.action` in `src/agent.js:27`).
- `agent/` spawns the CLI directly (`claude -p --output-format stream-json`, `codex exec --json`) with `node:child_process`. No SDK packages: both SDKs only spawn these binaries anyway, and spawning keeps the zero-dependency rule. The agent reports "claude signed in / codex signed in" in its heartbeat by checking the CLI's own status command; the app shows "Run `claude` and sign in on that machine" if not.
- Each bot has one model. New bots start on the creator's model, or the primary's default. Owner can change it on the bot. If a subscription hits its limit, the run fails with a clear message and an Ask-style card offering "Switch this bot to <other connected model>". (My call: no silent fallback.)
- Tools for CLI-run bots: the app's own actions (handoff, create bot, ask, browser, connectors) are passed as instructions plus a structured fence format, the same as API-key bots today. The CLI's built-in file/shell tools are disabled (`--allowedTools` / sandbox flags) so a bot cannot touch the owner's filesystem. Keep the "model output never gets publication or filesystem tools" rule.

### Shared browser with takeover

- Today: `agent/browser.mjs` launches headless Chrome over raw CDP with a throwaway profile; takeover (`ui-takeover.js`, `src/bot-browser.js:205`) is screenshot-based and server-runtime only.
- New: the local agent keeps **one persistent browser profile** (in the agent's config dir, mode 0700) shared by all bots. Sign-ins made there are available to every bot.
- Takeover works in agent mode: the app streams screenshots (CDP `Page.startScreencast`) and forwards the owner's clicks and keys, reusing the existing takeover UI. While the owner holds the browser, bots wait. "Hand back" resumes them.
- One bot drives the browser at a time; others queue. Each bot gets its own tab.
- Every browser use goes through the ask mechanism; reading a page after Always allow is free, submit/send/post/delete-like clicks get their own ask with Always allow per origin, and payment clicks ask every time (see Owner answers 1).
- The old X click/type refusal goes with X-engage; the general rule above replaces it.

### Connectors

- Native Google sign-in plus MCP servers (see Owner answers 2). Whatever the transport, a connector is: a name, a set of read and write actions, credentials held in the existing vault (`src/vault.js`, `src/credentials.js`), and set up through the primary bot. Bots ask the first time they use one.

### UI

- Chat list: the primary first, then bots and groups. New chat: "New bot" (one sentence: what is it for) and "New group".
- Bot info panel: name, job, model, what it has been allowed (with revoke). Nothing else by default. Temperature, reply length, context size and similar move behind one "Advanced" disclosure or are removed if unused.
- Group settings shrink to name, members, and an optional "ask me between steps".
- X-engage UI (drafts, posts found, reminders tab, voice and timing, `BOT_TEMPLATES`) is deleted.

### Pages demo

- `shared/group-simulator.js` is the whole Pages engine and is X-specific. My call: replace it with a small simulator where the primary bot answers with canned replies and can "create" a bot from a sentence, so the Pages demo still shows the core idea. No browser, connectors or subscriptions on Pages.

## Phases (each lands green, one commit or PR each)

0. **Commit or branch the current uncommitted work** on `main` (40 files) before anything else. Owner's call how.
1. **Remove X-engage.** Delete the footprint mapped below, delete/rewrite its tests, update README, AGENTS.md, COORDINATION.md, BUILD-PLAN. About 1,600-1,900 source lines.
2. **Primary bot, company model and threads.** Seed one primary; top-level bots with `reportsTo`; groups replaced by threads with no assignee; one-call routing with the visible route and quiet note; bot-to-bot message lines; manager and primary powers; unlimited creation from a sentence; runaway guard; automatic context; per-bot memory on the existing memory module; company chart view; Settings view; new Pages simulator. The approved clickable mock (`2026-11-11-primary-bot-platform-mock.html`, next to this file; throwaway code, scripted replies) is the UX reference.
3. **Ask mechanism.** Ask records, card, grants with Always allow / Ask each time / Deny per bot (in the bot profile and Settings), `awaiting_ask`; activity log and Pause all; remove permission checkboxes and `browserApproval`.
4. **Subscription models.** `local-cli` provider, `model.run` agent task, sign-in status, limit-hit card.
5. **Shared browser and takeover in agent mode.**
6. **Connectors**: Google sign-in (Gmail, Drive), then the MCP client.
7. **Move to the Oracle VM** (later, owner-triggered).

Phases 4, 5 and 6 are independent of each other once 3 lands.

## X-engage footprint (for phase 1)

- Seed and helpers: `shared/core.js:15-119`; `shared/workflow.js:75-81, 91-298, 430, 463-502`; `shared/evidence.js`; `shared/bot-settings.js:22, 125-146`.
- Feed/tracked logic: `shared/coordination.js:69-139`; `shared/bot-browser.js:32, 202-232`; `src/coordination.js:281, 343-382`; `shared/run-state.js:20`.
- Server: `src/routes-workflow.js:30-82`; `src/routes-public.js:135`; `src/app.js:44`; `src/handlers.js:61`; draft tick in `src/scheduler.js`; `src/ai.js:513`; `reminder` and `candidate-draft` in `shared/tasks.js`; candidates/drafts/evidence tables and seed in `src/sqlite-store.js`.
- `extension/` (whole folder) and its test; `shared/demo-feed.html`; X routes in `shared/local-api.js`; `shared/group-simulator.js`, `shared/chat-engine.js`.
- UI: `ui-panel.js:118-215`; `ui-views.js:75-140, 205-228`; `ui-actions.js:73-74, 125-211, 353-378`; `ui-sheets.js:11-108`; X parts of `ui-model.js`, `ui-chat.js:90-103`, `ui-store.js:145`.
- Tests to delete: `extension`, `evidence`, draft half of `scheduler`. Many others need edits (workflow, ui-model, bot-flex, coordination*, core, bot-browser, chats, pages, e2e-journey, usability, api, sqlite-store, persistence-*, credentials-backup, task-validation, engine-parity, Python smokes).

## Calls made after the builder check (my calls, owner may override)

- **The app classifies risk, never the bot.** Browser actions are structured (`navigate`, `read`, `click`, `type`, `submit`). Always asks: any form submit, any non-GET request the action triggers, any click on an element whose text or role matches send / post / publish / delete / remove / pay / buy / confirm / submit, and any `navigate` whose URL carries data from a connector or another page in its query string. Connector write actions are declared by the connector, not the bot.
- **Grant scope:** per bot, per action, per origin for `browser.use`, per account for connectors. Bots never inherit their creator's grants. "Who is allowed what" lists grants in that shape.
- **Who answers:** asks, "Needs you" and primary-only powers belong to workspace `owner` and `admin` roles. One primary per workspace. Multi-member support stays; `member` and `viewer` cannot answer asks or bind subscription bots.
- **Runaway guard is a general limiter:** a per-workspace counter of bot-initiated runs and bot creations (handoffs, scheduled runs, creations all count). Over about 20 creations or 60 bot-initiated runs in 5 minutes, or a handoff cycle seen 3 times, all bot-initiated work pauses and the primary asks the owner. Owner-initiated chats keep working. The existing per-run step cap stays.
- **Pending asks hold nothing.** A bot releases the browser before it asks. Asks push a notification. Asks from unattended runs expire after 24 hours as declined.
- **Primary routing failure:** if the primary's model is unavailable, the group message gets a card asking the owner which bot should take it.
- **No token streaming for `local-cli` bots in v1.** The thread shows "working…" until the result returns.

## Owner answers (2026-11-11)

1. **Always allow is offered for every action except payments.** Send, post, delete, connector writes and browser submits all get Decline / Allow / Always allow. Anything that pays or spends money (checkout, card or wallet forms, purchase buttons, the `spend` action) only offers Decline / Allow, every time. The risk classifier above still runs: it decides which card appears, and an Always allow grant for a risky action still stays per bot, per action, per origin or account.
2. **Connectors: both native Google sign-in and MCP servers; MCP preferred** for everything beyond Google.
   - *Google (Gmail, Drive):* OAuth 2.0 authorization-code flow with PKCE, run by the server, tokens in the vault. The owner creates their own Google Cloud OAuth client and pastes the client id and secret under the primary's setup. Note: while that OAuth app is in "Testing" status, Google expires refresh tokens after 7 days for sensitive scopes, so the UI must show "reconnect Google" cleanly; publishing the app for personal use removes this. The redirect is `http://localhost:<port>/...` on the laptop and needs an HTTPS hostname on the VM.
   - *MCP:* a small hand-written MCP client (JSON-RPC 2.0; no npm dependency). Stdio servers run inside the local agent; streamable-HTTP servers can be called from the server. Each MCP server is one connector; its tools become that connector's actions. Tool annotations (`readOnlyHint`, `destructiveHint`) feed the classifier; tools without annotations are treated as write. `local-cli` bots get MCP through the app's own tool fences, not the CLI's MCP config, so every call goes through the ask mechanism.
3. **The server runs on the owner's laptop first, then moves to the owner's Oracle VM.** Leave room for that:
   - keep the server and the local agent as separate processes paired over HTTP even when they share a machine (they already are);
   - no hard-coded `localhost` in server logic; base URL and OAuth redirect come from config;
   - data moves with the existing backup/restore; document the move in `docs/DEPLOYMENT.md`;
   - on the VM, subscription CLIs, the shared browser profile and stdio MCP servers live wherever the local agent runs: the laptop (then they pause when it sleeps) or an agent on the VM too (owner signs in to `claude` and `codex` there once).
   - Tracked as the last item of Phase Z in `docs/BUILD-PLAN.md`.

## Left to the builder

- Exact data migration for existing workspaces (dropping X tables is fine; owner has no production data to keep — confirm in phase 1 PR).
- Ask record storage shape, card styling, run-status naming.
- How the primary's ownership rule is prompted (model-decided with the bot list as context is fine).
- Screencast frame rate and input forwarding details.
- Which advanced bot settings survive.
