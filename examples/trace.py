import asyncio,sys,json
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--no-sandbox'])
        pg=await b.new_page(); await pg.goto('http://localhost:8766/?ex=i2c'); await pg.wait_for_timeout(1500)
        await pg.evaluate("""(()=>{window.TR=[];const P=I2CDev.SSD1306.prototype;const OW=WebSocket.prototype.send;window.RX=[];const c=P.command;P.command=function(b){if(TR.length<400)TR.push(['c',b,this.cmd.slice()]);return c.call(this,b)};const s=P.start;P.start=function(r){if(TR.length<400)TR.push(['S']);return s.call(this,r)}})()""")
        await pg.evaluate("(()=>{const add=WebSocket.prototype.addEventListener;WebSocket.prototype.addEventListener=function(t,f,o){if(t==='message'){const g=f;f=function(e){try{const m=JSON.parse(e.data);if(m.t==='i2c'&&RX.length<60)RX.push(m)}catch(x){};return g.call(this,e)}}return add.call(this,t,f,o)};})()"); await pg.evaluate('app.cmd.run()'); await pg.wait_for_timeout(9000)
        print(json.dumps(await pg.evaluate("RX.slice(0,30)"))[:2500])
        print(await pg.evaluate("(()=>{const o=app.i2c.OLED1;return {on:o.on,mode:o.mode,c0:o.c0,c1:o.c1,p0:o.p0,p1:o.p1,contrast:o.contrast,inv:o.inv,nz:o.fb.filter(x=>x).length}})()"))
        await pg.evaluate('app.cmd.stop()'); await pg.wait_for_timeout(500); await b.close()
asyncio.run(main())
