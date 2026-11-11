"""Interactive browser checks for the chats shell: new bots, the profile, Settings, the cards that wait on you, faces and keyboard.

Drives the real generated static build (the same files GitHub Pages serves), not
a concatenated copy. The script rebuilds the bundle from `shared/` into a temp
directory (so it never touches `docs/` and never tests a stale build), serves it
from a local http.server on a free port and opens every scenario in a fresh
browser context so localStorage always starts empty.

Run: python3 tests/usability_smoke.py   (screenshots of failures land in a temp dir)
No network and no credentials.
"""
import asyncio
import http.server
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import traceback
from pathlib import Path
from playwright.async_api import async_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
DESKTOP = {'width': 1360, 'height': 860}
PHONE = {'width': 390, 'height': 844}
PRIMARY = 'atlas'
# The starting workspace is one company (the Home group) with one bot (Atlas), pinned.
# Scenarios that need more bots create them through the app's own API first.
EXTRA_BOTS = {
    'Researcher': 'Find and summarise what the user asks about.',
    'Writer': 'Write clear, concise drafts from what the others found.',
    'Reviewer': 'Check the draft for unsupported claims.',
}
expect.set_options(timeout=6000)


def build_site(tmp):
    """Run scripts/build-pages.js against a copy of shared/, so docs/ is untouched."""
    shutil.copytree(ROOT / 'shared', tmp / 'shared')
    # The whole scripts/ directory: the build imports its own helper modules, and
    # a hardcoded copy list breaks the moment one is added (ERR_MODULE_NOT_FOUND).
    shutil.copytree(ROOT / 'scripts', tmp / 'scripts')
    (tmp / 'package.json').write_text('{"type":"module"}')
    subprocess.run(['node', 'scripts/build-pages.js'], cwd=tmp, check=True, capture_output=True)
    return tmp / 'docs'


def serve(directory):
    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k):
            super().__init__(*a, directory=str(directory), **k)

        def log_message(self, *a):
            pass
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def known_noise(msg):
    """The meta CSP cannot carry frame-ancestors (the server header does), and no favicon is shipped."""
    url = (msg.location or {}).get('url', '')
    # A takeover with no device running answers 409 on purpose; the browser logs every failed fetch.
    return 'frame-ancestors' in msg.text or 'favicon' in url or '409 (Conflict)' in msg.text


class Harness:
    def __init__(self, browser, base, shots):
        self.browser, self.base, self.shots = browser, base, shots
        self.results = []

    async def scenario(self, name, fn, viewport=DESKTOP):
        # SMOKE_ONLY=<text> runs just the scenarios whose name contains it (a shortcut while developing).
        if os.environ.get('SMOKE_ONLY') and os.environ['SMOKE_ONLY'] not in name:
            return
        context = await self.browser.new_context(viewport=viewport)
        page = await context.new_page()
        page.set_default_timeout(6000)
        problems, dialogs = [], []
        page.on('pageerror', lambda e: problems.append(f'pageerror: {e}'))
        page.on('console', lambda m: m.type == 'error' and not known_noise(m) and problems.append(f'console: {m.text}'))
        page.on('dialog', lambda d: (dialogs.append(d.message), asyncio.create_task(d.dismiss())))
        try:
            await fn(page, self.base)
            assert not dialogs, f'native dialog opened: {dialogs}'
            assert not problems, problems
            self.results.append((name, None))
            print(f'  ok   {name}')
        except Exception as error:  # noqa: BLE001 - report every scenario, then exit non-zero
            shot = self.shots / (re.sub(r'\W+', '-', name) + '.png')
            try:
                await page.screenshot(path=str(shot))
            except Exception:  # noqa: BLE001
                shot = None
            self.results.append((name, error))
            print(f'  FAIL {name}: {type(error).__name__}: {str(error).splitlines()[0] if str(error) else ""}')
            traceback.print_exc(limit=-3)
            if shot:
                print(f'       screenshot: {shot}')
        finally:
            await context.close()


SCREEN = '#main .cv, #main .hv, #main .rail-none, #main .nv, #main .pg, #main .st-wrap'


async def open_app(page, base, hash_='', bots=None):
    """Open the app; with `bots` ({name: instructions}) first add them to the company through
    the app's own local API, reload so the UI reads them, and return {name: bot id}."""
    await page.goto(f'{base}/index.html{hash_}')
    await page.locator(SCREEN).first.wait_for()
    if not bots:
        return {}
    ids = await page.evaluate('''async bots => {
        const made = {};
        for (const [name, instructions] of Object.entries(bots)) {
            made[name] = (await window.AGENT_API('/api/groups/home/bots', 'POST', {name, instructions})).id;
        }
        return made;
    }''', bots)
    await page.reload()
    await page.locator(SCREEN).first.wait_for()
    return ids


async def overflow(page):
    return await page.evaluate('() => document.documentElement.scrollWidth - innerWidth')


async def hash_(page):
    return await page.evaluate('location.hash')


# ---------------------------------------------------------------- helpers

KEY = 'agent-control-ghpages-v1'


async def patch_state(page, script):
    """Edit the demo's stored workspace (`s`) and reload, to stage what only a live server
    writes: an out-of-job reply, a run paused at a limit, a page request."""
    await page.evaluate('''([key, body]) => {
        const s = JSON.parse(localStorage.getItem(key));
        new Function('s', body)(s);
        localStorage.setItem(key, JSON.stringify(s));
    }''', [KEY, script])
    await page.reload()
    await page.locator(SCREEN).first.wait_for()


async def toast_text(page):
    return await page.locator('#toast').inner_text()


# ---------------------------------------------------------------- scenarios

async def api_state(page):
    return await page.evaluate('() => window.AGENT_API("/api/state")')


def company_bot(state, name):
    return next(b for g in state['groups'] for b in g['bots'] if b['name'] == name)


async def create_bot_from_page(page, base):
    await open_app(page, base)
    await page.locator('#sidebar [data-action="new-bot"]').click()
    assert await hash_(page) == '#new-bot'
    form = page.locator('#new-bot-form')
    await expect(form).to_be_visible()
    await expect(form.locator('input[name=name]')).to_be_focused()
    # Create waits for a name; the first unused colour is already picked.
    create = form.locator('.nb-go')
    await expect(create).to_be_disabled()
    await expect(form.locator('input[name=tint]:checked')).to_have_value('1')
    await form.locator('input[name=name]').fill('Publishing assistant')
    await expect(create).to_be_enabled()
    # A shape and a colour: the live preview follows both.
    await form.locator('.lk-shape[title="Hexagon"]').click()
    await form.locator('.lk-dot:nth-child(8)').click()
    await expect(form.locator('.lk-preview svg')).to_have_attribute('data-shape', 'hexagon')
    await create.click()
    # Lands in the new bot's own chat, which asks for its job.
    await expect(page.locator('#main h1')).to_have_text('Publishing assistant')
    assert (await hash_(page)).startswith('#bot/'), await hash_(page)
    await expect(page.locator('#cv-log .cv-empty')).to_contain_text('Tell it what it should do')
    await expect(page.locator('#toast')).to_contain_text('Publishing assistant is ready')
    await expect(page.locator('#sidebar .crow', has_text='Publishing assistant')).to_have_count(1)
    await expect(page.locator('#sidebar .crow.on')).to_contain_text('Publishing assistant')
    await expect(page.locator('#sidebar .crow.on svg.face')).to_have_attribute('data-shape', 'hexagon')
    made = company_bot(await api_state(page), 'Publishing assistant')
    assert made['settings']['shape'] == 'hexagon' and made['settings']['tint'] == 7, made['settings']
    # The first message is its job, and the bot answers in its own chat.
    await page.locator('#chat-form textarea').fill('Check drafts for unsupported facts.')
    await page.locator('#chat-form textarea').press('Enter')
    await expect(page.locator('.cv-bot .cv-body').last).to_be_visible(timeout=10000)
    made = company_bot(await api_state(page), 'Publishing assistant')
    assert made['instructions'] == 'Check drafts for unsupported facts.', made['instructions']
    await page.reload()
    await expect(page.locator('#main h1')).to_have_text('Publishing assistant')


async def edit_rename_and_move(page, base):
    ids = await open_app(page, base, bots=EXTRA_BOTS)
    writer, researcher = ids['Writer'], ids['Researcher']
    await page.locator(f'#sidebar .crow[data-id="{writer}"]').click()
    await page.locator('#main .cv-who').click()
    assert await hash_(page) == f'#profile/{writer}', await hash_(page)
    await expect(page.locator('#main .pr-hero h1')).to_have_text('Writer')
    await expect(page.locator('#main .pr-hero small')).to_have_text('Bot · reports to Atlas')
    # Edit changes the name, and nothing else when nothing else is touched.
    await page.locator('#main .pill-btn', has_text='Edit').click()
    assert await hash_(page) == f'#profile/{writer}/edit', await hash_(page)
    await page.locator('#edit-bot-form input[name=name]').fill('Drafter')
    await page.locator('#edit-bot-form button[type=submit]').click()
    await expect(page.locator('#main .pr-hero h1')).to_have_text('Drafter')
    await expect(page.locator('#sidebar .crow', has_text='Drafter')).to_have_count(1)
    await expect(page.locator('#sidebar .crow', has_text='Writer')).to_have_count(0)
    drafter = company_bot(await api_state(page), 'Drafter')
    assert drafter.get('settings', {}).get('shape') in (None, ''), drafter.get('settings')
    # Move it under a manager from the options menu: Researcher gets its first report.
    await page.locator('#main [data-action="bot-menu"]').click()
    await expect(page.locator('#cmenu')).to_be_visible()
    await page.locator('#cmenu [data-action="menu-move"]').click()
    await page.locator('#cmenu [data-action="menu-move-to"]', has_text='Researcher').click()
    await expect(page.locator('#toast')).to_contain_text('Drafter now reports to Researcher')
    await expect(page.locator('#main .pr-hero small')).to_have_text("Bot · Researcher's team")
    moved = company_bot(await api_state(page), 'Drafter')
    assert moved['settings']['reportsTo'] == researcher, moved['settings']
    # Researcher is a manager now: its profile lists a Team, and the Company chart nests Drafter.
    await page.goto(f'{base}/index.html#profile/{researcher}')
    await page.reload()
    await expect(page.locator('#main .pr-hero small')).to_have_text('Manager · reports to Atlas')
    await expect(page.locator('#main .rw', has_text='Team')).to_contain_text('1 bot')
    await page.goto(f'{base}/index.html#company')
    await page.reload()
    await expect(page.locator('#main .co-tree ul .co-node', has_text='Drafter')).to_have_count(1)
    # Esc leaves a menu before it leaves a page; Esc on the page goes back.
    await page.goto(f'{base}/index.html#profile/{researcher}')
    await page.reload()
    await page.locator('#main [data-action="bot-menu"]').click()
    await page.keyboard.press('Escape')
    await expect(page.locator('#cmenu')).to_have_count(0)
    assert await hash_(page) == f'#profile/{researcher}'


