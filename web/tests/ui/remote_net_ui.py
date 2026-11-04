"""Headless-Chrome test of the Wi-Fi remote + Network log tab: quick (80 ms) key taps must reach the firmware, the virtual
TV/Roku/Eco must change and the Network tab must show WiFi/DHCP/DNS/TCP/HTTP/UDP. Usage: python3 remote_net_ui.py [base_url]
(token from SIM_TOKEN or /tmp/sim_token; works through ngrok)."""
import asyncio, sys, os, json, re
from playwright.async_api import async_playwright
BASE=sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:8765'; T=os.environ.get('SIM_TOKEN') or (open('/tmp/sim_token').read().strip() if os.path.exists('/tmp/sim_token') else '')
async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--no-sandbox'])
    ctx=await b.new_context(viewport={'width':1600,'height':900},extra_http_headers={'ngrok-skip-browser-warning':'1'})
    pg=await ctx.new_page(); errs=[]
    pg.on('pageerror',lambda e:errs.append(str(e))); pg.on('console',lambda m: errs.append('console:'+m.text) if m.type=='error' else None)
    await pg.goto(BASE+'/?ex=remote&t='+T); await pg.wait_for_timeout(3000)
    await pg.evaluate("document.querySelector('#bRun')?.click()")
    for i in range(150):
      await pg.wait_for_timeout(1000)
      if 'lwIP up' in await pg.evaluate('app.serialText') : break
    await pg.wait_for_timeout(1500)
    await pg.wait_for_timeout(4000)
    for k in os.environ.get('KEYS','1 = o ArrowUp o e').split():
      await pg.keyboard.down(k); await pg.wait_for_timeout(int(os.environ.get('HOLD','80'))); await pg.keyboard.up(k); await pg.wait_for_timeout(1500)
    await pg.wait_for_timeout(3000)
    w=await pg.evaluate('({tv:app.world.tv,roku:app.world.roku,eco:app.world.eco})'); nl=await pg.evaluate('app.netlog.text()'); ser=await pg.evaluate('app.serialText')
    await pg.click('#tabs button[data-tab=net]'); await pg.wait_for_timeout(400)
    vis=await pg.evaluate("getComputedStyle(document.querySelector('#tab-net')).display!=='none' && document.querySelectorAll('#netPanel .nlr').length")
    await pg.fill('#netFilter','8060'); await pg.wait_for_timeout(300); nf=await pg.evaluate("document.querySelectorAll('#netPanel .nlr').length")
    await pg.screenshot(path=os.path.join(os.path.dirname(os.path.abspath(__file__)),'remote_net.png'))
    ok=[('TV powered on by key 1 (IR + JSON-RPC)', w['tv']['power']=='on'), ('Vol+ via IRCC changed volume', w['tv']['volume']==13),
        ('Roku cursor moved by ECP keypress/Up', w['roku']['cur']==4), ('Eco plug toggled ON over UDP', w['eco']['on']),
        ('netlog has DHCP ACK', 'DHCP ACK' in nl), ('netlog has DNS', 'DNS host.wokwi.internal' in nl), ('netlog has TCP connect', 'TCP connect' in nl),
        ('netlog has HTTP status+latency', re.search(r'-> 200 \(\d+ B, \d+ ms\)', nl) is not None), ('netlog has UDP send/recv', 'UDP send' in nl and 'UDP recv' in nl),
        ('netlog has device reactions', 'DEV ' in nl), ('firmware [net] lines on Serial', '[net] WiFi connected' in ser), ('Network tab renders rows', bool(vis)),
        ('filter narrows rows', 0 < nf < vis), ('no page errors', not errs)]
    for n,c in ok: print(('PASS ' if c else 'FAIL ')+n)
    if not all(c for _,c in ok): print(nl[-3000:]); print(errs)
    await b.close(); sys.exit(0 if all(c for _,c in ok) else 1)
asyncio.run(main())
