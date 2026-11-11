"""Browser smoke test for the chat-first UI: layout, navigation and responsiveness.

Drives the real generated static build (the same files GitHub Pages serves), not
a concatenated copy. The script rebuilds the bundle from `shared/` into a temp
directory (so it never touches `docs/` and never tests a stale build), serves it
from a local http.server on a free port and opens every scenario in a fresh
browser context so localStorage always starts empty.

Run: python3 tests/polish_smoke.py   (screenshots of failures land in a temp dir)
No network and no credentials.
"""
import asyncio
import http.server
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
TEAM = 'team-home'
PRIMARY = 'atlas'
# The starting workspace is one group (Home) with one bot (Atlas). Scenarios that
# need a team create the extra bots through the app's own API first.
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
    return 'frame-ancestors' in msg.text or 'favicon' in url


class Harness:
    def __init__(self, browser, base, shots):
        self.browser, self.base, self.shots = browser, base, shots
        self.results = []

    async def scenario(self, name, fn, viewport=DESKTOP):
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


async def open_app(page, base, hash_='', bots=None):
    """Open the app; with `bots` ({name: instructions}) first add them to Home through the
    app's own local API, reload so the UI reads them, and return {name: bot id}."""
    await page.goto(f'{base}/index.html{hash_}')
    await page.locator('.chat-row').first.wait_for()
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
    await page.locator('.chat-row').first.wait_for()
    return ids


async def overflow(page):
    return await page.evaluate('() => document.documentElement.scrollWidth - innerWidth')


async def hash_(page):
    return await page.evaluate('location.hash')


# ---------------------------------------------------------------- scenarios

async def first_run(page, base):
    await open_app(page, base)
    # Seed: the Home group plus its primary bot, in natural order, no unread work yet.
    ids = await page.locator('.chat-row').evaluate_all('rows => rows.map(r => r.dataset.id)')
    assert ids == [TEAM, PRIMARY], ids
    await expect(page.locator('#sidebar .list-head h1')).to_have_text('Chats')
    await expect(page.locator('#sidebar .backend')).to_contain_text('Browser-only')
    await expect(page.locator('.chat-row .badge')).to_have_count(0)
    # Desktop home pane invites a first message.
    await expect(page.locator('#main h1')).to_have_text('What should your bots work on?')
    # Filters.
    await page.locator('[data-action="list-filter"][data-filter="groups"]').click()
    await expect(page.locator('.chat-row')).to_have_count(1)
    await page.locator('[data-action="list-filter"][data-filter="bots"]').click()
    await expect(page.locator('.chat-row')).to_have_count(1)
    await expect(page.locator('.chat-row')).to_have_attribute('data-id', PRIMARY)
    await page.locator('[data-action="list-filter"][data-filter="needs"]').click()
    await expect(page.locator('#chat-list .empty')).to_contain_text('Nothing is waiting on you')
    await page.locator('[data-action="list-filter"][data-filter="all"]').click()
    # Search narrows by name and says so when nothing matches.
    await page.locator('#chat-search').fill('atl')
    await expect(page.locator('.chat-row')).to_have_count(1)
    await expect(page.locator('.chat-row')).to_have_attribute('data-id', PRIMARY)
    await page.locator('#chat-search').fill('zzzz-nothing')
    await expect(page.locator('#chat-list .empty')).to_contain_text('No chats match')
    await page.locator('#chat-search').fill('')
    await expect(page.locator('.chat-row')).to_have_count(2)


async def group_chat_flow(page, base):
    await open_app(page, base, bots=EXTRA_BOTS)
    await page.locator(f'.chat-row[data-id="{TEAM}"]').click()
    await expect(page.locator('.thread-title strong')).to_have_text('Home')
    await expect(page.locator('.thread-title')).to_contain_text('Atlas, Researcher')
    await expect(page.locator('.needs-pill')).to_have_count(0)
    chips = await page.locator('[data-action="quick-chat"]').all_inner_texts()
    assert chips == ['What can you do?', 'Create a bot named Researcher'], chips
    box = page.locator('#chat-form textarea[name=message]')
    # Shift+Enter is a newline, not a send.
    await box.fill('line one')
    await box.press('Shift+Enter')
    await box.type('line two')
    assert await box.input_value() == 'line one\nline two'
    await expect(page.locator('.msg.me')).to_have_count(0)
    await box.fill('Draft a reply')
    await box.press('Enter')
    # The user's bubble, then the bots hand the work down the pipeline.
    await expect(page.locator('.msg.me .text').first).to_have_text('Draft a reply')
    await expect(page.locator('#chat-space .event').last).to_contain_text('Done in', timeout=10000)
    assert await box.input_value() == ''
    senders = set(await page.locator('#chat-space .sender').all_inner_texts())
    assert senders == {'Atlas', 'Researcher', 'Writer', 'Reviewer'}, senders
    assert await page.locator('#chat-space .handoff').count() == 3  # each bot but the last names who is next
    await expect(page.locator('#chat-space .event').first).to_contain_text('Simulated, no live AI')
    # The conversation (and the list preview) survive a reload.
    await page.reload()  # the hash keeps us in the same chat
    await expect(page.locator('.msg.me .text').first).to_have_text('Draft a reply')