async def delete_bot_reports_go_solo(page, base):
    ids = await open_app(page, base, bots=EXTRA_BOTS)
    researcher, writer, reviewer = ids['Researcher'], ids['Writer'], ids['Reviewer']
    for child in (writer, reviewer):
        await page.evaluate('([g, id, boss]) => window.AGENT_API(`/api/groups/${g}/bots/${id}`, "PATCH", {settings: {reportsTo: boss}})', ['home', child, researcher])
    await page.goto(f'{base}/index.html#profile/{researcher}')
    await page.reload()
    await expect(page.locator('#main .rw', has_text='Team')).to_contain_text('2 bots')
    await page.locator('#main [data-action="bot-menu"]').click()
    await page.locator('#cmenu [data-action="menu-delete"]').click()
    sheet = page.locator('#modal .sheet')
    await expect(sheet).to_contain_text('Delete Researcher?')
    await expect(sheet).to_contain_text("Its job, memory and permissions are deleted. This can't be undone.")
    await expect(sheet).to_contain_text('Its 2 reports move to Solo.')
    await expect(sheet).to_contain_text('Its threads stay.')
    await sheet.get_by_role('button', name='Delete', exact=True).click()
    await expect(page.locator('#toast')).to_contain_text('Researcher deleted')
    # The profile closes, and the bot leaves the list; its reports stay, and are Solo.
    assert await hash_(page) == '#chats', await hash_(page)
    await expect(page.locator('#sidebar .crow', has_text='Researcher')).to_have_count(0)
    await expect(page.locator('#sidebar .crow', has_text='Writer')).to_have_count(1)
    state = await api_state(page)
    for name in ('Writer', 'Reviewer'):
        assert company_bot(state, name)['settings'].get('reportsTo') in (None, ''), company_bot(state, name)['settings']
    assert not any(b['name'] == 'Researcher' for g in state['groups'] for b in g['bots'])


async def atlas_has_no_delete(page, base):
    await open_app(page, base, bots=EXTRA_BOTS)
    await page.goto(f'{base}/index.html#profile/{PRIMARY}')
    await page.reload()
    await expect(page.locator('#main .pr-hero small')).to_have_text('Primary')
    await page.locator('#main [data-action="bot-menu"]').click()
    items = await page.locator('#cmenu [role=menuitem]').all_inner_texts()
    # Atlas starts pinned for everyone, so its pin item is Unpin; it has no Move, Hide or Delete.
    assert items == ['Message Atlas', 'Unpin'], items
    # The chart's row menu for Atlas offers the same two, and a bot offers all five.
    await page.keyboard.press('Escape')
    await page.goto(f'{base}/index.html#company')
    await page.reload()
    await page.locator('#main .co-row', has_text='Atlas').locator('[data-action="bot-menu"]').click()
    assert await page.locator('#cmenu [role=menuitem]').all_inner_texts() == ['Message Atlas', 'Unpin']
    await page.keyboard.press('Escape')
    await page.locator('#main .co-row', has_text='Writer').locator('[data-action="bot-menu"]').click()
    items = await page.locator('#cmenu > [role=menuitem]').all_inner_texts()
    assert items == ['Message Writer', 'Pin', 'Move to…', 'Hide', 'Delete…'], items
    # Pin from the menu puts a bot in the pinned row.
    await page.locator('#cmenu [data-action="menu-pin"]').click()
    await expect(page.locator('#sidebar .pin', has_text='Writer')).to_have_count(1)


async def settings_from_avatar_and_esc(page, base):
    await open_app(page, base)
    await page.locator('#sidebar .rail-me').click()
    assert await hash_(page) == '#settings', await hash_(page)
    dialog = page.locator('#main .st-dlg')
    await expect(dialog).to_be_visible()
    await expect(dialog.locator('.st-nav button')).to_have_text(['General', 'Appearance', 'Models and keys', 'Connectors', 'Permissions', 'Usage', 'Computer', 'Activity', 'Company'])
    # The Bots running switch is the pause switch, and it works in place.
    switch = dialog.locator('[data-pause]')
    await expect(switch).to_have_attribute('aria-checked', 'true')
    await switch.click()
    await expect(switch).to_have_attribute('aria-checked', 'false')
    await expect(dialog.locator('[data-pause-sub]')).to_have_text('Everything is paused')
    await switch.click()
    await expect(switch).to_have_attribute('aria-checked', 'true')
    # Tab stays inside the dialog.
    for _ in range(25):
        await page.keyboard.press('Tab')
        assert await page.evaluate("!!document.activeElement.closest('.st-dlg')"), 'Tab left the Settings dialog'
    await dialog.locator('.st-nav [data-section="conn"]').click()
    await expect(dialog.locator('.st-head h2')).to_have_text('Connectors')
    await expect(dialog).to_contain_text('Coming in a later phase')
    # Esc closes it and the chat behind it is back.
    await page.keyboard.press('Escape')
    await expect(page.locator('#main .st-dlg')).to_have_count(0)
    assert (await hash_(page)).startswith('#bot/'), await hash_(page)
    # So does the close button and a click outside.
    await page.locator('#sidebar .rail-me').click()
    await page.locator('#main [data-action="settings-close"][aria-label]').click()
    await expect(page.locator('#main .st-dlg')).to_have_count(0)
    await page.locator('#sidebar .rail-me').click()
    await page.mouse.click(1330, 840)
    await expect(page.locator('#main .st-dlg')).to_have_count(0)


async def activity_page_and_counts(page, base):
    ids = await open_app(page, base, bots=EXTRA_BOTS)
    writer = ids['Writer']
    # Settings links to Activity and Company; the chips are Left the app, Permissions, Bots, All.
    await page.locator('#sidebar .rail-me').click()
    await page.locator('#main .st-nav [data-action="go-activity"]').click()
    assert await hash_(page) == '#activity', await hash_(page)
    chips = page.locator('#main .ay-chips button')
    await expect(chips).to_have_text(['Left the app', 'Permissions', 'Bots', 'All'])
    await expect(chips.first).to_have_attribute('aria-selected', 'true')
    await expect(page.locator('#ay-list')).to_contain_text('Nothing has left the app yet.')
    # Making bots is logged under Bots, one plain sentence with the bot's name and a time.
    await chips.nth(2).click()
    await expect(chips.nth(2)).to_have_attribute('aria-selected', 'true')
    await expect(page.locator('#ay-list .ay-row', has_text='Writer')).to_have_count(1)
    await expect(page.locator('#ay-list .ay-day').first).to_have_text('Today')
    await chips.nth(3).click()
    assert await page.locator('#ay-list .ay-row').count() >= 3
    # A profile shows its own count, and its Activity page lists only what names it.
    await page.goto(f'{base}/index.html#profile/{writer}')
    await page.reload()
    await expect(page.locator('#main [data-activity-count]')).to_have_text('1')
    await page.locator('#main .rw', has_text='Activity').click()
    await expect(page.locator('#pr-activity .ay-row')).to_have_count(1)
    await expect(page.locator('#pr-activity .ay-row')).to_contain_text('Writer')


async def phone_settings_cards(page, base):
    await open_app(page, base)
    await page.locator('.ch-me').click()
    cards = page.locator('#main .st-phone')
    await expect(cards).to_be_visible()
    await expect(cards.locator('.rw', has_text='Bots running')).to_be_visible()
    await expect(cards.locator('.rw', has_text='Activity')).to_be_visible()
    assert await overflow(page) <= 0
    # A row opens its section; Back returns to the cards; Esc closes the page.
    await cards.locator('.rw', has_text='Permissions').click()
    await expect(page.locator('#main .pr-subbar h1')).to_have_text('Permissions')
    await page.locator('#main [data-action="settings-back"]').click()
    await expect(page.locator('#main .st-phone .pr-subbar')).to_have_count(0)
    await page.keyboard.press('Escape')
    await expect(page.locator('body')).to_have_attribute('data-view', 'home')
    # The phone profile menu is a sheet from the bottom.
    await page.goto(f'{base}/index.html#profile/{PRIMARY}')
    await page.reload()
    await page.locator('#main [data-action="bot-menu"]').click()
    await expect(page.locator('#cmenu.sheet')).to_be_visible()


