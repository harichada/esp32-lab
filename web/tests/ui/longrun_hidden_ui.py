"""Regression for the 12:33/12:51 'emulator stopped' incident. Usage: python3 longrun_hidden_ui.py [base_url] [ngrok_pid]
1) run the remote example, 2) hide+freeze the tab (CDP lifecycle 'frozen' = what Chrome does to background tabs) and at the
same time freeze ngrok for 70 s (real tunnel session drop), keep the tab frozen 200 s total (> the old 120 s grace),
3) unfreeze -> the same QEMU session must resume, 4) start 3 other runs from a second page (old code evicted the detached
run to make room), 5) reload the tab -> it must re-attach to the same session from sessionStorage, keys must still work."""
import asyncio, sys, os, time, signal, subprocess
from playwright.async_api import async_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8765'; NG = int(sys.argv[2]) if len(sys.argv) > 2 else 0
T = os.environ.get('SIM_TOKEN') or open('/tmp/sim_token').read().strip()
def qpids(): return sorted(subprocess.run(['pgrep', '-f', 'qemu-system-xtensa'], capture_output=True, text=True).stdout.split())
log = lambda *a: print(time.strftime('%H:%M:%S'), *a, flush=True)
async def main():
  fails = []
  async with async_playwright() as p:
    b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx = await b.new_context(viewport={'width': 1400, 'height': 860}, extra_http_headers={'ngrok-skip-browser-warning': '1'})
    pg = await ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    await pg.goto(BASE + '/?ex=remote&t=' + T); await pg.wait_for_timeout(3000)
    await pg.evaluate("document.querySelector('#bRun').click()")
    for i in range(150):
      await pg.wait_for_timeout(1000)
      if 'lwIP up' in await pg.evaluate('app.serialText'): break
    await pg.wait_for_timeout(4000)
    sid = await pg.evaluate('app.run && app.run.sid'); qp = qpids(); log('run sid', sid, 'qemu', qp)
    async def tap(k): await pg.keyboard.down(k); await pg.wait_for_timeout(100); await pg.keyboard.up(k); await pg.wait_for_timeout(2500)
    async def flip(what):
      q = await pg.evaluate('app.world.tv.power')
      for _ in range(3):   # a single IR tap is occasionally missed even without any drop (see probe), so allow retries
        await tap('2' if q == 'on' else '1'); r = await pg.evaluate('app.world.tv.power')
        if r != q: break
      log(what, 'tv', q, '->', r); (q == r) and fails.append('key had no effect ' + what)
    await flip('before')
    cdp = await ctx.new_cdp_session(pg)
    log('>>> hide + freeze tab for 200 s' + (', freeze ngrok 70 s' if NG else ''))
    await cdp.send('Page.setWebLifecycleState', {'state': 'frozen'})
    if NG: os.kill(NG, signal.SIGSTOP); await asyncio.sleep(70); os.kill(NG, signal.SIGCONT); log('>>> ngrok resumed'); await asyncio.sleep(130)
    else: await asyncio.sleep(float(os.environ.get('FREEZE', '200')))
    await cdp.send('Page.setWebLifecycleState', {'state': 'active'}); log('>>> tab active again')
    for i in range(60):
      await pg.wait_for_timeout(2000)
      st = await pg.evaluate("({run:!!app.run, sid:app.run&&app.run.sid, open:!!(app.run&&app.run.ws&&app.run.ws.readyState===1), s:document.querySelector('#stText').textContent})")
      if st['open'] and st['sid'] == sid: break
    log('after unfreeze', st, 'in', 2 * i, 's')
    if not (st['run'] and st['sid'] == sid): fails.append(f'run lost after frozen tab: {st}')
    await flip('after freeze')
    # other runs (other tabs / test agents) must not evict the briefly-detached run
    await pg.evaluate('app.run.ws.close()')
    pg2 = await ctx.new_page(); await pg2.goto(BASE + '/?ex=blink&t=' + T); await pg2.wait_for_timeout(2500)
    for k in range(3):
      await pg2.evaluate("document.querySelector('#bRun').click()"); await pg2.wait_for_timeout(8000)
    await pg2.evaluate("document.querySelector('#bStop').click()"); await pg2.close()
    log('>>> reload tab (discard/reload simulation)'); await pg.reload(); 
    for i in range(40):
      await pg.wait_for_timeout(1500)
      st = await pg.evaluate("({sid:app.run&&app.run.sid, open:!!(app.run&&app.run.ws&&app.run.ws.readyState===1)})")
      if st['open']: break
    log('after reload', st)
    if st['sid'] != sid: fails.append(f'reload did not re-attach: {st}')
    await pg.wait_for_timeout(3000); await flip('after reload')
    if qp[-1] not in qpids(): fails.append(f'original qemu gone {qp} -> {qpids()}')
    if errs: fails.append('page errors: ' + '; '.join(errs[:3]))
    await pg.evaluate("document.querySelector('#bStop').click()"); await pg.wait_for_timeout(2000); await b.close()
  for f in fails: print('FAIL', f)
  print('PASS' if not fails else 'FAILED'); sys.exit(1 if fails else 0)
asyncio.run(main())
