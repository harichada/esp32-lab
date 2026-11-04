"""Long-run resilience test: a QEMU run must survive websocket drops. Usage:
  python3 resume_ui.py [base_url] [minutes] [ngrok_pid]
Forces a ws close at ~1 min, (optionally) freezes the ngrok agent for 70 s at ~4 min (SIGSTOP -> real heartbeat timeout,
same failure as in production), and checks every 30 s that the same server session keeps running (GPIO traffic grows,
QEMU pid unchanged). Remote keys are pressed after each drop to prove the firmware still reacts."""
import asyncio, sys, os, time, signal, subprocess
from playwright.async_api import async_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8765'; MIN = float(sys.argv[2]) if len(sys.argv) > 2 else 3
NG = int(sys.argv[3]) if len(sys.argv) > 3 else 0
T = os.environ.get('SIM_TOKEN') or open('/tmp/sim_token').read().strip()
def qpids(): return subprocess.run(['pgrep', '-f', 'qemu-system-xtensa'], capture_output=True, text=True).stdout.split()
async def main():
  fails = []; log = lambda *a: print(time.strftime('%H:%M:%S'), *a, flush=True)
  async with async_playwright() as p:
    b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx = await b.new_context(viewport={'width': 1600, 'height': 900}, extra_http_headers={'ngrok-skip-browser-warning': '1'})
    pg = await ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    await pg.goto(BASE + '/?ex=remote&t=' + T); await pg.wait_for_timeout(3000)
    await pg.evaluate("document.querySelector('#bRun').click()")
    for i in range(150):
      await pg.wait_for_timeout(1000)
      if 'lwIP up' in await pg.evaluate('app.serialText'): break
    await pg.wait_for_timeout(5000)
    sid = await pg.evaluate('app.run && app.run.sid'); qp = qpids(); log('run started sid', sid, 'qemu', qp)
    async def tap(k):
      await pg.keyboard.down(k); await pg.wait_for_timeout(100); await pg.keyboard.up(k); await pg.wait_for_timeout(2500)
    async def tv(): return await pg.evaluate('app.world.tv.power')
    async def flip(): q = await tv(); await tap('2' if q == 'on' else '1'); return q, await tv()   # 1 = Sony on, 2 = Sony off
    p0 = await tv(); await tap('1'); p1 = await tv(); log('key 1: tv', p0, '->', p1)
    if p0 == p1: fails.append('key before drops had no effect')
    t0 = time.time(); last = await pg.evaluate('app.gpioCount||0'); did_ws = did_ng = False; n = 0
    while time.time() - t0 < MIN * 60:
      await pg.wait_for_timeout(30000); n += 1; el = time.time() - t0
      st = await pg.evaluate("({run:!!app.run, sid:app.run&&app.run.sid, g:app.gpioCount||0, s:document.querySelector('#stText').textContent, n:app.run&&app.run.lastN, res:document.body.classList.contains('reconnecting')})")
      log(f'{el/60:5.1f} min', st, 'qemu', qpids())
      if not st['run'] or st['sid'] != sid: fails.append(f'run lost at {el:.0f}s: {st}'); break
      if st['g'] <= last and not st['res']: fails.append(f'no GPIO progress at {el:.0f}s')
      last = st['g']
      if not did_ws and el > 60:
        did_ws = True; log('>>> forcing websocket close'); await pg.evaluate('app.run.ws.close()')
        await pg.wait_for_timeout(6000); q, r = await flip(); log('after ws drop, power key: tv', q, '->', r)
        if q == r: fails.append('key after forced ws close had no effect')
      if NG and not did_ng and el > 240:
        did_ng = True; log('>>> freezing ngrok agent 70 s (heartbeat timeout)'); os.kill(NG, signal.SIGSTOP)
        await pg.wait_for_timeout(70000); os.kill(NG, signal.SIGCONT); log('>>> ngrok resumed')
        for i in range(60):
          await pg.wait_for_timeout(2000)
          if not await pg.evaluate("document.body.classList.contains('reconnecting')") and await pg.evaluate('app.run && app.run.ws && app.run.ws.readyState===1'): break
        log('reconnected after', 2 * i, 's'); q, r = await flip(); log('after ngrok drop, power key: tv', q, '->', r)
        if q == r: fails.append('key after ngrok session drop had no effect')
    if qpids() != qp: fails.append(f'qemu pid changed {qp} -> {qpids()}')
    ser = await pg.evaluate('app.serialText'); nl = await pg.evaluate('app.netlog.text()')
    log('resumed lines in netlog:', nl.count('websocket resumed'), '| errors:', errs[:3])
    if did_ws and nl.count('websocket resumed') < 1: fails.append('no resume recorded')
    if errs: fails.append('page errors: ' + '; '.join(errs[:3]))
    await pg.evaluate("document.querySelector('#bStop').click()"); await b.close()
  for f in fails: print('FAIL', f)
  print('PASS run survived' if not fails else 'FAILED'); sys.exit(1 if fails else 0)
asyncio.run(main())