async def phone_create_bot(page, base):
    await open_app(page, base)
    await page.locator('.ch-new').click()
    await page.locator('#new-bot-form input[name=name]').fill('Market scanner')
    await page.locator('#new-bot-form .lk-shape[title="Drop"]').click()
    await page.locator('#new-bot-form .nb-go').click()
    await expect(page.locator('body')).to_have_attribute('data-view', 'chat')
    await expect(page.locator('#main h1')).to_have_text('Market scanner')
    assert await overflow(page) <= 0
    await page.locator('#main .cv-head .rbtn').first.click()
    await expect(page.locator('body')).to_have_attribute('data-view', 'home')
    await expect(page.locator('#main .crow', has_text='Market scanner')).to_have_count(1)
    await expect(page.locator('#main .crow', has_text='Market scanner').locator('svg.face')).to_have_attribute('data-shape', 'drop')


async def out_of_job_card(page, base):
    ids = await open_app(page, base, bots=EXTRA_BOTS)
    writer = ids['Writer']
    await patch_state(page, f'''
        const at = new Date().toISOString();
        s.chats[{writer!r}] = [
          {{id: 'o1', role: 'user', text: 'Book me a table for Friday', at}},
          {{id: 'o2', role: 'bot', senderId: {writer!r}, senderName: 'Writer', mode: 'ai', kind: 'offjob', botId: {writer!r}, request: 'Book me a table for Friday', text: 'That is not part of my job. I write drafts.', at}},
        ];''')
    await page.goto(f'{base}/index.html#bot/{writer}')
    await page.reload()
    card = page.locator('.cv-card')
    await expect(card).to_have_count(1)
    labels = await card.locator('.btn').all_inner_texts()
    assert labels == ['Do it anyway', 'Ask Atlas', 'Make a new bot'], labels
    # Make a new bot opens the New bot page with the request as the job.
    await card.get_by_role('button', name='Make a new bot').click()
    assert (await hash_(page)).startswith('#new-bot/'), await hash_(page)
    await expect(page.locator('#new-bot-form .nb-job')).to_contain_text('Book me a table for Friday')
    await page.go_back()
    # Ask Atlas starts a thread with the request; the owner's line is written once.
    await page.locator('.cv-card').get_by_role('button', name='Ask Atlas').click()
    await expect(page.locator('#cv-line')).to_have_text('Atlas runs this thread', timeout=10000)
    assert (await hash_(page)).startswith('#thread/'), await hash_(page)
    await expect(page.locator('.cv-me')).to_have_count(1)
    await expect(page.locator('.cv-me')).to_have_text('Book me a table for Friday')
    # Do it anyway runs the same request in the bot's chat and settles the card.
    await page.goto(f'{base}/index.html#bot/{writer}')
    await page.reload()
    await page.locator('.cv-card').get_by_role('button', name='Do it anyway').click()
    await expect(page.locator('.cv-bot .cv-body').last).to_contain_text('Book me a table', timeout=10000)
    await expect(page.locator('.cv-card')).to_have_count(0)


async def checkpoint_and_ask_cards(page, base):
    ids = await open_app(page, base, bots=EXTRA_BOTS)
    writer = ids['Writer']
    await patch_state(page, f'''
        const at = new Date().toISOString();
        s.chats[{writer!r}] = [{{id: 'c1', role: 'user', text: 'Keep checking with the others', at}}];
        s.groupRuns.unshift({{id: 'run-limit', groupId: 'home', chatKey: {writer!r}, status: 'awaiting_limit', recipients: [{writer!r}], currentStep: 1,
          trace: [{{botId: {writer!r}, output: 'Asked'}}], createdAt: at, limit: {{kind: 'pair', at: 12}}, asks: {{total: 12}}}});''')
    await page.goto(f'{base}/index.html#bot/{writer}')
    await page.reload()
    card = page.locator('.cv-card')
    await expect(card.locator('p')).to_have_text('Bots have sent 12 messages for this task.')
    labels = await card.locator('.btn').all_inner_texts()
    assert labels == ['Keep going', "Keep going, don't ask again", 'Stop'], labels
    # The asking bot's face waits above the card, and the header says so.
    await expect(page.locator('.cv-wait svg.face--waiting')).to_be_visible()
    await expect(page.locator('.cv-wait')).to_contain_text('Writer is waiting on you')
    await expect(page.locator('#cv-line')).to_have_text('Waiting on you')
    await expect(page.locator('.cv-done')).to_have_count(0)  # a paused run shows its card, not a pill
    # A bot's request to open a page is an ask card with the same waiting face.
    await patch_state(page, f'''
        const at = new Date().toISOString();
        s.groupRuns = s.groupRuns.filter(r => r.id !== 'run-limit');
        s.browserRequests = [{{id: 'br1', botId: {writer!r}, botName: 'Writer', groupId: 'home', chatKey: {writer!r}, status: 'pending', url: 'https://example.com/', steps: [{{op: 'navigate', url: 'https://example.com/'}}], createdAt: at, updatedAt: at}}];
        s.chats[{writer!r}].push({{id: 'browser-br1', role: 'system', kind: 'browser', text: 'Writer wants to open a page.', at}});''')
    await expect(page.locator('.cv-wait svg.face--waiting')).to_be_visible()
    await expect(page.locator('.cv-card .btn')).to_have_text(['Approve', 'Decline'])
    await expect(page.locator('.cv-card a')).to_have_attribute('rel', 'noopener noreferrer')


async def faces_come_alive(page, base):
    """A chat opens with a hello hop, a first reply hops once, and the hop does not stick."""
    ids = await open_app(page, base, bots=EXTRA_BOTS)
    await page.locator(f'#sidebar .crow[data-id="{ids["Writer"]}"]').click()
    await expect(page.locator('#main .cv-who .face')).to_have_class(re.compile('face--hop'))
    await expect(page.locator('#main .cv-who .face')).not_to_have_class(re.compile('face--hop'), timeout=3000)
    await expect(page.locator('#main .cv-who .face')).to_have_class(re.compile('face--awake'))
    await page.locator('#chat-form textarea').fill('hi')
    await page.locator('#chat-form textarea').press('Enter')
    reply = page.locator('.cv-bot .face').last
    await expect(reply).to_be_visible(timeout=10000)
    await expect(reply).not_to_have_class(re.compile('face--hop'), timeout=3000)
    # Sleepers breathe, the primary is awake and sways.
    await expect(page.locator('#sidebar .crow .face--asleep')).to_have_count(3)
    await expect(page.locator('#sidebar .pin .face--sway')).to_have_count(1)


async def keyboard_and_escape(page, base):
    await open_app(page, base, bots=EXTRA_BOTS)
    # Everything is reachable by keyboard: Tab walks the sidebar, Enter opens a bot.
    await page.locator('#rail-q').focus()
    for _ in range(4):
        await page.keyboard.press('Tab')
    focused = await page.evaluate('document.activeElement.dataset.action')
    assert focused in ('open-bot', 'new-bot'), focused
    await page.locator('#sidebar .crow', has_text='Reviewer').focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('#main h1')).to_have_text('Reviewer')
    # Esc leaves the search box and clears what was typed.
    await page.keyboard.press('Control+k')
    await page.keyboard.type('zzz')
    await expect(page.locator('#sidebar .hv-empty')).to_be_visible()
    await page.keyboard.press('Escape')
    await expect(page.locator('#rail-q')).not_to_be_focused()
    await expect(page.locator('#sidebar .hv-empty')).to_have_count(0)


async def phone_search_and_escape(page, base):
    await open_app(page, base, bots=EXTRA_BOTS)
    await page.locator('#sq').focus()
    await expect(page.locator('#ch-res')).to_be_visible()
    await page.keyboard.press('Escape')
    await expect(page.locator('#ch-res')).to_be_hidden()
    await expect(page.locator('#sq')).not_to_be_focused()
    # Ctrl+K from inside a chat goes home and lands in the bottom search.
    await page.locator('#main .pin').click()
    await expect(page.locator('body')).to_have_attribute('data-view', 'chat')
    await page.keyboard.press('Control+k')
    await expect(page.locator('body')).to_have_attribute('data-view', 'home')
    await expect(page.locator('#sq')).to_be_focused()
    # A tap outside closes the results.
    await page.locator('#main').click(position={'x': 200, 'y': 300})
    await expect(page.locator('#ch-res')).to_be_hidden()


# ---------------------------------------------------------------- pin and reorder

async def row_names(page, root='#sidebar'):
    return await page.locator(f'{root} .crow').evaluate_all('els => els.map(e => e.querySelector("b").textContent)')


async def pin_names(page, root='#sidebar'):
    return await page.locator(f'{root} .pin').evaluate_all('els => els.map(e => e.querySelector("span").textContent)')