async def direct_bot_chat(page, base):
    await open_app(page, base)
    await page.locator(f'.chat-row[data-id="{PRIMARY}"]').click()
    await expect(page.locator('.thread-title strong')).to_have_text('Atlas')
    await expect(page.locator('.thread-title')).to_contain_text('Home')
    await expect(page.locator('#chat-space .welcome')).to_contain_text('This is the primary bot')
    await page.locator('[data-action="quick-chat"]', has_text='What can you do?').click()
    await expect(page.locator('.msg.them .text').last).to_contain_text('My job')
    await expect(page.locator(f'.chat-row[data-id="{PRIMARY}"] .chat-row-preview')).to_contain_text('My job')
    # A chat with activity floats above idle ones.
    first = await page.locator('.chat-row').first.get_attribute('data-id')
    assert first == PRIMARY, first


async def quick_navigation(page, base):
    ids = await open_app(page, base, bots=EXTRA_BOTS)
    command = page.locator('#command')
    await expect(command).to_be_hidden()
    await page.locator('#chat-search').focus()
    await page.keyboard.press('Control+k')
    await expect(page.get_by_role('dialog', name='Quick navigation')).to_be_visible()
    await expect(page.locator('#command-input')).to_be_focused()
    total = await page.locator('#command-results .command-item').count()
    assert total >= 10, total
    # Filter, then Enter opens the highlighted result.
    await page.locator('#command-input').fill('Reviewer')
    # 'Reviewer · Scheduled tasks' also matches now, so the bot itself comes first.
    await expect(page.get_by_role('option', name='Reviewer').first).to_be_visible()
    await page.keyboard.press('Enter')
    await expect(command).to_be_hidden()
    await expect(page.locator('.thread-title strong')).to_have_text('Reviewer')
    assert await hash_(page) == f"#chat/{ids['Reviewer']}", await hash_(page)
    # Arrow keys move the selection; a result can also be clicked.
    await page.keyboard.press('Control+k')
    await page.locator('#command-input').fill('home')
    # 'Chats' (hint Home) is the first match; the group and its info sections follow.
    await expect(page.locator('#command-results .command-item.selected')).to_contain_text('Chats')
    assert await page.locator('#command-results .command-item').count() >= 5  # the group plus its info sections
    await page.keyboard.press('ArrowDown')
    assert await page.locator('#command-results .command-item.selected').get_attribute('data-index') == '1'
    await page.keyboard.press('ArrowUp')
    await page.locator('#command-results .command-item', has_text='Group chat').click()
    await expect(page.locator('.thread-title strong')).to_have_text('Home')
    # No match says so, and Enter then does nothing.
    await page.keyboard.press('Control+k')
    await page.locator('#command-input').fill('qqqqq')
    await expect(page.locator('#command-results .empty')).to_contain_text('Nothing matches')
    await page.keyboard.press('Enter')
    await expect(page.locator('#command-input')).to_be_visible()
    # Esc closes it and hands focus back to where it came from.
    await page.keyboard.press('Escape')
    await expect(command).to_be_hidden()
    await page.locator('#chat-search').focus()
    await page.keyboard.press('Control+k')
    await page.keyboard.press('Escape')
    await expect(command).to_be_hidden()
    await expect(page.locator('#chat-search')).to_be_focused()
    # Ctrl+K toggles.
    await page.keyboard.press('Control+k')
    await expect(command).to_be_visible()
    await page.keyboard.press('Control+k')
    await expect(command).to_be_hidden()


