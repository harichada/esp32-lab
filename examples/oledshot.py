import asyncio,sys
from playwright.async_api import async_playwright
async def main():
    base,ex,secs=sys.argv[1],sys.argv[2],int(sys.argv[3])
    async with async_playwright() as p:
        b=await p.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--no-sandbox'])
        pg=await b.new_page(viewport={'width':1500,'height':950}); await pg.goto(f'{base}/?ex={ex}'); await pg.wait_for_timeout(1500)
        await pg.evaluate('app.cmd.run()'); await pg.wait_for_timeout(secs*1000)
        u=await pg.evaluate("(()=>{const q=app.proj.parts.find(p=>p.id==='OLED1'); return app.sim.partState(q).img})()")
        import base64; open(f'shots/real_{ex}.png','wb').write(base64.b64decode(u.split(',')[1]))
        await pg.screenshot(path=f'shots/page_{ex}.png')
        await pg.evaluate('app.cmd.stop()'); await pg.wait_for_timeout(500); await b.close()
asyncio.run(main())