async def poll_equal(page, read, want, timeout=4000):
    """Wait until `read()` (an async function of nothing) returns `want`; the lists settle after a spring."""
    for _ in range(timeout // 50):
        if await read() == want:
            return
        await page.wait_for_timeout(50)
    assert await read() == want, (await read(), want)


async def drag(page, source, target, to_y=None, to_x=None, steps=14):
    """Press on `source` and move to the middle of `target` (or to a point) in small steps. The button stays down."""
    a = await source.bounding_box()
    await page.mouse.move(a['x'] + a['width'] / 2, a['y'] + a['height'] / 2)
    await page.mouse.down()
    if target is None:
        x, y = (a['x'] + a['width'] / 2 if to_x is None else to_x), to_y
    else:
        b = await target.bounding_box()
        x, y = (b['x'] + b['width'] / 2 if to_x is None else to_x), (b['y'] + b['height'] / 2 if to_y is None else to_y)
    await page.mouse.move(x, y, steps=steps)
    return x, y


async def pin_by_menu_and_move_by_keyboard(page, base):
    await open_app(page, base, bots=EXTRA_BOTS)
    await expect(page.locator('#sidebar .crow')).to_have_count(3)
    assert await row_names(page) == ['Researcher', 'Writer', 'Reviewer'], await row_names(page)
    # Right-click opens the options menu at the pointer; Pin puts the bot in the pinned row.
    await page.locator('#sidebar .crow', has_text='Writer').click(button='right')
    await expect(page.locator('#cmenu')).to_be_visible()
    assert 'Pin' in await page.locator('#cmenu [role=menuitem]').all_inner_texts()
    await page.locator('#cmenu [data-action="menu-pin"]').click()
    await expect(page.locator('#sidebar .pin', has_text='Writer')).to_have_count(1)
    assert await pin_names(page) == ['Atlas', 'Writer'], await pin_names(page)
    assert await row_names(page) == ['Researcher', 'Reviewer'], await row_names(page)
    # The menu key and Shift+F10 open it from the keyboard; Esc closes it and gives focus back.
    row = page.locator('#sidebar .crow', has_text='Researcher')
    await row.focus()
    await page.keyboard.press('ContextMenu')
    await expect(page.locator('#cmenu')).to_be_visible()
    await page.keyboard.press('Escape')
    await expect(page.locator('#cmenu')).to_have_count(0)
    await expect(row).to_be_focused()
    await page.keyboard.press('Shift+F10')
    await expect(page.locator('#cmenu')).to_be_visible()
    await page.keyboard.press('Escape')
    # Alt+ArrowDown moves the focused row down one place and keeps focus on it. It does not go Back.
    await page.keyboard.press('Alt+ArrowDown')
    await poll_equal(page, lambda: row_names(page), ['Reviewer', 'Researcher'])
    await expect(page.locator('#sidebar .crow', has_text='Researcher')).to_be_focused()
    assert await hash_(page) == '#bot/atlas', await hash_(page)
    # Alt+Left on a pinned face moves it left.
    await page.locator('#sidebar .pin', has_text='Writer').focus()
    await page.keyboard.press('Alt+ArrowLeft')
    await poll_equal(page, lambda: pin_names(page), ['Writer', 'Atlas'])
    # Saved per person under one key each, and still there after a reload.
    saved = await page.evaluate('() => [localStorage.getItem("ac-pins"), localStorage.getItem("ac-order")]')
    assert saved[0] and saved[1], saved
    await page.reload()
    await expect(page.locator('#sidebar .crow').first).to_be_visible()
    assert await pin_names(page) == ['Writer', 'Atlas'], await pin_names(page)
    assert await row_names(page) == ['Reviewer', 'Researcher'], await row_names(page)
    # Alt+ArrowDown on a pinned face unpins it, and Alt+ArrowUp on the first row pins it.
    await page.locator('#sidebar .pin', has_text='Writer').focus()
    await page.keyboard.press('Alt+ArrowDown')
    await poll_equal(page, lambda: pin_names(page), ['Atlas'])
    assert 'Writer' in await row_names(page)
    first = await row_names(page)
    await page.locator('#sidebar .crow', has_text=first[0]).focus()
    await page.keyboard.press('Alt+ArrowUp')
    await poll_equal(page, lambda: pin_names(page), ['Atlas', first[0]])


async def drag_to_pin_reorder_and_unpin(page, base):
    await open_app(page, base, bots=EXTRA_BOTS)
    await expect(page.locator('#sidebar .crow')).to_have_count(3)
    # A press and a move drags the whole row: it rides under the pointer and leaves an empty slot.
    shelf = page.locator('#sidebar .shelf')
    edge = (await shelf.bounding_box())
    x, y = await drag(page, page.locator('#sidebar .crow', has_text='Reviewer'), shelf, to_x=edge['x'] + edge['width'] - 20)
    await expect(page.locator('#sidebar .gest-ghost')).to_have_count(1)
    await expect(page.locator('#sidebar .gest-hole')).to_have_count(1)
    await expect(shelf).to_have_class(re.compile('drop-on'))
    ghost = await page.locator('#sidebar .gest-ghost').bounding_box()
    assert abs((ghost['x'] + ghost['width'] / 2) - x) < 90 and abs((ghost['y'] + ghost['height'] / 2) - y) < 90, (ghost, x, y)
    await page.mouse.up()
    await expect(page.locator('#sidebar .gest-ghost')).to_have_count(0)
    # Dropping on the pinned row pins it; the click that ends a drag does not open its chat.
    assert await pin_names(page) == ['Atlas', 'Reviewer'], await pin_names(page)
    assert await hash_(page) == '#bot/atlas', await hash_(page)
    # Drag a pinned face past its neighbour to reorder, then out of the row to unpin.
    faces = page.locator('#sidebar .pin')
    first = await faces.nth(0).bounding_box()
    await drag(page, faces.nth(1), None, to_y=first['y'] + first['height'] / 2, to_x=first['x'] + 6)
    await page.mouse.up()
    await poll_equal(page, lambda: pin_names(page), ['Reviewer', 'Atlas'])
    await drag(page, page.locator('#sidebar .pin', has_text='Reviewer'), page.locator('#sidebar .crow', has_text='Writer'))
    await expect(page.locator('#sidebar .gest-out')).to_have_count(1)
    await page.mouse.up()
    await poll_equal(page, lambda: pin_names(page), ['Atlas'])
    assert 'Reviewer' in await row_names(page)
    # Drag a row to the top of the list: it swaps once the pointer is past the middle of its neighbour.
    top = await page.locator('#sidebar .crow').first.bounding_box()
    last = await row_names(page)
    await drag(page, page.locator('#sidebar .crow', has_text=last[-1]), None, to_y=top['y'] + 18)
    await page.mouse.up()
    await poll_equal(page, lambda: row_names(page), [last[-1], *last[:-1]])
    # A plain click still opens the chat.
    await page.locator('#sidebar .crow', has_text='Researcher').click()
    await expect(page.locator('#main h1')).to_have_text('Researcher')
    # Esc cancels a drag: nothing changes and the row is back.
    before = await row_names(page)
    await drag(page, page.locator('#sidebar .crow', has_text='Reviewer'), page.locator('#sidebar .shelf'))
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await expect(page.locator('#sidebar .gest-ghost')).to_have_count(0)
    assert await pin_names(page) == ['Atlas'] and await row_names(page) == before


async def drag_onto_a_manager_moves_it_to_the_team(page, base):
    ids = await open_app(page, base, bots=EXTRA_BOTS)
    # Reviewer reports to Writer, so Writer is a manager and Researcher is dropped on its row.
    await page.evaluate("async ids => { await window.AGENT_API(`/api/groups/home/bots/${ids.Reviewer}`, 'PATCH', {settings: {reportsTo: ids.Writer}}); }", ids)
    await page.reload()
    await expect(page.locator('#sidebar .crow')).to_have_count(3)
    manager = page.locator('#sidebar .crow', has_text='Writer')
    await expect(manager).to_have_attribute('data-manager', 'true')
    assert await row_names(page) == ['Researcher', 'Writer', 'Reviewer'], await row_names(page)
    await drag(page, page.locator('#sidebar .crow', has_text='Researcher'), manager)
    await expect(manager).to_have_class(re.compile('drop-on'))
    await page.mouse.up()
    await expect(page.locator('#toast')).to_contain_text('Researcher now reports to Writer')
    assert company_bot(await api_state(page), 'Researcher')['settings']['reportsTo'] == ids['Writer']
    # A manager moves with its reports: Alt+ArrowDown on Writer has no team-mate to pass, so nothing changes.
    await manager.focus()
    await page.keyboard.press('Alt+ArrowDown')
    assert (await row_names(page))[0] == 'Writer', await row_names(page)


async def phone_long_press_menu_and_drag(page, base):
    await open_app(page, base, bots=EXTRA_BOTS)
    await expect(page.locator('#main .crow')).to_have_count(3)
    cdp = await page.context.new_cdp_session(page)

    async def touch(kind, x, y):
        await cdp.send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': [] if kind == 'touchEnd' else [{'x': x, 'y': y, 'id': 1}]})
    box = await page.locator('#main .crow', has_text='Writer').bounding_box()
    cx, cy = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
    # Touch and hold, then let go without moving: the options sheet comes up from the bottom.
    await touch('touchStart', cx, cy)
    await page.wait_for_timeout(700)
    await expect(page.locator('#main .crow.gest-armed')).to_have_count(1)
    await touch('touchEnd', cx, cy)
    await expect(page.locator('#cmenu.sheet')).to_be_visible()
    assert await hash_(page) in ('', '#chats'), await hash_(page)
    await page.keyboard.press('Escape')
    await expect(page.locator('#cmenu')).to_have_count(0)
    # A swipe with no hold scrolls the page and lifts nothing.
    await touch('touchStart', cx, cy)
    await touch('touchMove', cx, cy - 40)
    await touch('touchEnd', cx, cy - 40)
    await page.wait_for_timeout(500)
    await expect(page.locator('#main .gest-ghost')).to_have_count(0)
    # Touch and hold, then move: it lifts and follows the finger; dropping on the pinned row pins it.
    shelf = await page.locator('#main .shelf').bounding_box()
    goal = shelf['y'] + shelf['height'] / 2
    await touch('touchStart', cx, cy)
    await page.wait_for_timeout(700)
    right = shelf['x'] + shelf['width'] - 24
    for step in range(1, 13):
        await touch('touchMove', cx + (right - cx) * step / 12, cy + (goal - cy) * step / 12)
        await page.wait_for_timeout(16)
    await expect(page.locator('#main .gest-ghost')).to_have_count(1)
    await expect(page.locator('#main .shelf')).to_have_class(re.compile('drop-on'))
    await touch('touchEnd', right, goal)
    await poll_equal(page, lambda: pin_names(page, '#main'), ['Atlas', 'Writer'])
    assert await hash_(page) in ('', '#chats'), await hash_(page)


# ---------------------------------------------------------------- asks, permissions, activity and the pause banner

ASKS = [
    ['a1', 'send', '', 'send an email to Northwind'],
    ['a2', 'spend', '', 'pay £40 to Northwind Printing'],
    ['a3', 'post', '', 'post the draft to the company page'],
]


async def primary_id(page):
    state = await api_state(page)
    return next(b['id'] for g in state['groups'] for b in g['bots'] if b['settings'].get('lead'))


async def seed_asks(page, bot_id, asks=ASKS, name='Researcher'):
    """The demo's bots never ask, so put asks (and the chat lines that carry them) into the stored workspace, the way the server writes them."""
    primary = await primary_id(page)
    script = '''
        const [bot, primary, asks, name] = %s;
        const at = new Date().toISOString();
        s.asks = asks.map(([id, action, target, detail]) => ({id, botId: bot, runId: null, chatKey: bot, action, target, detail, grantScope: '', status: 'pending', scope: null, createdAt: at}));
        const line = (id, text) => ({id: 'ask-' + id, role: 'system', kind: 'ask', askId: id, text, at});
        s.chats[bot] = [...(s.chats[bot] || []), ...asks.map(([id, , , detail]) => line(id, name + ' wants to ' + detail + '.'))];
        s.chats[primary] = [...(s.chats[primary] || []), ...asks.map(([id, , , detail]) => line(id, 'Needs you: ' + name + ' wants to ' + detail + '.'))];
    ''' % json.dumps([bot_id, primary, asks, name])
    await patch_state(page, script)


async def ask_cards_answer_and_collapse(page, base):
    ids = await open_app(page, base, bots={'Researcher': EXTRA_BOTS['Researcher']})
    await seed_asks(page, ids['Researcher'])
    # Three things wait on the owner: the bot's row and Atlas's face both carry the count.
    row = page.locator('#sidebar .crow', has_text='Researcher')
    await expect(row.locator('.badge')).to_have_text('3')
    await expect(page.locator('#sidebar .pin', has_text='Atlas').locator('.badge')).to_have_text('3')
    await row.click()
    cards = page.locator('#cv-log .cv-card[data-ask]')
    await expect(cards).to_have_count(3)
    # One sentence, the three buttons in the owner's words, and the asking bot's face waiting above the card.
    first = page.locator('#cv-log .cv-card[data-ask="a1"]')
    await expect(first.locator('p')).to_have_text('Researcher wants to send an email to Northwind.')
    assert await first.locator('.btn').all_inner_texts() == ['Decline', 'Allow', 'Always allow for this bot']
    await expect(page.locator('#cv-log .cv-wait .face--waiting').first).to_be_visible()
    await expect(page.locator('#cv-log .cv-wait').first).to_contain_text('Researcher is waiting on you')
    # A payment is only ever Decline or Allow, and says so.
    spend = page.locator('#cv-log .cv-card[data-ask="a2"]')
    assert await spend.locator('.btn').all_inner_texts() == ['Decline', 'Allow']
    await expect(spend).to_contain_text('Payments are asked every time.')
    await expect(page.locator('#cv-line')).to_have_text('Waiting on you')
    # Allow once: the card collapses to one muted line and the count drops.
    await first.get_by_role('button', name='Allow', exact=True).click()
    await expect(page.locator('#cv-log .cv-asked[data-ask="a1"]')).to_have_text('You allowed it once')
    await expect(page.locator('#cv-log .cv-card[data-ask="a1"]')).to_have_count(0)
    await expect(row.locator('.badge')).to_have_text('2')
    state = await api_state(page)
    mine = {a['id']: a for a in state['asks']}
    assert mine['a1']['status'] == 'allowed' and mine['a1']['scope'] == 'once', mine['a1']
    assert not [g for g in state.get('grants', []) if g['action'] == 'send'], 'Allow once stores no grant'
    # Always allow: its own collapsed line, and the grant is kept for this bot.
    await page.locator('#cv-log .cv-card[data-ask="a3"]').get_by_role('button', name='Always allow for this bot').click()
    await expect(page.locator('#cv-log .cv-asked[data-ask="a3"]')).to_have_text('You always allow it for this bot')
    grants = [(g['botId'], g['action'], g['choice']) for g in (await api_state(page))['grants']]
    assert (ids['Researcher'], 'post', 'always') in grants, grants
    # Decline.
    await spend.get_by_role('button', name='Decline').click()
    await expect(page.locator('#cv-log .cv-asked[data-ask="a2"]')).to_have_text('You declined it')
    # Nothing is left to ask: no card, no badge, no second ask.
    await expect(page.locator('#cv-log .cv-card[data-ask]')).to_have_count(0)
    await expect(row.locator('.badge')).to_have_count(0)
    await expect(page.locator('#cv-line')).not_to_have_text('Waiting on you')
    # Atlas's copy of each card collapsed the same way, and says whose it was.
    await page.locator('#sidebar .pin', has_text='Atlas').click()
    await expect(page.locator('#cv-log .cv-asked')).to_have_count(3)
    texts = await page.locator('#cv-log .cv-asked').all_inner_texts()
    assert 'You allowed it once (Researcher)' in texts and 'You always allow it for this bot (Researcher)' in texts, texts
    # The Always allow is a rule on the profile.
    await page.goto(f'{base}/index.html#profile/{ids["Researcher"]}/permissions')
    await page.reload()
    await expect(page.locator('#main .gr', has_text='Post').locator('button[aria-pressed="true"]')).to_have_text('Always allow')


async def permissions_edit_in_place_and_deny(page, base):
    ids = await open_app(page, base, bots={'Researcher': EXTRA_BOTS['Researcher'], 'Writer': EXTRA_BOTS['Writer']})
    r, w = ids['Researcher'], ids['Writer']
    grants = [[r, 'browser.use', 'https://example.com', 'always'], [r, 'spend', '', 'ask'], [r, 'send', '', 'always'], [w, 'post', '', 'ask']]
    await patch_state(page, 's.grants = %s.map(([botId, action, scope, choice]) => ({botId, action, scope, choice, at: new Date().toISOString()}));' % json.dumps(grants))
    await page.goto(f'{base}/index.html#profile/{r}')
    await page.reload()
    await expect(page.locator('#main .rw', has_text='Permissions').locator('.pv')).to_have_text('3 rules')
    await page.locator('#main .rw', has_text='Permissions').click()
    rows = page.locator('#main .gr')
    await expect(rows).to_have_count(3)
    assert [t.split('\n')[0] for t in await rows.all_inner_texts()] == ['Open example.com', 'Send', 'Spend money']
    # Every rule has the three choices; a payment never has Always allow.
    assert await rows.nth(0).locator('button').all_inner_texts() == ['Always allow', 'Ask each time', 'Deny']
    assert await rows.nth(2).locator('button').all_inner_texts() == ['Ask each time', 'Deny']
    await expect(rows.nth(0).locator('button[aria-pressed="true"]')).to_have_text('Always allow')
    # Edited in place: Deny, and the profile shows it at once.
    await rows.nth(0).get_by_role('button', name='Deny').click()
    await expect(page.locator('#main .gr').nth(0).locator('button[aria-pressed="true"]')).to_have_text('Deny')
    await expect(page.locator('#toast')).to_contain_text('Researcher: deny.')
    assert [g for g in (await api_state(page))['grants'] if g['action'] == 'browser.use'][0]['choice'] == 'deny'
    # A payment can be set to Deny but never to Always allow: there is no button, and the server refuses it too.
    await page.locator('#main .gr').nth(2).get_by_role('button', name='Deny').click()
    await expect(page.locator('#main .gr').nth(2).locator('button[aria-pressed="true"]')).to_have_text('Deny')
    refused = await page.evaluate('''botId => window.AGENT_API('/api/grants', 'POST', {botId, action: 'spend', choice: 'always'}).then(() => 'accepted', e => e.message)''', r)
    assert refused != 'accepted', refused
    # Settings lists the rules of every bot, one card each, and edits them in place.
    await page.goto(f'{base}/index.html#settings/perm')
    await page.reload()
    dlg = page.locator('.st-dlg')
    await expect(dlg.locator('.st-h', has_text='Researcher')).to_be_visible()
    await expect(dlg.locator('.st-h', has_text='Writer')).to_be_visible()
    await expect(dlg.locator('.gr')).to_have_count(4)
    await dlg.locator('.gr', has_text='Post').get_by_role('button', name='Always allow').click()
    await expect(dlg.locator('.gr', has_text='Post').locator('button[aria-pressed="true"]')).to_have_text('Always allow')
    # The log keeps the changes under Permissions; Left the app does not show them.
    await page.goto(f'{base}/index.html#activity')
    await page.reload()
    chips = page.locator('#main .ay-chips button')
    await expect(chips).to_have_text(['Left the app', 'Permissions', 'Bots', 'All'])
    await chips.nth(1).click()
    await expect(page.locator('#ay-list .ay-row', has_text='not allowed to open example.com')).to_have_count(1)
    await chips.nth(0).click()
    await expect(page.locator('#ay-list .ay-row')).to_have_count(0)


async def pause_banner_and_resume(page, base):
    await open_app(page, base)
    banner = page.locator('#pause')
    await expect(banner).to_be_hidden()
    await page.locator('#sidebar [data-action="open-settings"]').click()
    await page.locator('.st-dlg [data-pause]').click()
    await expect(banner).to_be_visible()
    await expect(banner.locator('.pause-t')).to_have_text('All bots are paused. Nothing runs until you resume.')
    assert (await api_state(page))['guard']['paused'] is True
    await page.keyboard.press('Escape')
    # The bar sits above the app, and the app sits under it (after its slide in).
    await page.wait_for_timeout(450)
    box, shell = await banner.bounding_box(), await page.locator('#main').bounding_box()
    assert box['y'] == 0 and shell['y'] >= box['height'] - 1, (box, shell)
    await page.reload()
    await expect(banner).to_be_visible()
    await page.locator('#sidebar .crow, #sidebar .pin').first.click()
    await expect(banner).to_be_visible()
    # Resume lifts it.
    await banner.get_by_role('button', name='Resume').click()
    await expect(banner).to_be_hidden()
    await expect(page.locator('#toast')).to_contain_text('Bots are running again.')
    assert (await api_state(page))['guard']['paused'] is False
    assert (await page.locator('#main').bounding_box())['y'] == 0


async def phone_ask_card_permissions_and_pause(page, base):
    ids = await open_app(page, base, bots={'Researcher': EXTRA_BOTS['Researcher']})
    await seed_asks(page, ids['Researcher'], asks=ASKS[:2])
    await page.goto(f'{base}/index.html#bot/{ids["Researcher"]}')
    await page.reload()
    await expect(page.locator('#cv-log .cv-card[data-ask]')).to_have_count(2)
    assert await overflow(page) <= 0, await overflow(page)
    buttons = page.locator('#cv-log .cv-card[data-ask="a1"] .btn')
    for i in range(3):
        box = await buttons.nth(i).bounding_box()
        assert box['height'] >= 40 and box['x'] >= 0 and box['x'] + box['width'] <= 390, box
    await page.locator('#cv-log .cv-card[data-ask="a1"]').get_by_role('button', name='Always allow for this bot').click()
    await expect(page.locator('#cv-log .cv-asked[data-ask="a1"]')).to_have_text('You always allow it for this bot')
    # Permissions on a phone: full-width choices a thumb can hit.
    await page.goto(f'{base}/index.html#profile/{ids["Researcher"]}/permissions')
    await page.reload()
    row = page.locator('#main .gr').first
    await expect(row.locator('button[aria-pressed="true"]')).to_have_text('Always allow')
    for i in range(3):
        box = await row.locator('button').nth(i).bounding_box()
        assert box['height'] >= 40 and box['x'] + box['width'] <= 390, box
    await row.get_by_role('button', name='Deny').click()
    await expect(page.locator('#main .gr').first.locator('button[aria-pressed="true"]')).to_have_text('Deny')
    assert await overflow(page) <= 0
    # The pause banner sits above the phone chrome, and Resume is a thumb-sized button.
    await page.evaluate('() => window.AGENT_API("/api/guard", "POST", {paused: true})')
    await page.goto(f'{base}/index.html#chats')
    await page.reload()
    banner = page.locator('#pause')
    await expect(banner).to_be_visible()
    box, me = await banner.bounding_box(), await page.locator('.ch-me').bounding_box()
    assert me['y'] >= box['y'] + box['height'], (box, me)
    go = await banner.get_by_role('button', name='Resume').bounding_box()
    assert go['height'] >= 34 and go['x'] + go['width'] <= 390, go
    assert await overflow(page) <= 0
    await banner.get_by_role('button', name='Resume').click()
    await expect(banner).to_be_hidden()


# ---------------------------------------------------------------- the Computer view

def page_picture(hot=0, w=1280, h=800):
    """A 1280x800 stand-in for a mail page, as a PNG data URL (the real device sends JPEG): a header band
    and five rows, one of them highlighted. Built per band, so it takes milliseconds."""
    import base64
    import struct
    import zlib

    def band(segments, fill):
        row = bytearray(bytes(fill) * w)
        for x0, x1, colour in segments:
            row[x0 * 3:x1 * 3] = bytes(colour) * (x1 - x0)
        return b'\x00' + bytes(row)

    paper, line, ink, mint = (251, 250, 248), (236, 234, 228), (200, 198, 192), (190, 232, 214)
    plain = band([], paper)
    head = band([], (34, 38, 43))
    tops = [120 + 110 * i for i in range(5)]
    bars = []
    for i in range(5):
        fill = mint if i == hot else paper
        long_row = band([(60, 100, (106, 75, 214)), (130, 130 + 360 - i * 30, ink), (130, 130 + 640 - i * 60, line)], fill)
        short_row = band([(130, 130 + 520 - i * 40, ink)], fill)
        bars.append((long_row, short_row))
    raw = bytearray()
    for y in range(h):
        if y < 80:
            raw += head
            continue
        for i, top in enumerate(tops):
            if top <= y < top + 90:
                raw += bars[i][0] if (y - top) % 44 < 22 else bars[i][1]
                break
        else:
            raw += plain

    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(bytes(raw), 6)) + chunk(b'IEND', b'')
    return 'data:image/png;base64,' + base64.b64encode(png).decode()


