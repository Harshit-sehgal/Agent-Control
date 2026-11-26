"""Launch the browser the smokes drive.

Playwright's own Chromium build is used when it is installed (`python3 -m playwright install chromium`). When it is
not, the smokes fall back to the Google Chrome installed on the machine, so `npm run test:ui` runs without a separate
browser download.
"""

MISSING = "Executable doesn't exist"
NOTE = '  note: Playwright Chromium is not installed; using the installed Google Chrome'


async def launch_chromium(p, **options):
    try:
        return await p.chromium.launch(**options)
    except Exception as error:
        if MISSING not in str(error):
            raise
        print(NOTE)
        return await p.chromium.launch(channel='chrome', **options)


def launch_chromium_sync(p, **options):
    try:
        return p.chromium.launch(**options)
    except Exception as error:
        if MISSING not in str(error):
            raise
        print(NOTE)
        return p.chromium.launch(channel='chrome', **options)
