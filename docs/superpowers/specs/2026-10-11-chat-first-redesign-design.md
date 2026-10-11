# Chat-first redesign (2026-10-11)

Design canvas: https://claude.ai/artifact/VApTZjzH1efgGxd7ePeq1L (private to the owner).

## Brief
Rebuild the whole UI so using Agent Control feels like chatting with bots, in the
spirit of Grok's mobile bots and WhatsApp, and improve the frontend architecture.
This ran as an autonomous goal, so the decisions below were made without a review
round. Each is an assumption the owner can overturn.

## Concept
- Thesis: everything is a conversation, and a decision arrives as a message you
  answer in place.
- Signature: the draft card. It sits in the thread, carries Approve / Edit / Skip,
  and its footer always says whose move it is.
- Colour (fourth pass, each one steered by the owner: black and white was
  rejected, then saturated dark themes, then a peach-on-cream pair that was
  too beige and too washed out): a clean off-white light theme and a
  dark-grey (never black) dark theme that share one mapping. Mint green is what you do (your
  bubbles, send, primary actions). Violet, a triad step from mint, means only
  "waiting on you". Deeper green marks what you finished and red is kept for
  destructive actions. Each bot owns one of six evenly spaced pastels, carried
  by its face, its name and its bubbles; decision cards stay neutral so they
  stand out. The app follows the system setting unless a theme is pinned under
  You > Colours.
- Motion (owner's steer: fun, character-led animation like the Grok bots, not
  bouncy chrome, and "see how creative we can get"): every bot is a small face
  instead of a letter, with states listed at the top of the "bots are alive"
  block in `app.css`. They blink, wink and glance on their own beat; the two
  bots of a group look at each other; big faces follow the pointer; they read
  along while you type, nod when you send, look up and bob while thinking,
  talk when their message lands, cheer when you approve or post, droop when
  you skip, doze off after 40 seconds of nothing and startle awake, and do a
  trick and say hi when poked. `ui-fx.js` only decides when; the looks are
  CSS. Interface motion itself stays quiet, and all of it stops under
  prefers-reduced-motion.
- Excluded on purpose: stat tiles, workspace tabs, breadcrumbs, hero banners.

## Information architecture
| Before | Now |
| --- | --- |
| Home dashboard | Chat list (search, filters: All, Needs you, Groups, Bots) |
| Group workspace tabs | Info panel of the group chat |
| Approvals / Approval inbox | Draft cards in the X-engage thread, plus Info > Drafts |
| Discovery | Posts as messages in the thread, plus Info > Posts found |
| Schedules, Activity, Settings | Info > Reminders, Runs, Voice and timing |
| Sidebar admin links | You page |
| Native confirm/prompt | In-app sheets |

Routes: `#chats`, `#chat/<id>`, `#chat/<id>/info/<section>`, `#you/<page>`.
`#inbox` and `#group/<id>/<tab>` redirect.

## Architecture
`shared/app.js` is the entry point (boot, route render, DOM events). The rest is
split by responsibility; the module map is at the top of `app.js` and in AGENTS.md.
Rules that keep it honest:
- `ui-model.js` and `ui-kit.js` are pure, so product rules (what needs the human,
  list order, the timeline, routes) are unit tested without a browser.
- `ui-store.js` holds the only state object. Views never keep copies.
- Actions and forms are lookup tables in `ui-actions.js`, not one switch.
- The composer and list shell are painted once; refreshes only replace contents,
  so a background sync cannot wipe typing.

## Assumptions
- System fonts. The CSP dropped the Google Fonts origins.
- Chat history stays in browser storage as before. Server-side history for direct
  bot chats was left out of scope.
- `src/server.js` was not restructured: other work is in flight there. Only its
  asset list changed.
- Posts and drafts belong to the X-engage group, as in the data model today.

## Verification
`npm run check`, `npm test`, `npm run build:pages`, and both Playwright smokes
(`python3 tests/polish_smoke.py`, `python3 tests/usability_smoke.py`). Screens were
also inspected at 1360px and 390px on the static build and on the Node server.