async def eventually(check, timeout=6.0):
    """Wait until `check()` (a plain value or an awaitable) is true. Python's expect has no poll."""
    end = asyncio.get_event_loop().time() + timeout
    while True:
        value = check()
        if hasattr(value, '__await__'):
            value = await value
        if value:
            return
        assert asyncio.get_event_loop().time() < end, 'the condition never held'
        await asyncio.sleep(0.05)


class Live:
    """A stand-in for the device and the routes /api/browser-live*, answered through page.route.
    The page's own transport is pointed at fetch for those paths (see route_live)."""

    def __init__(self, bot, **kw):
        self.bot, self.agent, self.state, self.seq, self.hot = bot, True, 'browsing', 1, 0
        self.url, self.title, self.notice = 'https://mail.google.com/mail/u/0/#inbox', 'Inbox', None
        self.pages = [
            {'url': 'https://mail.google.com/mail/u/0/#inbox', 'title': 'Inbox', 'at': '2026-11-11T10:00:00.000Z'},
            {'url': 'https://mail.google.com/mail/u/0/#inbox/northwind', 'title': 'Northwind: a time next week?', 'at': '2026-11-11T10:01:00.000Z'},
            {'url': 'https://calendar.google.com/calendar/r/week', 'title': None, 'at': '2026-11-11T10:02:00.000Z'},
        ]
        self.posts, self.frame_polls, self.list_polls = [], 0, 0
        self.__dict__.update(kw)

    def entry(self):
        site = None if self.state == 'idle' else re.sub(r'^https?://([^/]+).*$', r'\1', self.url or '') or None
        return {'botId': self.bot, 'state': self.state, 'url': self.url, 'title': self.title, 'site': site, 'pages': self.pages,
                'runId': None, 'requestId': None, 'live': self.agent}

    def inputs(self):
        return [body for path, body in self.posts if path.endswith('/input')]

    async def handle(self, route):
        request = route.request
        path = re.sub(r'^https?://[^/]+', '', request.url).split('?')[0]
        method, body = request.method, (json.loads(request.post_data) if request.post_data else None)

        async def reply(data, status=200):
            await route.fulfill(status=status, content_type='application/json', body=json.dumps(data))
        if path == '/api/browser-live' and method == 'GET':
            self.list_polls += 1
            return await reply([self.entry()])
        if path == f'/api/browser-live/{self.bot}' and method == 'GET':
            self.frame_polls += 1
            after = int(re.search(r'after=(\d+)', request.url).group(1)) if 'after=' in request.url else 0
            out = {'botId': self.bot, 'agent': self.agent, 'seq': self.seq if self.agent else 0, 'changed': self.agent and after != self.seq,
                   'state': self.state, 'url': self.url, 'title': self.title, 'site': self.entry()['site']}
            if self.agent:
                out.update(w=1280, h=800, at=1)
                if out['changed']:
                    out['image'] = page_picture(self.hot)
            if self.notice:
                out['notice'] = self.notice
            return await reply(out)
        self.posts.append((path, body))
        if path == f'/api/browser-live/{self.bot}/takeover':
            if not self.agent:
                return await reply({'error': 'The local agent is not running the shared browser right now, so there is nothing to take over. Start it with AGENT_BROWSER=1 and try again.'}, 409)
            self.state = 'driving'
            return await reply({'botId': self.bot, 'state': 'driving'})
        if path == f'/api/browser-live/{self.bot}/handback':
            self.state = 'browsing'
            return await reply({'botId': self.bot, 'state': 'browsing'})
        if path == f'/api/browser-live/{self.bot}/input':
            if self.state != 'driving':
                return await reply({'error': 'Take over the browser before you click or type in it.'}, 409)
            return await reply({'ok': True})
        return await reply({'error': 'unexpected'}, 404)


