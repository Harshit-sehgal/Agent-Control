"""Browser smoke test for GitHub Pages dashboard visuals and navigation.
No network, browser credentials, or external X interactions.
"""
import asyncio
import re
from pathlib import Path
from playwright.async_api import async_playwright

ROOT=Path(__file__).resolve().parents[1]

def strip_imports(text):
    """Remove ESM import statements (single or multi-line) for concatenation."""
    text=re.sub(r"import\s*\{[^}]*\}\s*from\s*'[^']*';",'',text,flags=re.S)
    return re.sub(r"import\s+[^\n]*?from\s*'[^']*';",'',text)

def inline_html():
    html=(ROOT/'shared/index.html').read_text()
    css=(ROOT/'shared/app.css').read_text()+'\n'+(ROOT/'shared/polish.css').read_text()
    html=html.replace('<link rel="stylesheet" href="./app.css">\n<link rel="stylesheet" href="./polish.css">','<style>'+css+'</style>')
    for tag in ['<script type="module" src="./local-api.js"></script>','<script defer src="./transport.js"></script>','<script type="module" src="./app.js"></script>']:
        html=html.replace(tag,'')
    return html

# Browser-safe modules concatenated in dependency order, with imports stripped.
MODULES=['core.js','workflow.js','coordination.js','group-simulator.js','chat-engine.js','usability.js','local-api.js','app.js']

async def boot(page):
    await page.goto('about:blank')
    await page.set_content(inline_html(),wait_until='domcontentloaded')
    await page.evaluate("""() => {const memory={}; Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:k=>memory[k]??null,setItem:(k,v)=>{memory[k]=v}}});crypto.randomUUID=()=>String(Date.now())+'-'+Math.random().toString(16).slice(2);}""")
    scripts=[]
    for filename in MODULES:
        part=strip_imports((ROOT/'shared'/filename).read_text())
        part=part.replace('export const ','const ').replace('export function ','function ').replace('export async function ','async function ')
        scripts.append(part)
        if filename=='local-api.js': scripts.append('window.AGENT_API=window.AGENT_LOCAL_API;')
    await page.add_script_tag(content='\n'.join(scripts))
    await page.get_by_role('button',name='Create new bot').first.wait_for()

async def main():
    async with async_playwright() as p:
        browser=await p.chromium.launch(headless=True,args=['--no-sandbox'])
        page=await browser.new_page(viewport={'width':1440,'height':900},device_scale_factor=1)
        page.set_default_timeout(5000)
        errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        await boot(page)
        await page.screenshot(path=str(ROOT/'ui-home.png'),full_page=True)
        await page.keyboard.press('Control+k')
        await page.get_by_role('dialog',name='Quick navigation').wait_for()
        await page.locator('#command-input').fill('Reviewer')
        await page.get_by_role('option',name='Reviewer').wait_for()
        await page.keyboard.press('Enter')
        await page.get_by_role('heading',name='Reviewer',exact=True).wait_for()
        assert await page.locator('#command').evaluate("e=>e.classList.contains('hidden')")
        await page.screenshot(path=str(ROOT/'ui-chat.png'),full_page=True)
        await page.keyboard.press('Control+k')
        await page.locator('#command-input').fill('X-engage')
        await page.locator('#command-results .command-item').first.click()
        await page.get_by_role('heading',name='X-engage',exact=True).wait_for()
        await page.screenshot(path=str(ROOT/'ui-group.png'),full_page=True)
        await page.get_by_role('button',name='Group chat').first.click()
        await page.get_by_role('heading',name='X-engage group chat',exact=True).wait_for()
        await page.locator('#chat-form textarea').fill('Prepare a reply for the latest candidate')
        await page.locator('#chat-form').evaluate('(f)=>f.requestSubmit()')
        await page.get_by_text('Coordination complete:',exact=False).wait_for(timeout=6000)
        assert await page.locator('.message-speaker').count()>=4
        await page.keyboard.press('Control+k')
        await page.keyboard.press('Escape')
        assert await page.locator('#command').evaluate("e=>e.classList.contains('hidden')")
        # In a narrow viewport, the sidebar starts closed and opens via the menu.
        phone=await browser.new_page(viewport={'width':390,'height':844},device_scale_factor=1)
        phone_errors=[];phone.on('pageerror',lambda e:phone_errors.append(str(e)))
        await boot(phone)
        await phone.screenshot(path=str(ROOT/'ui-mobile.png'),full_page=True)
        await phone.get_by_role('button',name='Open menu').click()
        assert await phone.locator('#sidebar').evaluate("e=>e.classList.contains('mobile-open')")
        await phone.get_by_role('button',name='X-engage').first.click()
        assert not await phone.locator('#sidebar').evaluate("e=>e.classList.contains('mobile-open')")
        await phone.get_by_role('heading',name='X-engage',exact=True).wait_for()
        await phone.wait_for_timeout(300)  # wait for sidebar slide-out animation
        await phone.screenshot(path=str(ROOT/'ui-mobile-group.png'),full_page=True)
        assert not errors,errors
        assert not phone_errors,phone_errors
        print('POLISH SMOKE PASS: desktop, quick search, bot chat, coordination, mobile menu; no page errors')
        await browser.close()

asyncio.run(main())
