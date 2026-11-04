import asyncio, sys
from playwright.async_api import async_playwright
BASE=__import__('os').environ.get('BASE','http://localhost:8766')
LOCAL='/workspace/esp32-remote/sim-site/js/examples.js'
NAMES=sys.argv[1:] or ['traffic','reaction','simon','weather','dice','stopwatch','vumeter','morse','snake','pong','level']
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--no-sandbox'])
        ctx=await b.new_context(viewport={'width':1500,'height':950})
        await ctx.route('**/js/examples.js*', lambda r: r.fulfill(path=LOCAL, content_type='application/javascript'))
        pg=await ctx.new_page(); errs=[]; pg.on('pageerror',lambda e: errs.append(str(e)))
        for n in NAMES:
            await pg.goto(f'{BASE}/?ex={n}'); await pg.wait_for_timeout(1800)
            await pg.keyboard.press('f'); await pg.wait_for_timeout(500)
            await pg.screenshot(path=f'shots/{n}.png')
            print(n, await pg.evaluate('app.proj.name'), errs)
        await b.close()
asyncio.run(main())