VIA_FETCH = """(() => {
    let real;
    const viaFetch = (path, method, body) => {
        const verb = method || 'GET', options = {method: verb, headers: {'Content-Type': 'application/json'}};
        if (body !== undefined && verb !== 'GET') options.body = JSON.stringify(body);
        return fetch(path, options).then(async r => {
            const data = await r.json().catch(() => ({}));
            if (!r.ok) throw Object.assign(new Error(data.error || 'HTTP ' + r.status), {status: r.status});
            return data;
        });
    };
    Object.defineProperty(window, 'AGENT_API', {configurable: true,
        get: () => (path, method, body) => String(path).startsWith('/api/browser-live') ? viaFetch(path, method, body) : real(path, method, body),
        set: v => { real = v; }});
})()"""


async def route_live(page, live):
    """Answer /api/browser-live* from `live`. The static build's transport is the browser-local one, so
    those paths are pointed at fetch (which page.route answers) before any page script runs; every other
    path still goes to the demo."""
    await page.add_init_script(VIA_FETCH)
    await page.route('**/api/browser-live**', live.handle)


async def open_computer(page, base, name='Writer', **kw):
    """The company with one extra bot and the stub installed. Returns the stub and the bot's id."""
    live = Live(None, **kw)
    await route_live(page, live)
    ids = await open_app(page, base, bots={name: EXTRA_BOTS[name]})
    live.bot = ids[name]
    return live, ids[name]


