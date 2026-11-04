import asyncio, sys
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--no-sandbox'])
        for n in sys.argv[1:]:
            pg=await (await b.new_context(viewport={'width':1500,'height':950})).new_page()
            await pg.goto(f'http://localhost:8766/?ex={n}'); await pg.wait_for_timeout(2000)
            await pg.screenshot(path=f'shots/circ_{n}.png')
        await b.close()
asyncio.run(main())
