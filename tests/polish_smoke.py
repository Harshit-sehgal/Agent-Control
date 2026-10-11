"""Browser smoke test for the chat-first UI: layout, navigation and responsiveness.

Drives the real generated static build (the same files GitHub Pages serves), not
a concatenated copy. The script rebuilds the bundle from `shared/` into a temp
directory (so it never touches `docs/` and never tests a stale build), serves it
from a local http.server on a free port and opens every scenario in a fresh
browser context so localStorage always starts empty.

Run: python3 tests/polish_smoke.py   (screenshots of failures land in a temp dir)
No network, no credentials, nothing is ever posted to X.
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
TEAM = 'team-x-engage'
BOT_IDS = ['scout', 'ranker', 'researcher', 'writer', 'reviewer', 'handoff']
expect.set_options(timeout=6000)


def build_site(tmp):
    """Run scripts/build-pages.js against a copy of shared/, so docs/ is untouched."""
    shutil.copytree(ROOT / 'shared', tmp / 'shared')
    (tmp / 'scripts').mkdir()
    shutil.copy(ROOT / 'scripts/build-pages.js', tmp / 'scripts/build-pages.js')
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


async def open_app(page, base, hash_=''):
    await page.goto(f'{base}/index.html{hash_}')
    await page.locator('.chat-row').first.wait_for()


async def overflow(page):
    return await page.evaluate('() => document.documentElement.scrollWidth - innerWidth')


async def hash_(page):
    return await page.evaluate('location.hash')


# ---------------------------------------------------------------- scenarios

async def first_run(page, base):
    await open_app(page, base)
    # Seed: the group plus its six bots, in natural order, no unread work yet.
    ids = await page.locator('.chat-row').evaluate_all('rows => rows.map(r => r.dataset.id)')
    assert ids == [TEAM] + BOT_IDS, ids
    await expect(page.locator('#sidebar .list-head h1')).to_have_text('Chats')
    await expect(page.locator('#sidebar .backend')).to_contain_text('Browser-only')
    await expect(page.locator('.chat-row .badge')).to_have_count(0)
    # Desktop home pane invites a first message.
    await expect(page.locator('#main h1')).to_have_text('What should your bots work on?')
    # Filters.
    await page.locator('[data-action="list-filter"][data-filter="groups"]').click()
    await expect(page.locator('.chat-row')).to_have_count(1)
    await page.locator('[data-action="list-filter"][data-filter="bots"]').click()
    await expect(page.locator('.chat-row')).to_have_count(6)
    await page.locator('[data-action="list-filter"][data-filter="needs"]').click()
    await expect(page.locator('#chat-list .empty')).to_contain_text('Nothing is waiting on you')
    await page.locator('[data-action="list-filter"][data-filter="all"]').click()
    # Search narrows by name and says so when nothing matches.
    await page.locator('#chat-search').fill('writ')
    await expect(page.locator('.chat-row')).to_have_count(1)
    await expect(page.locator('.chat-row')).to_have_attribute('data-id', 'writer')
    await page.locator('#chat-search').fill('zzzz-nothing')
    await expect(page.locator('#chat-list .empty')).to_contain_text('No chats match')
    await page.locator('#chat-search').fill('')
    await expect(page.locator('.chat-row')).to_have_count(7)
    # The static demo seeds exactly three sample posts in the group thread.
    await page.locator(f'.chat-row[data-id="{TEAM}"]').click()
    await expect(page.locator('#chat-space .post')).to_have_count(3)
    await expect(page.locator('#chat-space .post-meta').first).to_contain_text('sample')
    # Reloading must not seed a second time.
    await page.reload()
    await page.locator(f'.chat-row[data-id="{TEAM}"]').wait_for()
    await expect(page.locator('#chat-space .post')).to_have_count(3)


async def group_chat_flow(page, base):
    await open_app(page, base)
    await page.locator(f'.chat-row[data-id="{TEAM}"]').click()
    await expect(page.locator('.thread-title strong')).to_have_text('X-engage')
    await expect(page.locator('.thread-title')).to_contain_text('Scout, Ranker')
    await expect(page.locator('.needs-pill')).to_have_count(0)
    chips = await page.locator('[data-action="quick-chat"]').all_inner_texts()
    assert chips == ['Draft a reply', 'What needs me?', 'Show status'], chips
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
    assert senders == {'Scout', 'Ranker', 'Researcher', 'Writer', 'Reviewer'}  # the X pipeline; Handoff is mention-only, senders
    assert await page.locator('#chat-space .handoff').count() == 4  # each bot but the last names who is next
    await expect(page.locator('#chat-space .event').first).to_contain_text('Simulated, no live AI')
    # The draft is a card in the thread and the human is told it is their move.
    card = page.locator('#chat-space article.draft')
    await expect(card).to_have_count(1)
    await expect(card).to_contain_text('Waiting on you. Nothing posts by itself.')
    for action in ('approve-draft', 'edit-draft', 'reject-draft', 'rewrite-draft'):
        await expect(card.locator(f'[data-action="{action}"]')).to_have_count(1)
    await expect(page.locator('.needs-pill')).to_have_text('1 needs you')
    await expect(page.locator(f'.chat-row[data-id="{TEAM}"] .badge')).to_have_text('1')
    await expect(page.locator('[data-action="list-filter"][data-filter="needs"] .badge')).to_have_text('1')
    await page.locator('[data-action="list-filter"][data-filter="needs"]').click()
    ids = await page.locator('.chat-row').evaluate_all('rows => rows.map(r => r.dataset.id)')
    assert ids == [TEAM], ids
    # The conversation (and the list preview) survive a reload.
    await page.reload()  # the hash keeps us in the same chat
    await expect(page.locator('#chat-space article.draft')).to_have_count(1)
    await expect(page.locator('.msg.me .text').first).to_have_text('Draft a reply')


async def direct_bot_chat(page, base):
    await open_app(page, base)
    await page.locator('.chat-row[data-id="scout"]').click()
    await expect(page.locator('.thread-title strong')).to_have_text('Scout')
    await expect(page.locator('.thread-title')).to_contain_text('X-engage')
    await expect(page.locator('#chat-space .welcome')).to_contain_text('Offline demo')
    await page.locator('[data-action="quick-chat"]', has_text='Show status').click()
    await expect(page.locator('.msg.them .text').last).to_contain_text('Here is where things stand')
    await expect(page.locator('.chat-row[data-id="scout"] .chat-row-preview')).to_contain_text('Here is where things stand')
    # A chat with activity floats above idle ones.
    first = await page.locator('.chat-row').first.get_attribute('data-id')
    assert first == 'scout', first


async def quick_navigation(page, base):
    await open_app(page, base)
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
    await expect(page.get_by_role('option', name='Reviewer')).to_be_visible()
    await page.keyboard.press('Enter')
    await expect(command).to_be_hidden()
    await expect(page.locator('.thread-title strong')).to_have_text('Reviewer')
    assert await hash_(page) == '#chat/reviewer', await hash_(page)
    # Arrow keys move the selection; a result can also be clicked.
    await page.keyboard.press('Control+k')
    await page.locator('#command-input').fill('x-engage')
    await expect(page.locator('#command-results .command-item.selected')).to_contain_text('X-engage')
    assert await page.locator('#command-results .command-item').count() >= 5  # the group plus its info sections
    await page.keyboard.press('ArrowDown')
    assert await page.locator('#command-results .command-item.selected').get_attribute('data-index') == '1'
    await page.keyboard.press('ArrowUp')
    await page.locator('#command-results .command-item').first.click()
    await expect(page.locator('.thread-title strong')).to_have_text('X-engage')
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
    await page.locator('#inspector [data-action="open-section"][data-section="posts"]').click()
    assert await hash_(page) == f'#chat/{TEAM}/info/posts'
    await expect(page.locator('#inspector .pane-head h2')).to_have_text('Posts found')
    await page.go_back()
    assert await hash_(page) == f'#chat/{TEAM}/info'
    await expect(page.locator('#inspector .pane-head h2')).to_have_text('Group info')
    await page.go_back()
    assert await hash_(page) == f'#chat/{TEAM}'
    await expect(page.locator('#inspector .pane-head h2')).to_have_count(0)
    await expect(page.locator('.thread-title strong')).to_have_text('X-engage')
    await page.go_back()
    assert await hash_(page) in ('', '#chats')  # first entry was the bare URL
    await expect(page.locator('#main h1')).to_have_text('What should your bots work on?')
    await page.go_forward()
    await expect(page.locator('.thread-title strong')).to_have_text('X-engage')
    await page.go_forward()
    await page.go_forward()
    assert await hash_(page) == f'#chat/{TEAM}/info/posts'
    await expect(page.locator('#inspector .pane-head h2')).to_have_text('Posts found')
    # Esc closes the info panel as a step back too.
    await page.locator('#candidate-search').focus()
    await page.keyboard.press('Escape')
    assert await hash_(page) == f'#chat/{TEAM}'
    # Deep links work cold, in a fresh load, and unknown targets fall back to the list.
    await page.goto(f'{base}/index.html#chat/writer/info/edit')
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
    await expect(page.locator('#main')).to_contain_text('Posting to X')
    await expect(page.locator('#main')).to_contain_text('Manual, by you')
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
    await page.locator('.chat-row[data-id="writer"]').click()
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
    routes = ['#chats', f'#chat/{TEAM}', f'#chat/{TEAM}/info', f'#chat/{TEAM}/info/posts', f'#chat/{TEAM}/info/drafts',
              f'#chat/{TEAM}/info/reminders', f'#chat/{TEAM}/info/runs', f'#chat/{TEAM}/info/voice',
              '#chat/writer', '#chat/writer/info', '#chat/writer/info/edit', '#you', '#you/about']
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
        await page.goto(f'{base}/index.html#chat/scout')
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
            await h.scenario('group chat: send, handoffs, draft card, needs-you', group_chat_flow)
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