async def history_routes(page, base):
    await open_app(page, base)
    await page.locator(f'.chat-row[data-id="{TEAM}"]').click()
    assert await hash_(page) == f'#chat/{TEAM}'
    await page.locator('.thread-title').click()
    assert await hash_(page) == f'#chat/{TEAM}/info'
    await expect(page.locator('#inspector .pane-head h2')).to_have_text('Group info')
    await page.locator('#inspector [data-action="open-section"][data-section="runs"]').click()
    assert await hash_(page) == f'#chat/{TEAM}/info/runs'
    await expect(page.locator('#inspector .pane-head h2')).to_have_text('Runs')
    await page.go_back()
    assert await hash_(page) == f'#chat/{TEAM}/info'
    await expect(page.locator('#inspector .pane-head h2')).to_have_text('Group info')
    await page.go_back()
    assert await hash_(page) == f'#chat/{TEAM}'
    await expect(page.locator('#inspector .pane-head h2')).to_have_count(0)
    await expect(page.locator('.thread-title strong')).to_have_text('Home')
    await page.go_back()
    assert await hash_(page) in ('', '#chats')  # first entry was the bare URL
    await expect(page.locator('#main h1')).to_have_text('What should your bots work on?')
    await page.go_forward()
    await expect(page.locator('.thread-title strong')).to_have_text('Home')
    await page.go_forward()
    await page.go_forward()
    assert await hash_(page) == f'#chat/{TEAM}/info/runs'
    await expect(page.locator('#inspector .pane-head h2')).to_have_text('Runs')
    # Esc closes the info panel as a step back too.
    await page.locator('#inspector .back').focus()
    await page.keyboard.press('Escape')
    assert await hash_(page) == f'#chat/{TEAM}'
    # Deep links work cold, in a fresh load, and unknown targets fall back to the list.
    await page.goto(f'{base}/index.html#chat/atlas/info/edit')
    await expect(page.locator('#edit-bot-form')).to_be_visible()
    await page.goto(f'{base}/index.html#you/about')
    await page.reload()
    await expect(page.locator('#main h2')).to_have_text('About this build')
    await page.goto(f'{base}/index.html#chat/does-not-exist')
    await page.reload()
    await expect(page.locator('#main h1')).to_have_text('What should your bots work on?')
    await page.goto(f'{base}/index.html#team')  # admin page is refused without a server session
    await page.reload()
    await expect(page.locator('#main h1')).to_have_text('What should your bots work on?')


async def you_pages(page, base):
    await open_app(page, base)
    await page.locator('#sidebar [data-action="open-page"][data-page="you"]').click()
    assert await hash_(page) == '#you'
    await expect(page.locator('#main h2').first).to_have_text('You')
    await expect(page.locator('#main')).to_contain_text('Local demo. Nothing leaves this browser.')
    await page.locator('#main [data-action="open-page"][data-page="about"]').click()
    assert await hash_(page) == '#you/about'
    await page.go_back()
    await expect(page.locator('#main h2').first).to_have_text('You')


async def phone_flow(page, base):
    await open_app(page, base)
    body = page.locator('body')
    await expect(body).to_have_attribute('data-pane', 'list')
    await expect(page.locator('#sidebar')).to_be_visible()
    await expect(page.locator('#main')).to_be_hidden()
    await expect(page.locator('.fab')).to_be_visible()
    assert await overflow(page) <= 0
    await page.locator(f'.chat-row[data-id="{TEAM}"]').click()
    await expect(body).to_have_attribute('data-pane', 'main')
    await expect(page.locator('#main')).to_be_visible()
    await expect(page.locator('#sidebar')).to_be_hidden()
    await expect(page.locator('#chat-form')).to_be_visible()
    await page.locator('.thread-title').click()
    await expect(body).to_have_attribute('data-pane', 'info')
    await expect(page.locator('#inspector')).to_be_visible()
    await expect(page.locator('#inspector .pane-head h2').first).to_have_text('Group info')
    assert await overflow(page) <= 0
    # Back out one pane at a time: info -> thread -> list.
    await page.locator('#inspector .back').click()
    await expect(body).to_have_attribute('data-pane', 'main')
    await expect(page.locator('#inspector')).to_be_hidden()
    await page.locator('#thread-head .back').click()
    await expect(body).to_have_attribute('data-pane', 'list')
    await expect(page.locator('#sidebar')).to_be_visible()
    # Hardware back does the same walk.
    await page.locator('.chat-row[data-id="atlas"]').click()
    await expect(body).to_have_attribute('data-pane', 'main')
    await page.go_back()
    await expect(body).to_have_attribute('data-pane', 'list')
    # The + button opens the New chat sheet, which fits the phone.
    await page.locator('.fab').click()
    sheet = page.locator('#modal .sheet')
    await expect(sheet).to_be_visible()
    box = await sheet.bounding_box()
    assert box['x'] >= 0 and box['x'] + box['width'] <= PHONE['width'] + 1, box
    assert await overflow(page) <= 0
    await page.keyboard.press('Escape')
    await expect(sheet).to_be_hidden()


