"""Headless-Chrome checks for the MSO-4 instrument suite. Usage: python3 scope_ui.py [base_url] [shots_dir] [--qemu]"""
import asyncio, sys, os, json
from playwright.async_api import async_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8799'
OUT = sys.argv[2] if len(sys.argv) > 2 else '/workspace/scope-shots'
QEMU = '--qemu' in sys.argv
TOK = os.environ.get('SIM_TOKEN', ''); TQ = ('t=' + TOK + '&') if TOK else ''
os.makedirs(OUT, exist_ok=True); results = []
def check(n, ok, info=''): results.append({'name': n, 'ok': bool(ok), 'info': str(info)[:300]}); print(('PASS ' if ok else 'FAIL ') + n + (' — ' + str(info)[:300] if info else ''))
SCREEN = "([x,y])=>{const s=document.querySelector('#stage');const p=s.createSVGPoint();p.x=x;p.y=y;const q=p.matrixTransform(s.getScreenCTM());return [q.x,q.y]}"
PINW = "([id,n])=>{const e=app.proj.parts.find(p=>p.id===id);const q=Parts.T[e.type].pins(e).find(p=>p.name===n);return Parts.pinWorld(e,q)}"
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'])
        pg = await b.new_page(viewport={'width': 1600, 'height': 1000}); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto(BASE + '/?' + TQ + 'ex=ic_555blink&resume=0'); await pg.wait_for_timeout(1500)
        await pg.click('#tabs [data-tab=scope]'); await pg.wait_for_timeout(300)
        # probe OUT by clicking the pin with PROBE armed
        await pg.click('#scopeInst [data-a=probe]')
        out = await pg.evaluate(PINW, ['U1', 'OUT']); s = await pg.evaluate(SCREEN, [out['x'], out['y']])
        w0 = await pg.evaluate('app.proj.wires.length')
        await pg.mouse.click(*s); await pg.wait_for_timeout(200)
        st = await pg.evaluate('Instruments.state()')
        check('armed PROBE + click on 555 OUT pin assigns CH1 (no wire started)', st['ch'][0]['on'] and 'OUT' in (st['ch'][0]['label'] or '') and await pg.evaluate('app.proj.wires.length') == w0 and not await pg.evaluate('!!(app.editor.mode&&app.editor.mode.k==="wire")'), st['ch'][0])
        # LED anode via Inspector -> probe button
        await pg.evaluate("app.editor.select({part:'LED1'})"); await pg.wait_for_timeout(400)
        await pg.click('#pinTable button[data-probe*=\'"pin":"A"\']'); await pg.wait_for_timeout(200)
        st = await pg.evaluate('Instruments.state()'); check('Inspector ⌁ on LED anode assigns CH2', st['ch'][1]['on'] and 'LED1.A' in st['ch'][1]['label'], st['ch'][1])
        await pg.click('#pinTable button[data-watch*=\'"pin":"A"\']'); await pg.click('#pinTable button[data-watch*=\'"pin":"C"\']')
        await pg.evaluate("app.editor.select({part:'C1'})"); await pg.wait_for_timeout(300); await pg.click('#pinTable button[data-watch*=\'"pin":"+"\']')
        await pg.click('#bRun'); await pg.wait_for_timeout(5000)
        await pg.evaluate("Instruments.tdiv=0.2; Instruments.trig.level=4; Instruments.renderUi()"); await pg.wait_for_timeout(1500)
        m1 = await pg.evaluate('Instruments.measure(1)'); m2 = await pg.evaluate('Instruments.measure(2)'); st = await pg.evaluate('Instruments.state()')
        check('CH1 555 OUT is a square wave (Vpp > 6 V, 1–2.2 Hz)', m1 and m1['pp'] > 6 and 1 < (m1['f'] or 0) < 2.2, m1)
        check('CH2 LED anode swings ~0 ↔ ~2 V in step with OUT', m2 and 1.5 < m2['max'] < 2.6 and m2['min'] < 0.5, m2)
        check("trigger locks (TRIG'D)", st['status'] == "TRIG'D", st['status'])
        check('telemetry strip shows 3 sparklines', await pg.evaluate("document.querySelectorAll('#telStrip canvas').length") == 3 and not await pg.evaluate("document.querySelector('#telStrip').hidden"))
        await pg.screenshot(path=OUT + '/desktop_555_scope.png')
        await pg.evaluate("Instruments.cursors=true; Instruments.fft=true; Instruments.cur=[0.3,0.62]; Instruments.renderUi()"); await pg.wait_for_timeout(800)
        cr = await pg.inner_text('#instCur'); check('cursor readout shows ΔT, 1/ΔT, ΔV', 'ΔT' in cr and '1/ΔT' in cr and 'ΔV' in cr, cr.replace('\n', ' '))
        await pg.screenshot(path=OUT + '/desktop_555_cursors_fft.png')
        # canvas actually lit: count bright pixels of CH1 colour
        lit = await pg.evaluate("(()=>{const c=document.querySelector('#scopeCv');const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let n=0;for(let i=0;i<d.length;i+=4)if(d[i]>200&&d[i+1]>170&&d[i]-d[i+2]>25)n++;return n})()")
        check('scope canvas has glowing CH1 trace pixels', lit > 500, lit)
        fps = await pg.evaluate("new Promise(r=>{let n=0;const t0=performance.now();const f=()=>{n++;if(performance.now()-t0<2000)requestAnimationFrame(f);else r(n/2)};requestAnimationFrame(f)})")
        check('render loop sustains frames (headless, software GL)', fps > 20, f'{fps:.0f} fps')
        dl = await pg.evaluate("(Instruments.exportCsv(), Instruments.lastCsv.length)"); hdr = await pg.evaluate("Instruments.lastCsv[0]")
        check('CSV export has header + samples', dl > 100 and hdr.startswith('time_s,CH1'), f'{dl} rows · {hdr}')
        await pg.click('#scopeInst [data-a=run]'); fr = await pg.evaluate('Instruments.state().frozen'); await pg.click('#scopeInst [data-a=run]')
        check('RUN/STOP freezes and resumes', fr and not await pg.evaluate('Instruments.state().frozen'))
        await pg.click('#bStop')
        check('no page errors (555)', not errs, errs[:3])
        # LCD example: still loads & renders
        errs.clear(); await pg.goto(BASE + '/?' + TQ + 'ex=lcdclock&resume=0'); await pg.wait_for_timeout(1500)
        ok = await pg.evaluate("app.proj.parts.some(p=>/lcd/.test(p.type)) && document.querySelectorAll('#lParts .part').length>3")
        if QEMU:
            await pg.click('#bRun'); await pg.wait_for_function("document.querySelector('#stText').textContent.match(/running/i)", timeout=180000); await pg.wait_for_timeout(6000)
            lcd = await pg.evaluate("(()=>{const p=app.proj.parts.find(p=>/lcd/.test(p.type));const s=app.sim.partState(p);return JSON.stringify(s.lines||s.text||s.ddram||Object.keys(s))})()")
            check('LCD example runs (QEMU) and LCD has content', ok and lcd and lcd != '[]', lcd[:120]); await pg.click('#bStop')
        else: check('LCD example loads and renders', ok)
        await pg.screenshot(path=OUT + '/desktop_lcd.png')
        check('no page errors (LCD)', not errs, errs[:3])
        if QEMU:
            errs.clear(); await pg.goto(BASE + '/?' + TQ + 'ex=blink&resume=0&tab=scope'); await pg.wait_for_timeout(1500)
            await pg.evaluate("(()=>{const e=app.proj.parts.find(p=>p.type==='esp32');Instruments.probe({kind:'pin',part:e.id,pin:'D2'});Instruments.tdiv=0.5;Instruments.trig.level=1.6;Instruments.la=true;document.querySelector('#instLa').hidden=false;Instruments.renderUi()})()")
            await pg.click('#bRun'); await pg.wait_for_function("document.querySelector('#stText').textContent.match(/running/i)", timeout=180000); await pg.wait_for_timeout(9000)
            m = await pg.evaluate('Instruments.measure(1)'); st = await pg.evaluate('Instruments.state()')
            check('Blink (real firmware): GPIO2 probe shows 0↔3.3 V square wave ~0.5 Hz', m and m['pp'] > 2.5 and 0.3 < (m['f'] or 0) < 0.7, m)
            check('logic analyzer lane GPIO2 captured edges', st['lanes'][0]['n'] >= 3, st['lanes'][0])
            await pg.screenshot(path=OUT + '/desktop_blink_gpio2.png'); await pg.click('#bStop')
            check('no page errors (Blink)', not errs, errs[:3])
        # phone
        ph = await b.new_page(viewport={'width': 390, 'height': 844}, device_scale_factor=3, is_mobile=True, has_touch=True); perr = []
        ph.on('pageerror', lambda e: perr.append(str(e)))
        await ph.goto(BASE + '/?' + TQ + 'ex=ic_555blink&resume=0'); await ph.wait_for_timeout(1800)
        await ph.evaluate("Instruments.probe({kind:'pin',part:'U1',pin:'OUT'});Instruments.probe({kind:'pin',part:'C1',pin:'+'});Instruments.watchProbe({kind:'pin',part:'U1',pin:'OUT',label:'U1.OUT'})")
        await ph.evaluate('app.cmd.run()'); await ph.wait_for_timeout(1200)
        await ph.click('#mHub'); await ph.wait_for_timeout(600); await ph.screenshot(path=OUT + '/phone_dial.png')
        await ph.click('#mDial .m-tab[data-m=scope]'); await ph.wait_for_timeout(3500)
        vis = await ph.evaluate("(()=>{const r=document.querySelector('#scopeCv').getBoundingClientRect();return {w:r.width,h:r.height,inSheet:!!document.querySelector('#mScope #scopeInst'),sheet:document.body.dataset.msheet}})()")
        check('phone: dial → Scope opens full-screen HUD sheet with live canvas', vis['inSheet'] and vis['sheet'] == 'scope' and vis['w'] > 300 and vis['h'] > 200, vis)
        await ph.screenshot(path=OUT + '/phone_scope.png')
        await ph.click('#mScope .m-x'); await ph.wait_for_timeout(500)
        back = await ph.evaluate("!!document.querySelector('#tab-scope #scopeInst')"); check('phone: closing sheet returns instrument to its desktop home', back)
        await ph.wait_for_timeout(600); await ph.screenshot(path=OUT + '/phone_telemetry.png')
        tick = await ph.inner_text('#mTickT'); check('phone: telemetry ticker shows the pinned signal', 'U1.OUT' in tick, tick[:120])
        check('no page errors (phone)', not perr, perr[:3])
        await b.close()
    json.dump(results, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'scope_ui_result.json'), 'w'), indent=1)
    print('%d/%d passed' % (sum(r['ok'] for r in results), len(results)))
asyncio.run(main())