async def goto_profile(page, bot, sub=''):
    await page.locator(f'#sidebar .crow[data-id="{bot}"]').click()
    await page.locator('#main .cv-who').click()
    await expect(page.locator('#main .pr-hero')).to_be_visible()
    if sub:
        await page.locator('#main .rw', has_text='Computer').click()
        assert await hash_(page) == f'#profile/{bot}/{sub}', await hash_(page)


async def computer_row_frame_and_pages(page, base):
    live, bot = await open_computer(page, base)
    await goto_profile(page, bot)
    # The row reads the list: Browsing, from the stub (it said Idle before the first poll).
    row = page.locator('#main .rw', has_text='Computer')
    await expect(row.locator('[data-computer-row]')).to_have_text('Browsing')
    await row.click()
    assert await hash_(page) == f'#profile/{bot}/computer', await hash_(page)
    await expect(page.locator('#main .pr-subbar h1')).to_have_text('Computer')
    # A frame arrives, with the address and the line under it.
    img = page.locator('#main .pc-img')
    await expect(img).to_be_visible()
    assert (await img.get_attribute('src')).startswith('data:image/png;base64,')
    assert await img.evaluate('i => i.naturalWidth') == 1280
    await expect(page.locator('#main .pc-url')).to_have_value('https://mail.google.com/mail/u/0/#inbox')
    await expect(page.locator('#main .pc-url')).to_have_js_property('readOnly', True)
    await expect(page.locator('#main .pc-line')).to_have_text('Writer is on Inbox')
    await expect(page.locator('#main .pc-dot')).to_have_class(re.compile('live'))
    # This run's pages: a title, else the host, with the host beside it.
    await expect(page.locator('#main .pc-h')).to_have_text('This run')
    await expect(page.locator('#main .pc-trail li')).to_have_count(3)
    await expect(page.locator('#main .pc-trail li').nth(1)).to_contain_text('Northwind: a time next week?')
    await expect(page.locator('#main .pc-trail li').nth(2)).to_have_text('calendar.google.com')
    await expect(page.locator('#main [data-action="computer-takeover"]')).to_have_text('Take over')
    await expect(page.locator('#main')).to_contain_text('Sending, posting, deleting and paying still ask you first.')
    # The poll asks for what is new: a second frame replaces the picture.
    first = await img.get_attribute('src')
    live.seq, live.hot = 2, 3
    await eventually(lambda: img.evaluate('(i, f) => i.getAttribute("src") !== f', first))
    # Idle dims the picture and the line says when it was last used; the pages become the last run's.
    live.state = 'idle'
    await expect(page.locator('#main .pc-line')).to_contain_text('Idle · last used')
    await expect(page.locator('#main .pc-h')).to_have_text('Last run')
    await expect(page.locator('#main .pc-screen')).to_have_class(re.compile('idle'))
    # Leaving the view stops the poll: the device only casts while somebody looks.
    await page.locator('#main [data-action="profile-up"]').click()
    await page.wait_for_timeout(500)
    seen = live.frame_polls
    await page.wait_for_timeout(1200)
    assert live.frame_polls == seen, (seen, live.frame_polls)
    await expect(page.locator('#main .rw', has_text='Computer').locator('[data-computer-row]')).to_have_text('Idle', timeout=8000)