async def no_overflow(page, base):
    """No horizontal scroll at the extremes, on every kind of screen."""
    routes = ['#chats', f'#chat/{TEAM}', f'#chat/{TEAM}/info', f'#chat/{TEAM}/info/runs',
              f'#chat/{TEAM}/info/group-settings', f'#chat/{TEAM}/info/tasks',
              '#chat/atlas', '#chat/atlas/info', '#chat/atlas/info/edit', '#you', '#you/about']
    for width in (390, 1360):
        await page.set_viewport_size({'width': width, 'height': 860})
        for route in routes:
            await page.goto(f'{base}/index.html{route}')
            await page.reload()
            await page.locator('.chat-row').first.wait_for(state='attached')
            await page.wait_for_timeout(350)  # let the slide-in finish
            extra = await overflow(page)
            assert extra <= 0, f'{route} at {width}px overflows by {extra}px'
        # A long message must wrap instead of widening the page.
        await page.goto(f'{base}/index.html#chat/atlas')
        await page.reload()
        long_word = 'x' * 400
        sent = await page.locator('.msg.me').count()
        await page.locator('#chat-form textarea').fill(f'{long_word} ' + 'word ' * 80)
        await page.locator('#chat-form textarea').press('Enter')
        await expect(page.locator('.msg.me')).to_have_count(sent + 1)
        await page.wait_for_timeout(300)
        extra = await overflow(page)
        assert extra <= 0, f'long message at {width}px overflows by {extra}px'


async def layout_panes(page, base):
    """Desktop shows three panes side by side once the info panel is open."""
    await open_app(page, base, f'#chat/{TEAM}/info')
    boxes = {}
    for name in ('sidebar', 'main', 'inspector'):
        await expect(page.locator(f'#{name}')).to_be_visible()
        boxes[name] = await page.locator(f'#{name}').bounding_box()
    assert boxes['sidebar']['x'] < boxes['main']['x'] < boxes['inspector']['x'], boxes
    assert boxes['sidebar']['x'] + boxes['sidebar']['width'] <= boxes['main']['x'] + 1, boxes
    assert boxes['main']['x'] + boxes['main']['width'] <= boxes['inspector']['x'] + 1, boxes
    # Closing the panel gives the room back to the thread.
    await page.locator('#inspector .back').click()
    await expect(page.locator('#inspector')).to_be_hidden()


async def main():
    shots = Path(tempfile.mkdtemp(prefix='polish-smoke-shots-'))
    site_dir = Path(tempfile.mkdtemp(prefix='polish-smoke-site-'))
    try:
        server = serve(build_site(site_dir))
        base = f'http://127.0.0.1:{server.server_address[1]}'
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True, args=['--no-sandbox'])
            h = Harness(browser, base, shots)
            print(f'Polish smoke against {base}')
            await h.scenario('first run: seed, list, filters, search', first_run)
            await h.scenario('group chat: send, handoffs, reload', group_chat_flow)
            await h.scenario('direct bot chat answers and floats up', direct_bot_chat)
            await h.scenario('Ctrl+K quick navigation', quick_navigation)
            await h.scenario('Back/Forward walk the hash routes', history_routes)
            await h.scenario('You and About pages', you_pages)
            await h.scenario('desktop three-pane layout', layout_panes)
            await h.scenario('phone: list -> thread -> info -> back', phone_flow, PHONE)
            await h.scenario('no horizontal overflow at 390px and 1360px', no_overflow, PHONE)
            await browser.close()
            server.shutdown()
        failed = [name for name, error in h.results if error]
        if failed:
            print(f'POLISH SMOKE FAIL: {len(failed)} of {len(h.results)} scenarios: {failed}')
            return 1
        print(f'POLISH SMOKE PASS: {len(h.results)} scenarios; first run, group handoffs, palette, history, phone panes, no overflow, no console errors')
        return 0
    finally:
        shutil.rmtree(site_dir, ignore_errors=True)


sys.exit(asyncio.run(main()))
