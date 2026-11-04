import asyncio,time,json,sys
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--no-sandbox'])
        pg=await b.new_page(); await pg.goto('http://localhost:8766/?ex=level'); await pg.wait_for_timeout(1500)
        await pg.evaluate("(c)=>{document.querySelector('#code').value=c;}", open(sys.argv[1]).read())
        await pg.evaluate("app.editor && app.editor.setCode ? app.editor.setCode(app.proj.code) : 0")
        await pg.evaluate('app.cmd.run()'); t0=time.time()
        await pg.wait_for_timeout(int(sys.argv[2]) if len(sys.argv)>2 else 15000)
        s=await pg.evaluate('app.serialText'); print('wall',round(time.time()-t0,1)); print(s[-600:])
        await b.close()
asyncio.run(main())