async def computer_take_over_drives_the_page(page, base):
    live, bot = await open_computer(page, base)
    await goto_profile(page, bot, 'computer')
    await expect(page.locator('#main .pc-img')).to_be_visible()
    stage = page.locator('#main .pc-screen')
    # Before Take over a click on the picture does nothing but say what to press.
    await page.locator('#main .pc-img').click()
    await expect(page.locator('#toast')).to_contain_text('Press Take over')
    assert live.inputs() == []
    await page.locator('#main [data-action="computer-takeover"]').click()
    await expect(page.locator('#main [data-action="computer-handback"]')).to_have_text('Hand back')
    assert any(path.endswith('/takeover') for path, _ in live.posts)
    await expect(page.locator('#main .pc-line')).to_have_text('You have the browser')
    await expect(page.locator('#main .pc-dot')).to_have_class(re.compile('you'))
    await expect(stage).to_be_focused()
    # A click goes in 1280x800 page pixels: the middle of the picture is (640, 400).
    box = await page.locator('#main .pc-img').bounding_box()
    await page.mouse.click(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
    await eventually(lambda: len([e for e in live.inputs() if e['type'] == 'click']) == 1)
    click = [e for e in live.inputs() if e['type'] == 'click'][0]
    assert abs(click['x'] - 640) <= 2 and abs(click['y'] - 400) <= 2, click
    await page.mouse.click(box['x'] + 1, box['y'] + 1)
    await eventually(lambda: len([e for e in live.inputs() if e['type'] == 'click']) == 2)
    corner = [e for e in live.inputs() if e['type'] == 'click'][1]
    assert corner['x'] <= 4 and corner['y'] <= 4, corner
    # Keys: letters are typed (joined), named keys are pressed, and Esc goes to the page, not out of the view.
    await page.keyboard.type('hi there')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Escape')
    await eventually(lambda: [e for e in live.inputs() if e['type'] in ('type', 'key')][-1:] == [{'type': 'key', 'key': 'Escape'}])
    typed = ''.join(e['text'] for e in live.inputs() if e['type'] == 'type')
    assert typed == 'hi there', typed
    assert {'type': 'key', 'key': 'Enter'} in live.inputs()
    assert await hash_(page) == f'#profile/{bot}/computer', await hash_(page)
    # '/' and 't' are the app's search shortcuts everywhere else; here they are typed into the page.
    await page.keyboard.type('t/')
    await eventually(lambda: ''.join(e['text'] for e in live.inputs() if e['type'] == 'type') == 'hi theret/')
    assert not await page.evaluate("!!document.activeElement.closest('#sidebar, #chrome')")
    # The wheel scrolls the page, and the page itself stays put.
    await page.mouse.move(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
    await page.mouse.wheel(0, 100)
    await eventually(lambda: any(e['type'] == 'scroll' for e in live.inputs()))
    scroll = [e for e in live.inputs() if e['type'] == 'scroll'][0]
    assert scroll['dy'] > 100 and abs(scroll['x'] - 640) <= 2, scroll
    # The address field takes a URL; Go (or Enter) sends it.
    url = page.locator('#main .pc-url')
    await expect(url).to_have_js_property('readOnly', False)
    await url.fill('example.com')
    await page.locator('#main .pc-go').click()
    await eventually(lambda: [e for e in live.inputs() if e['type'] == 'navigate'] == [{'type': 'navigate', 'url': 'https://example.com/'}])
    # After Go the keys go back to the page; an address that is not a web address is refused in a toast.
    await expect(stage).to_be_focused()
    await url.fill('two words')
    await url.press('Enter')
    await expect(page.locator('#toast')).to_contain_text('Type a web address')
    # Phones have no keyboard on the picture: a field and key buttons send the same events.
    await page.locator('#main .pc-type input').fill('abc')
    await page.locator('#main .pc-type button').click()
    await page.locator('#main .pc-key[data-text="Tab"]').click()
    await eventually(lambda: {'type': 'key', 'key': 'Tab'} in live.inputs())
    assert ''.join(e['text'] for e in live.inputs() if e['type'] == 'type').endswith('abc')


async def computer_hand_back(page, base):
    live, bot = await open_computer(page, base)
    await goto_profile(page, bot, 'computer')
    await page.locator('#main [data-action="computer-takeover"]').click()
    await expect(page.locator('#main .pc-tools')).to_be_visible()
    await page.locator('#main [data-action="computer-handback"]').click()
    await expect(page.locator('#main [data-action="computer-takeover"]')).to_have_text('Take over')
    assert live.posts[-1][0].endswith('/handback')
    await expect(page.locator('#toast')).to_contain_text('Writer has the browser back')
    await expect(page.locator('#main .pc-tools')).to_be_hidden()
    await expect(page.locator('#main .pc-line')).to_have_text('Writer is on Inbox')
    await expect(page.locator('#main .pc-url')).to_have_js_property('readOnly', True)
    # Nothing is sent once the bot has it: a click on the picture sends no input.
    before = len(live.inputs())
    await page.locator('#main .pc-img').click()
    assert len(live.inputs()) == before
    # Esc is the app's again: it leaves the view for the profile, where the row says Browsing.
    await page.locator('#main .pc-screen').evaluate('n => n.blur()')
    await page.keyboard.press('Escape')
    await expect(page.locator('#main .pr-hero')).to_be_visible()
    await expect(page.locator('#main .rw', has_text='Computer').locator('[data-computer-row]')).to_have_text('Browsing')


async def computer_no_device_empty_state(page, base):
    live, bot = await open_computer(page, base, agent=False, state='idle', pages=[])
    await goto_profile(page, bot, 'computer')
    veil = page.locator('#main .pc-veil')
    await expect(veil).to_be_visible()
    await expect(veil).to_contain_text('No device is running the shared browser')
    await expect(veil).to_contain_text('AGENT_BROWSER=1')
    await expect(veil.locator('code')).to_have_text('AGENT_BROWSER=1 node agent/agent.mjs run')
    await expect(page.locator('#main .pc-img')).to_be_hidden()
    await expect(page.locator('#main .pc-line')).to_have_text('No browser running')
    # Take over says why it cannot.
    await page.locator('#main [data-action="computer-takeover"]').click()
    await expect(page.locator('#toast')).to_contain_text('Start it with AGENT_BROWSER=1')
    await expect(page.locator('#main [data-action="computer-takeover"]')).to_be_visible()
    # A notice from the device is shown as it came, and once the agent starts the poll finds it.
    live.notice = 'The takeover could not start: no Chrome found.'
    await expect(page.locator('#main .pc-notice')).to_have_text('The takeover could not start: no Chrome found.', timeout=8000)
    live.notice, live.agent, live.state = None, True, 'browsing'
    await expect(page.locator('#main .pc-img')).to_be_visible(timeout=8000)
    await expect(veil).to_be_hidden()
    await expect(page.locator('#main .pc-notice')).to_be_hidden()


async def computer_demo_has_no_browser(page, base):
    ids = await open_app(page, base, bots={'Writer': EXTRA_BOTS['Writer']})
    await page.goto(f'{base}/index.html#profile/{ids["Writer"]}/computer')
    await page.reload()
    await expect(page.locator('#main .pr-subbar h1')).to_have_text('Computer')
    veil = page.locator('#main .pc-veil')
    await expect(veil).to_contain_text('The demo has no browser')
    await expect(veil).to_contain_text('local agent')
    await expect(page.locator('#main .pc-line')).to_have_text('No browser in the demo')
    await expect(page.locator('#main [data-action="computer-takeover"]')).to_be_hidden()
    await expect(page.locator('#main .pc-img')).to_be_hidden()
    # Atlas has no Computer row, and no page behind it.
    await page.goto(f'{base}/index.html#profile/{PRIMARY}')
    await page.reload()
    await expect(page.locator('#main .pr-hero h1')).to_have_text('Atlas')
    await expect(page.locator('#main .rw', has_text='Computer')).to_have_count(0)
    await page.goto(f'{base}/index.html#profile/{PRIMARY}/computer')
    await page.reload()
    await expect(page.locator('#main .pr-hero h1')).to_have_text('Atlas')


async def computer_site_chip_on_the_pill(page, base):
    live, bot = await open_computer(page, base)
    await patch_state(page, f'''
        const at = new Date().toISOString();
        s.chats[{bot!r}] = [{{id: 'c1', role: 'user', text: 'Check my mail', at}}];
        s.groupRuns.unshift({{id: 'run-web', groupId: 'home', chatKey: {bot!r}, status: 'running', recipients: [{bot!r}], currentStep: 0, trace: [], createdAt: at}});
        s.browserRequests = [{{id: 'br9', botId: {bot!r}, botName: 'Writer', groupId: 'home', runId: 'run-web', chatKey: {bot!r}, status: 'dispatched', url: 'https://mail.google.com/mail/u/0/#inbox', steps: [], createdAt: at, updatedAt: at}}];''')
    await page.goto(f'{base}/index.html#bot/{bot}')
    await page.reload()
    chip = page.locator('#cv-log .cv-live .pchip')
    await expect(chip).to_be_visible()
    await expect(chip).to_have_text('mail.google.com')
    await expect(chip).to_have_attribute('aria-label', "Watch Writer's browser, on mail.google.com")
    # It opens that bot's live view.
    await chip.click()
    assert await hash_(page) == f'#profile/{bot}/computer', await hash_(page)
    await expect(page.locator('#main .pc-img')).to_be_visible()
    # While you hold the browser the line says so, and the chip stays.
    await page.locator('#main [data-action="computer-takeover"]').click()
    await page.go_back()
    await expect(page.locator('#cv-log .cv-live .cv-cur')).to_have_text('You are driving')
    await expect(page.locator('#cv-log .cv-live .pchip')).to_have_text('mail.google.com')
    # A finished request has no chip.
    await patch_state(page, "s.browserRequests.forEach(r => { r.status = 'done'; });")
    await expect(page.locator('#cv-log .pchip')).to_have_count(0)


async def phone_computer_view(page, base):
    live, bot = await open_computer(page, base)
    await page.goto(f'{base}/index.html#profile/{bot}/computer')
    await page.reload()
    await expect(page.locator('#main .pc-img')).to_be_visible()
    box = await page.locator('#main .pc-win').bounding_box()
    assert box['x'] >= 0 and box['x'] + box['width'] <= 390, box
    assert await overflow(page) <= 0, await overflow(page)
    take = await page.locator('#main [data-action="computer-takeover"]').bounding_box()
    assert take['height'] >= 36, take
    await page.locator('#main [data-action="computer-takeover"]').click()
    await expect(page.locator('#main .pc-tools')).to_be_visible()
    assert await overflow(page) <= 0, await overflow(page)
    for key in await page.locator('#main .pc-key').all():
        k = await key.bounding_box()
        assert k['height'] >= 40 and k['x'] >= 0 and k['x'] + k['width'] <= 390, k
    # A tap on the picture is a click on the page.
    img = await page.locator('#main .pc-img').bounding_box()
    await page.mouse.click(img['x'] + img['width'] / 2, img['y'] + img['height'] / 2)
    await eventually(lambda: len([e for e in live.inputs() if e['type'] == 'click']) == 1)


async def main():
    shots = Path(tempfile.mkdtemp(prefix='usability-smoke-shots-'))
    site_dir = Path(tempfile.mkdtemp(prefix='usability-smoke-site-'))
    try:
        server = serve(build_site(site_dir))
        base = f'http://127.0.0.1:{server.server_address[1]}'
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True, args=['--no-sandbox'])
            h = Harness(browser, base, shots)
            print(f'Usability smoke against {base}')
            await h.scenario('bot: create from the New bot page and land in its chat', create_bot_from_page)
            await h.scenario('bot: edit renames it and a menu move puts it under a manager', edit_rename_and_move)
            await h.scenario('bot: delete asks first, and its reports go Solo', delete_bot_reports_go_solo)
            await h.scenario('bot: Atlas has no Delete or Hide; pin from the menu', atlas_has_no_delete)
            await h.scenario('pin: the menu pins, the menu key opens it, Alt+arrows reorder and it is saved', pin_by_menu_and_move_by_keyboard)
            await h.scenario('pin: drag a row to the pinned row, reorder faces, drag one out, reorder rows, Esc cancels', drag_to_pin_reorder_and_unpin)
            await h.scenario('pin: dropping on a manager moves the bot to its team', drag_onto_a_manager_moves_it_to_the_team)
            await h.scenario('asks: the card, Allow once, Always allow, Decline, and what is left', ask_cards_answer_and_collapse)
            await h.scenario('permissions: edit a rule in place, Deny shows, payments never Always allow, the activity chips', permissions_edit_in_place_and_deny)
            await h.scenario('pause: the banner says so on every screen and Resume lifts it', pause_banner_and_resume)
            await h.scenario('settings: opens from the avatar, Bots running pauses, Esc closes', settings_from_avatar_and_esc)
            await h.scenario('activity: four chips, bots made are logged, a profile counts its own', activity_page_and_counts)
            await h.scenario('out-of-job reply: three buttons, each does its thing', out_of_job_card)
            await h.scenario('checkpoint card and page ask: the waiting face sits above', checkpoint_and_ask_cards)
            await h.scenario('faces: hello hop, one hop per first reply, awake and asleep', faces_come_alive)
            await h.scenario('keyboard: Tab, Enter, Ctrl+K and Esc in the sidebar', keyboard_and_escape)
            await h.scenario('phone: create a bot from the + button', phone_create_bot, PHONE)
            await h.scenario('phone: bottom search opens on focus and closes on Esc or a tap', phone_search_and_escape, PHONE)
            await h.scenario('phone: Settings cards, a section, Back, Esc, and the menu sheet', phone_settings_cards, PHONE)
            await h.scenario('phone: ask card, permissions and the pause banner', phone_ask_card_permissions_and_pause, PHONE)
            await h.scenario('phone: long press opens the options sheet; hold and drag pins', phone_long_press_menu_and_drag, PHONE)
            await h.scenario('computer: the row says Browsing, the view shows a frame and the pages of the run', computer_row_frame_and_pages)
            await h.scenario('computer: Take over sends clicks, keys, the wheel and an address to the page', computer_take_over_drives_the_page)
            await h.scenario('computer: Hand back returns the browser to the bot', computer_hand_back)
            await h.scenario('computer: no device shows how to start the local agent, and notices', computer_no_device_empty_state)
            await h.scenario('computer: the demo has no browser, and Atlas has no Computer row', computer_demo_has_no_browser)
            await h.scenario('computer: the pill carries the site chip, opens the view and says You are driving', computer_site_chip_on_the_pill)
            await h.scenario('phone: the Computer view fits and its controls are thumb-sized', phone_computer_view, PHONE)
            await browser.close()
            server.shutdown()
        failed = [name for name, error in h.results if error]
        if failed:
            print(f'USABILITY SMOKE FAIL: {len(failed)} of {len(h.results)} scenarios: {failed}')
            return 1
        print(f'USABILITY SMOKE PASS: {len(h.results)} scenarios; new bot, edit and move, delete, Atlas, pin and reorder, ask cards, permissions, pause banner, settings, out-of-job card, checkpoint card, faces, keyboard, phone, Computer view (row, frame, takeover input, hand back, no device, demo, site chip), no console errors')
        return 0
    finally:
        shutil.rmtree(site_dir, ignore_errors=True)


sys.exit(asyncio.run(main()))
