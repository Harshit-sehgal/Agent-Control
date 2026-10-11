"""Interactive browser checks for the chat-first UI: drafts, posts, bots, sheets and keyboard.

Drives the real generated static build (the same files GitHub Pages serves), not
a concatenated copy. The script rebuilds the bundle from `shared/` into a temp
directory (so it never touches `docs/` and never tests a stale build), serves it
from a local http.server on a free port and opens every scenario in a fresh
browser context so localStorage always starts empty.

Run: python3 tests/usability_smoke.py   (screenshots of failures land in a temp dir)
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


# ---------------------------------------------------------------- helpers

async def draft_one(page, base):
    """Open the X-engage thread and ask the group for one draft; return its card."""
    await open_app(page, base)
    await page.locator(f'.chat-row[data-id="{TEAM}"]').click()
    await page.locator('[data-action="quick-chat"]', has_text='Draft a reply').click()
    card = page.locator('#chat-space article.draft')
    await expect(card).to_have_count(1)
    await expect(page.locator('#chat-space .event').last).to_contain_text('Done in')
    return card


async def open_info_section(page, section):
    await page.locator('.thread-title').click()
    await page.locator(f'#inspector [data-action="open-section"][data-section="{section}"]').click()


async def toast_text(page):
    return await page.locator('#toast').inner_text()


# ---------------------------------------------------------------- scenarios

async def approve_to_posted(page, base):
    card = await draft_one(page, base)
    await expect(card).to_have_class(re.compile(r'tone-wait'))
    await card.locator('[data-action="approve-draft"]').click()
    # Approved: the card says so, the question is gone, the next move is a wait.
    await expect(card).to_have_class(re.compile(r'tone-ok'))
    await expect(card.locator('.draft-state')).to_contain_text('Approved. Ready')
    await expect(card.locator('[data-action="approve-draft"]')).to_have_count(0)
    await expect(card.locator('[data-action="edit-draft"]')).to_have_count(1)
    await expect(page.locator('#toast')).to_contain_text('Approved')
    await expect(page.locator('.needs-pill')).to_have_count(0)
    await expect(page.locator(f'.chat-row[data-id="{TEAM}"] .badge')).to_have_count(0)
    # The approved draft waits under Reminders until it is ready.
    await open_info_section(page, 'reminders')
    await expect(page.locator('#inspector')).to_contain_text('Approved, waiting to be ready')
    await expect(page.locator('#inspector .tag', has_text='Scheduled')).to_have_count(1)
    await page.locator('#inspector .back').click()
    await page.locator('#inspector .back').click()
    # Move to ready, then record posting through the confirm sheet (no native dialog).
    await card.locator('[data-action="ready-draft"]').click()
    await expect(card.locator('.draft-state')).to_contain_text('Ready. Post it on X yourself.')
    await expect(page.locator('.needs-pill')).to_have_text('1 needs you')  # ready work is the human's again
    await expect(card.locator('[data-action="copy-draft"]')).to_have_count(1)
    await expect(card.locator('a.btn', has_text='Open post')).to_have_attribute('rel', re.compile('noopener'))
    trigger = card.locator('[data-action="posted-draft"]')
    await trigger.click()
    sheet = page.get_by_role('dialog', name='Did you post this on X yourself?')
    await expect(sheet).to_be_visible()
    await expect(sheet).to_contain_text('Agent Control never posts for you')
    # Cancel leaves the draft untouched.
    await sheet.locator('[data-action="close-sheet"]').last.click()
    await expect(sheet).to_be_hidden()
    await expect(card.locator('.draft-state')).to_contain_text('Ready. Post it on X yourself.')
    await trigger.click()
    await page.locator('[data-action="sheet-confirm"]').click()
    await expect(sheet).to_be_hidden()
    await expect(card).to_have_class(re.compile(r'tone-done'))
    await expect(card.locator('.draft-state')).to_contain_text('Posted by you.')
    await expect(card.locator('.card-actions')).to_have_count(0)
    await expect(page.locator('.needs-pill')).to_have_count(0)
    # Posted drafts are listed as such under the Drafts filter.
    await open_info_section(page, 'drafts')
    await page.locator('#draft-status').select_option('posted')
    await expect(page.locator('#approval-results .row')).to_have_count(1)
    await expect(page.locator('#approval-results .tag')).to_have_text('Posted')


async def edit_skip_rewrite(page, base):
    card = await draft_one(page, base)
    original = await card.locator('.draft-text').inner_text()
    # Cancel keeps the text.
    await card.locator('[data-action="edit-draft"]').click()
    area = card.locator('textarea[name=text]')
    await expect(area).to_have_value(original)
    await area.fill('discard me')
    await card.locator('[data-action="cancel-edit"]').click()
    await expect(card.locator('.draft-text')).to_have_text(original)
    # Save shows the new text and the draft still needs approval.
    await card.locator('[data-action="edit-draft"]').click()
    await card.locator('textarea[name=text]').fill('Reliability beats demos, every time.')
    await card.locator('button[type=submit]', has_text='Save').click()
    await expect(card.locator('.draft-text')).to_have_text('Reliability beats demos, every time.')
    await expect(card.locator('.draft-state')).to_contain_text('Waiting on you')
    await expect(page.locator('#toast')).to_contain_text('needs your approval again')
    # Rewrite goes through the ask sheet and bumps the revision.
    await card.locator('[data-action="rewrite-draft"]').click()
    ask = page.get_by_role('dialog', name='Rewrite this draft')
    await expect(ask).to_be_visible()
    await expect(page.locator('#ask-form textarea')).to_be_focused()
    await page.locator('#ask-form textarea').fill('Shorter, less hype')
    await page.locator('#ask-form button[type=submit]').click()
    await expect(ask).to_be_hidden()
    await expect(card.locator('.draft-score')).to_contain_text('rev')
    await expect(page.locator('#toast')).to_contain_text('Draft rewritten')
    # Dismissing the ask sheet changes nothing.
    await card.locator('[data-action="rewrite-draft"]').click()
    await page.keyboard.press('Escape')
    await expect(ask).to_be_hidden()
    # Skip rejects the draft and clears the pill.
    await card.locator('[data-action="reject-draft"]').click()
    await expect(card.locator('.draft-state')).to_contain_text('Skipped.')
    await expect(card).to_have_class(re.compile(r'tone-off'))
    await expect(page.locator('.needs-pill')).to_have_count(0)
    await expect(page.locator('#toast')).to_contain_text('skipped')


async def draft_filters(page, base):
    await draft_one(page, base)
    await open_info_section(page, 'drafts')
    results = page.locator('#approval-results article.draft')
    await expect(results).to_have_count(1)  # default "Active"
    await page.locator('#draft-status').select_option('posted')
    await expect(results).to_have_count(0)
    await expect(page.locator('#approval-results .empty')).to_contain_text('No drafts here')
    await page.locator('#draft-status').select_option('pending')
    await expect(results).to_have_count(1)
    await page.locator('#draft-sort').select_option('oldest')
    await expect(results).to_have_count(1)
    # The filter choice is a preference: it survives a reload.
    await page.locator('#draft-status').select_option('rejected')
    await page.reload()
    await expect(page.locator('#draft-status')).to_have_value('rejected')
    await expect(page.locator('#approval-results article.draft')).to_have_count(0)


async def share_and_find_post(page, base):
    await open_app(page, base)
    await page.locator(f'.chat-row[data-id="{TEAM}"]').click()
    await expect(page.locator('#chat-space .post')).to_have_count(3)
    await page.locator('[data-action="attach"]').click()
    attach = page.get_by_role('dialog', name='Add to this chat')
    await expect(attach).to_be_visible()
    await attach.locator('[data-action="share-post"]').click()
    form = page.locator('#candidate-form')
    await expect(form).to_be_visible()
    await expect(form.locator('input[name=url]')).to_be_focused()
    # Required fields block an empty submit.
    await form.locator('button[type=submit]').click()
    await expect(form).to_be_visible()
    await form.locator('input[name=url]').fill('https://x.com/qlabs/status/9001')
    await form.locator('textarea[name=text]').fill('Quantum error correction just got cheaper, which matters for robotics sensors.')
    await form.locator('input[name=author]').fill('Quantum Labs')
    await form.locator('input[name=topic]').fill('quantum')
    await form.locator('button[type=submit]').click()
    await expect(form).to_be_hidden()
    await expect(page.locator('#toast')).to_contain_text('Post shared with the group')
    await expect(page.locator('#chat-space .post')).to_have_count(4)
    await expect(page.locator('#chat-space .post').last).to_contain_text('Quantum Labs')
    # Sharing the same link again is recognised, not duplicated.
    await page.locator('[data-action="attach"]').click()
    await page.locator('[data-action="share-post"]').click()
    await page.locator('#candidate-form input[name=url]').fill('https://x.com/qlabs/status/9001')
    await page.locator('#candidate-form textarea[name=text]').fill('Quantum error correction just got cheaper, which matters for robotics sensors.')
    await page.locator('#candidate-form button[type=submit]').click()
    await expect(page.locator('#toast')).to_contain_text('already here')
    await expect(page.locator('#chat-space .post')).to_have_count(4)
    # Find it under Posts with search and filters.
    await open_info_section(page, 'posts')
    results = page.locator('#candidate-results .post')
    count = page.locator('#candidate-count')
    await expect(results).to_have_count(4)
    await expect(count).to_have_text('4 of 4')
    search = page.locator('#candidate-search')
    await search.fill('quantum')
    await expect(results).to_have_count(1)
    await expect(count).to_have_text('1 of 4')
    await expect(search).to_be_focused()  # typing does not lose the field
    await search.fill('robotics')
    await expect(results).to_have_count(2)  # the sample and the new post
    await search.fill('nothing-like-this')
    await expect(page.locator('#candidate-results .empty')).to_contain_text('No posts match')
    await search.fill('')
    await expect(results).to_have_count(4)
    # Draft the shared post, then the status filter splits drafted from new.
    await search.fill('quantum')
    await results.first.locator('[data-action="draft-candidate"]').click()
    await expect(results.first.locator('.tag')).to_have_text('Drafted')
    await search.fill('')
    await page.locator('#candidate-status').select_option('drafted')
    await expect(results).to_have_count(1)
    await page.locator('#candidate-status').select_option('new')
    await expect(results).to_have_count(3)
    await page.locator('#candidate-status').select_option('drafted')
    await search.fill('robotics')
    await expect(results).to_have_count(1)  # the drafted post mentions robotics too; the undrafted sample does not count
    await search.fill('benchmark')
    await expect(results).to_have_count(0)  # a sample that is not drafted is hidden by the filter
    await search.fill('')
    await page.locator('#candidate-status').select_option('all')
    # Sort flips the order.
    await page.locator('#candidate-sort').select_option('newest')
    newest = await results.first.inner_text()
    await page.locator('#candidate-sort').select_option('oldest')
    oldest = await results.first.inner_text()
    assert newest != oldest and 'Quantum Labs' in newest, (newest, oldest)
    # Drafting from the thread surfaced a card there too, and the needs pill.
    await page.locator('#inspector .back').click()
    await page.locator('#inspector .back').click()
    await expect(page.locator('#chat-space article.draft')).to_have_count(1)
    await expect(page.locator('.needs-pill')).to_have_text('1 needs you')


async def load_and_remove_samples(page, base):
    await open_app(page, base)
    await page.locator(f'.chat-row[data-id="{TEAM}"]').click()
    await open_info_section(page, 'posts')
    await expect(page.locator('#candidate-results .post')).to_have_count(3)
    await page.locator('[data-action="reset-demo"]').click()
    await expect(page.get_by_role('dialog', name='Remove the sample posts?')).to_be_visible()
    await page.locator('[data-action="sheet-confirm"]').click()
    await expect(page.locator('#candidate-results .post')).to_have_count(0)
    await expect(page.locator('#candidate-results .empty')).to_be_visible()
    await page.locator('[data-action="load-samples"]').click()
    await expect(page.locator('#candidate-results .post')).to_have_count(3)


async def create_bot_from_template(page, base):
    await open_app(page, base)
    await page.locator('#sidebar .new-chat').click()
    await page.locator('#modal [data-action="new-bot"]').click()
    form = page.locator('#new-bot-form')
    await expect(form).to_be_visible()
    await expect(form.locator('input[name=name]')).to_be_focused()
    await expect(form.locator('select[name=group]')).to_have_value('x-engage')
    # A template fills both fields; the user then renames it.
    await page.get_by_label('Bot template').select_option('writer')
    await expect(form.locator('input[name=name]')).to_have_value('Writer')
    assert (await form.locator('textarea[name=instructions]').input_value()).startswith('Write clear, concise drafts')
    await page.get_by_label('Bot template').select_option('blank')
    await expect(form.locator('input[name=name]')).to_have_value('')
    await page.get_by_label('Bot template').select_option('review')
    await expect(form.locator('input[name=name]')).to_have_value('Reviewer')
    await form.locator('input[name=name]').fill('Publishing assistant')
    await form.locator('button.tint[data-index="3"]').click()
    await expect(form.locator('button.tint[data-index="3"]')).to_have_attribute('aria-pressed', 'true')
    await form.locator('button[type=submit]').click()
    # Lands in the new bot's own chat.
    await expect(page.locator('#modal')).to_be_hidden()
    await expect(page.locator('.thread-title strong')).to_have_text('Publishing assistant')
    assert (await hash_(page)).startswith('#chat/') and TEAM not in await hash_(page), await hash_(page)
    await expect(page.locator('#chat-space .welcome')).to_contain_text('Check drafts for unsupported facts')
    await expect(page.locator('#toast')).to_contain_text('Publishing assistant is ready')
    await expect(page.locator('.chat-row', has_text='Publishing assistant')).to_have_count(1)
    await expect(page.locator('.chat-row.current')).to_contain_text('Publishing assistant')
    # A custom bot answers with the offline command set and says so.
    await page.locator('#chat-form textarea').fill('hello')
    await page.locator('#chat-form textarea').press('Enter')
    await expect(page.locator('.msg.them .text').last).to_contain_text('offline demo')
    # Survives a reload.
    await page.reload()
    await expect(page.locator('.thread-title strong')).to_have_text('Publishing assistant')


async def create_group(page, base):
    await open_app(page, base)
    await page.locator('#sidebar .new-chat').click()
    await page.locator('#modal [data-action="new-group"]').click()
    form = page.locator('#new-group-form')
    await form.locator('input[name=name]').fill('Product research')
    await form.locator('textarea[name=description]').fill('Reads docs and summarises them.')
    await form.locator('button[type=submit]').click()
    await expect(page.locator('.thread-title strong')).to_have_text('Product research')
    await expect(page.locator('#inspector .hero h2')).to_have_text('Product research')  # lands on its info panel
    await expect(page.locator('#toast')).to_contain_text('Group created')
    await expect(page.locator('.chat-row', has_text='Product research')).to_have_count(1)
    # Add a bot straight from the empty group's info panel.
    await page.locator('#inspector [data-action="add-bot-to-group"]').click()
    selected = await page.locator('#new-bot-form select[name=group] option:checked').inner_text()
    assert selected == 'Product research', selected
    await page.locator('#new-bot-form input[name=name]').fill('Reader')
    await page.locator('#new-bot-form textarea[name=instructions]').fill('Read the docs and report key points.')
    await page.locator('#new-bot-form button[type=submit]').click()
    await expect(page.locator('.thread-title strong')).to_have_text('Reader')
    await expect(page.locator('.thread-title')).to_contain_text('Product research')


async def edit_profile_persists(page, base):
    await open_app(page, base)
    await page.locator('.chat-row[data-id="writer"]').click()
    await page.locator('.thread-title').click()
    await expect(page.locator('#inspector .hero h2')).to_have_text('Writer')
    await page.locator('#inspector [data-action="open-section"][data-section="edit"]').click()
    form = page.locator('#edit-bot-form')
    await expect(form.locator('input[name=name]')).to_have_value('Writer')
    await form.locator('input[name=name]').fill('Lead Writer')
    await form.locator('textarea[name=instructions]').fill('Draft concise replies, then hand to Reviewer.')
    await form.locator('button[type=submit]').click()
    await expect(page.locator('#toast')).to_contain_text('Profile saved')
    await expect(page.locator('.thread-title strong')).to_have_text('Lead Writer')
    await expect(page.locator('#inspector')).to_contain_text('Draft concise replies, then hand to Reviewer.')
    await expect(page.locator('.chat-row[data-id="writer"] .chat-row-name')).to_have_text('Lead Writer')

    async def profile_is_in_store():
        stored = await page.evaluate("() => JSON.parse(localStorage.getItem('agent-control-ghpages-v1'))")
        bot = next(b for g in stored['groups'] for b in g['bots'] if b['id'] == 'writer')
        assert bot['name'] == 'Lead Writer' and bot['instructions'].startswith('Draft concise replies'), bot
        # The cosmetic record must not mirror name/instructions, or it would shadow the store.
        profiles = await page.evaluate("() => JSON.parse(localStorage.getItem('agent-control-bot-profiles-v2') || '{}')")
        assert not any('name' in v or 'instructions' in v for v in profiles.values()), profiles
    await profile_is_in_store()
    # Same context, real reload: the edit is still there.
    await page.reload()
    await expect(page.locator('.chat-row[data-id="writer"] .chat-row-name')).to_have_text('Lead Writer')
    await expect(page.locator('.thread-title strong')).to_have_text('Lead Writer')
    await expect(page.locator('#inspector')).to_contain_text('Draft concise replies, then hand to Reviewer.')
    await profile_is_in_store()
    # Validation: a blank name is refused by the form and nothing changes.
    await page.locator('#inspector [data-action="open-section"][data-section="edit"]').click()
    await page.locator('#edit-bot-form input[name=name]').fill('')
    await page.locator('#edit-bot-form button[type=submit]').click()
    await expect(page.locator('#edit-bot-form')).to_be_visible()
    await expect(page.locator('.thread-title strong')).to_have_text('Lead Writer')


async def pin_bot(page, base):
    await open_app(page, base)
    await page.locator('.chat-row[data-id="reviewer"]').click()
    await page.locator('.thread-title').click()
    await page.locator('#inspector [data-action="pin-bot"]').click()
    await expect(page.locator('#toast')).to_contain_text('Pinned to the top')
    await expect(page.locator('#inspector [data-action="pin-bot"]')).to_contain_text('Unpin from top')
    ids = await page.locator('.chat-row').evaluate_all('rows => rows.map(r => r.dataset.id)')
    assert ids[0] == 'reviewer', ids
    await expect(page.locator('.chat-row[data-id="reviewer"] svg').first).to_be_visible()
    # Pins are remembered.
    await page.reload()
    await page.locator('.chat-row').first.wait_for()
    first = await page.locator('.chat-row').first.get_attribute('data-id')
    assert first == 'reviewer', first
    # Unpin puts it back in its natural place.
    await page.locator('#inspector [data-action="pin-bot"]').click()
    await expect(page.locator('#toast')).to_contain_text('Unpinned')
    ids = await page.locator('.chat-row').evaluate_all('rows => rows.map(r => r.dataset.id)')
    assert ids == [TEAM] + BOT_IDS, ids


async def duplicate_bot(page, base):
    await open_app(page, base, '#chat/scout/info')
    await page.locator('#inspector [data-action="duplicate-bot"]').click()
    await expect(page.locator('.thread-title strong')).to_have_text('Scout copy')
    await expect(page.locator('#chat-space .welcome')).to_contain_text('Collect only user-submitted browser context')
    await expect(page.locator('.chat-row', has_text='Scout copy')).to_have_count(1)


async def clear_conversation(page, base):
    await open_app(page, base)
    await page.locator('.chat-row[data-id="scout"]').click()
    await page.locator('.thread-title').click()
    # Empty: nothing to clear, and no sheet.
    await page.locator('#inspector [data-action="clear-chat"]').click()
    await expect(page.locator('#toast')).to_contain_text('already empty')
    await expect(page.locator('#modal')).to_be_hidden()
    await page.locator('#chat-form textarea').fill('Show status')
    await page.locator('#chat-form textarea').press('Enter')
    await expect(page.locator('.msg.them .text').last).to_contain_text('Here is where things stand')
    await expect(page.locator('.msg.me')).to_have_count(1)
    clear = page.locator('#inspector [data-action="clear-chat"]')
    await clear.click()
    sheet = page.get_by_role('dialog', name='Clear this conversation?')
    await expect(sheet).to_be_visible()
    await expect(sheet.locator('[data-action="sheet-confirm"]')).to_have_class(re.compile('danger'))
    # Cancel keeps the messages.
    await sheet.locator('[data-action="close-sheet"]').last.click()
    await expect(sheet).to_be_hidden()
    await expect(page.locator('.msg.me')).to_have_count(1)
    await clear.click()
    await page.locator('[data-action="sheet-confirm"]').click()
    await expect(sheet).to_be_hidden()
    await expect(page.locator('#toast')).to_contain_text('Conversation cleared')
    await expect(page.locator('.msg.me')).to_have_count(0)
    await expect(page.locator('#chat-space .welcome')).to_be_visible()
    await expect(page.locator('.chat-row[data-id="scout"] .chat-row-preview')).to_contain_text('Collect only')
    # Clearing is local to that conversation and survives a reload.
    await page.reload()
    await expect(page.locator('.msg.me')).to_have_count(0)


async def reminders(page, base):
    await open_app(page, base)
    await page.locator(f'.chat-row[data-id="{TEAM}"]').click()
    await open_info_section(page, 'reminders')
    await page.locator('#inspector [data-action="new-reminder"]').click()
    form = page.locator('#schedule-form')
    # "Repeat" uses the interval; "Once" swaps it for a date field.
    await expect(form.locator('[name=intervalMinutes]')).to_be_enabled()
    await expect(form.locator('[name=nextAt]')).to_be_disabled()
    await form.locator('[name=kind]').select_option('once')
    await expect(form.locator('[name=intervalMinutes]')).to_be_disabled()
    await expect(form.locator('[name=nextAt]')).to_be_enabled()
    await form.locator('[name=kind]').select_option('interval')
    await expect(form.locator('[name=intervalMinutes]')).to_be_enabled()
    await form.locator('[name=label]').fill('Review new discussions')
    await form.locator('button[type=submit]').click()
    await expect(page.locator('#toast')).to_contain_text('Reminder set')
    reminder = page.locator('#inspector .row', has_text='Review new discussions')
    await expect(reminder).to_contain_text('Every 60 min')
    # Removing asks first.
    await reminder.locator('[data-action="remove-task"]').click()
    await expect(page.get_by_role('dialog', name='Remove this reminder?')).to_be_visible()
    await page.locator('[data-action="close-sheet"]').last.click()
    await expect(reminder).to_have_count(1)
    await reminder.locator('[data-action="remove-task"]').click()
    await page.locator('[data-action="sheet-confirm"]').click()
    # A removed reminder must leave the list (it is not just relabelled "Removed").
    await expect(page.locator('#inspector .row', has_text='Review new discussions')).to_have_count(0)
    await expect(page.locator('#toast')).to_contain_text('Reminder removed')


async def voice_settings(page, base):
    await open_app(page, base, f'#chat/{TEAM}/info/voice')
    settings = page.locator('#settings-form')
    await settings.locator('input[name=topics]').fill('AI, robotics, chips')
    await settings.locator('input[name=minDelay]').fill('1')
    await settings.locator('input[name=maxDelay]').fill('4')
    await settings.locator('button[type=submit]').click()
    await expect(page.locator('#toast')).to_contain_text('Saved')
    await page.reload()
    await expect(page.locator('#settings-form input[name=topics]')).to_have_value('AI, robotics, chips')
    await expect(page.locator('#settings-form input[name=maxDelay]')).to_have_value('4')


async def runs_log(page, base):
    await draft_one(page, base)
    await open_info_section(page, 'runs')
    card = page.locator('#inspector .run-card')
    await expect(card).to_have_count(1)
    await expect(card).to_contain_text('Draft a reply')
    await expect(card.locator('.tag')).to_have_text('completed')
    await expect(card.locator('.run-step')).to_have_count(5)


async def sheet_keyboard(page, base):
    await open_app(page, base)
    trigger = page.locator('#sidebar .new-chat')
    await trigger.focus()
    await page.keyboard.press('Enter')
    sheet = page.locator('#modal .sheet')
    await expect(sheet).to_be_visible()
    await page.locator('#modal [data-action="new-bot"]').click()
    await expect(page.locator('#new-bot-form')).to_be_visible()
    inside = "() => document.getElementById('modal').contains(document.activeElement)"
    seen = set()
    # Tab forwards and backwards past both ends: focus never leaves the sheet.
    for _ in range(18):
        await page.keyboard.press('Tab')
        assert await page.evaluate(inside), 'Tab escaped the sheet'
        seen.add(await page.evaluate('document.activeElement.outerHTML.slice(0, 60)'))
    assert len(seen) >= 5, seen
    for _ in range(18):
        await page.keyboard.press('Shift+Tab')
        assert await page.evaluate(inside), 'Shift+Tab escaped the sheet'
    # Clicking the backdrop closes it; so does Escape; focus goes back to the opener.
    await page.keyboard.press('Escape')
    await expect(sheet).to_be_hidden()
    await expect(trigger).to_be_focused()
    await trigger.click()
    await page.locator('#modal').click(position={'x': 5, 'y': 5})
    await expect(page.locator('#modal')).to_be_hidden()
    # The command palette traps Tab as well.
    await page.keyboard.press('Control+k')
    await expect(page.locator('#command-input')).to_be_focused()
    for _ in range(6):
        await page.keyboard.press('Tab')
        assert await page.evaluate("() => document.getElementById('command').contains(document.activeElement)"), 'Tab escaped the palette'
    await page.keyboard.press('Escape')
    # Sheets declare themselves as modal dialogs.
    await trigger.click()
    await expect(page.locator('#modal [role=dialog][aria-modal=true]')).to_have_count(1)


async def phone_create_bot(page, base):
    await open_app(page, base)
    await page.locator('.fab').click()
    await page.locator('#modal [data-action="new-bot"]').click()
    await page.get_by_label('Bot template').select_option('research')
    await expect(page.locator('#new-bot-form input[name=name]')).to_have_value('Researcher')
    await page.locator('#new-bot-form input[name=name]').fill('Market scanner')
    await page.locator('#new-bot-form button[type=submit]').click()
    await expect(page.locator('body')).to_have_attribute('data-pane', 'main')
    await expect(page.locator('.thread-title strong')).to_have_text('Market scanner')
    assert await overflow(page) <= 0
    await page.locator('#thread-head .back').click()
    await expect(page.locator('body')).to_have_attribute('data-pane', 'list')
    await expect(page.locator('.chat-row', has_text='Market scanner')).to_have_count(1)


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
            await h.scenario('draft: approve -> ready -> posted via confirm sheet', approve_to_posted)
            await h.scenario('draft: edit, cancel, rewrite, skip', edit_skip_rewrite)
            await h.scenario('drafts list: filters persist', draft_filters)
            await h.scenario('posts: share via + sheet, search and filters', share_and_find_post)
            await h.scenario('posts: remove and reload samples', load_and_remove_samples)
            await h.scenario('bot: create from template and land in its chat', create_bot_from_template)
            await h.scenario('group: create and add a bot', create_group)
            await h.scenario('bot: edit profile survives reload', edit_profile_persists)
            await h.scenario('bot: pin sorts to top and persists', pin_bot)
            await h.scenario('bot: duplicate', duplicate_bot)
            await h.scenario('conversation: clear via confirm sheet', clear_conversation)
            await h.scenario('reminders: create, validate toggle, remove', reminders)
            await h.scenario('voice settings save and persist', voice_settings)
            await h.scenario('runs log shows the handoff trace', runs_log)
            await h.scenario('keyboard: Tab trapped in sheets and palette, Esc restores focus', sheet_keyboard)
            await h.scenario('phone: create a bot from the + button', phone_create_bot, PHONE)
            await browser.close()
            server.shutdown()
        failed = [name for name, error in h.results if error]
        if failed:
            print(f'USABILITY SMOKE FAIL: {len(failed)} of {len(h.results)} scenarios: {failed}')
            return 1
        print(f'USABILITY SMOKE PASS: {len(h.results)} scenarios; draft lifecycle, posts, bots, pins, clear, reminders, sheets, keyboard, no console errors')
        return 0
    finally:
        shutil.rmtree(site_dir, ignore_errors=True)


sys.exit(asyncio.run(main()))
