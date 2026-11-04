"""Capture UI screenshots: python3 screens.py <prefix> [base_url] [width] -> screenshots/<prefix>_*.png"""
import asyncio, os, sys
from playwright.async_api import async_playwright
PRE = sys.argv[1] if len(sys.argv) > 1 else 'after'; BASE = sys.argv[2] if len(sys.argv) > 2 else 'http://127.0.0.1:8765'
W = int(sys.argv[3]) if len(sys.argv) > 3 else 1600; H = 900 if W < 1700 else 1080
TOK = os.environ.get('SIM_TOKEN') or open('/tmp/sim_token').read().strip()
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'screenshots')
async def tab(pg, t):
    await pg.evaluate(f"(()=>{{const b=document.querySelector('[data-tab={t}]');if(b)b.click()}})()"); await pg.wait_for_timeout(400)
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        ctx = await b.new_context(viewport={'width': W, 'height': H}, extra_http_headers={'ngrok-skip-browser-warning': '1'}); pg = await ctx.new_page()
        sh = lambda n: pg.screenshot(path=os.path.join(OUT, f'{PRE}_{n}.png'))
        await pg.goto(f'{BASE}/?t={TOK}&ex=blink'); await pg.wait_for_timeout(2500); await sh('home')
        await pg.goto(f'{BASE}/?ex=remote'); await pg.wait_for_timeout(3000)
        await pg.click('#bRun')
        for i in range(90):
            await pg.wait_for_timeout(1000)
            if 'VBAT' in await pg.evaluate('app.serialText'): break
        for k in ['1', '=', 'e']:
            await pg.keyboard.down(k); await pg.wait_for_timeout(100); await pg.keyboard.up(k); await pg.wait_for_timeout(1500)
        await pg.wait_for_timeout(2500); await tab(pg, 'serial'); await sh('remote_running')
        await tab(pg, 'net'); await sh('network'); await tab(pg, 'dev'); await sh('devices')
        await pg.click('#bStop'); await pg.goto(f'{BASE}/?ex=blank'); await pg.wait_for_timeout(2500)
        esp = await pg.evaluate("(()=>{const p=app.proj.parts.find(q=>q.type==='esp32');const d=Parts.T.esp32.pins(p).find(q=>q.name==='D4');const w=Parts.pinWorld(p,d);const s=document.querySelector('#stage');const q=s.createSVGPoint();q.x=w.x;q.y=w.y;const r=q.matrixTransform(s.getScreenCTM());return [r.x,r.y]})()")
        await pg.mouse.move(*esp); await pg.wait_for_timeout(200); await pg.mouse.click(*esp); await pg.mouse.move(esp[0] + 160, esp[1] - 120, steps=5); await pg.wait_for_timeout(300); await sh('wiring')
        await pg.keyboard.press('Escape'); await pg.click('#bProjects'); await pg.wait_for_timeout(400); await sh('projects')
        await tab(pg, 'code'); await pg.keyboard.press('Escape'); await pg.evaluate("document.querySelector('#projDlg')&&(document.querySelector('#projDlg').hidden=true)"); await sh('code')
        await b.close()
asyncio.run(main())
