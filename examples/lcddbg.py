import asyncio, json
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--no-sandbox'])
        pg=await (await b.new_context(viewport={'width':1500,'height':950})).new_page()
        await pg.goto('http://localhost:8766/?ex=lcdclock'); await pg.wait_for_timeout(1500)
        await pg.evaluate("""(()=>{const L=I2CDev.LCD1602.prototype; window.TR=[]; const s=L.start, w=L.write, st=L.stop;
          L.start=function(r){TR.push('S'+(r?'r':'')+(this.half===null?'':'H')); return s.call(this,r)}; L.write=function(b){TR.push(b.toString(16)); return w.call(this,b)}; L.stop=function(){TR.push('P'); return st.call(this)};
          app.cmd.run();})()""")
        for i in range(60):
            await pg.wait_for_timeout(500)
            if 'LCD clock running' in await pg.evaluate('app.serialText'): break
        await pg.wait_for_timeout(1500)
        await pg.evaluate('TR.length=0')
        for k in ['m','+','+','+','m','m']+['m','+','m','m']*3:
            await pg.keyboard.down(k); await pg.wait_for_timeout(150); await pg.keyboard.up(k); await pg.wait_for_timeout(250)
            t=await pg.evaluate('app.i2c.LCD1.text()')
            if '?' in t.replace('21?C','') : print('DESYNC after', k, repr(t)); break
        await pg.wait_for_timeout(1000)
        tr=await pg.evaluate('TR'); txt=await pg.evaluate('app.i2c.LCD1.text()')
        print(txt)
        # find transactions with byte count != 1
        cur=[]; bad=[]; seqs=[]
        for x in tr:
            if x.startswith('S'): cur=[x]
            elif x=='P': seqs.append(cur); 
            else: cur.append(x)
        from collections import Counter
        print(Counter(len(s)-1 for s in seqs)); print([s for s in seqs if len(s)!=2][:20]); print(len(tr))
        await pg.evaluate('app.cmd.stop()'); await b.close()
asyncio.run(main())
