import asyncio, time
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--no-sandbox'])
        ctx=await b.new_context(viewport={'width':1500,'height':950})
        await ctx.route('**/js/examples.js*', lambda r: r.fulfill(path='/workspace/esp32-remote/sim-site/js/examples.js', content_type='application/javascript'))
        pg=await ctx.new_page()
        await pg.goto('http://localhost:8766/?ex=thermostat'); await pg.wait_for_timeout(1500)
        await pg.evaluate("""(()=>{window.LOG=[]; const t0=performance.now(); const ws0=WebSocket.prototype.send; WebSocket.prototype.send=function(d){ if(/"t":"(in|inv)"/.test(d)) LOG.push([Math.round(performance.now()-t0),'>',d.slice(0,60)]); return ws0.call(this,d)};
          const P0=app.sim.partState.bind(app.sim); app.cmd.run(); window.T0=t0;})()""")
        for i in range(80):
            await pg.wait_for_timeout(500)
            if 'T=' in await pg.evaluate('app.serialText'): break
        await pg.wait_for_timeout(500)
        for i in range(12):
            t=await pg.evaluate('Math.round(performance.now()-T0)')
            await pg.keyboard.down('ArrowUp'); await pg.wait_for_timeout(200); await pg.keyboard.up('ArrowUp'); await pg.wait_for_timeout(200)
            print('tap',i,t)
        await pg.wait_for_timeout(2000)
        ser=await pg.evaluate('app.serialText'); print(ser[-900:])
        log=await pg.evaluate('LOG'); print(len(log))
        for l in log[-80:]: print(l)
        await pg.evaluate('app.cmd.stop()'); await b.close()
asyncio.run(main())
