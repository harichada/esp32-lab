import asyncio,sys,time
from playwright.async_api import async_playwright
async def main():
    base,ex,secs=sys.argv[1],sys.argv[2],int(sys.argv[3])
    async with async_playwright() as p:
        b=await p.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--no-sandbox'])
        ctx=await b.new_context()
        await ctx.route('**/js/examples.js*', lambda r: r.fulfill(path='/workspace/esp32-remote/sim-site/js/examples.js', content_type='application/javascript'))
        pg=await ctx.new_page(); await pg.goto(f'{base}/?ex={ex}'); await pg.wait_for_timeout(1500)
        await pg.evaluate('app.cmd.run()'); await pg.wait_for_timeout(secs*1000)
        s=await pg.evaluate('app.serialText'); print(s[s.find('entry'):][-700:]); await b.close()
asyncio.run(main())
