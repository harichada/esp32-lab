"""Headless-Chrome UI tests: palette drag&drop, part drag, pin-to-pin wiring, undo, Wokwi diagram.json import,
real-firmware transistor example and Pot->PWM (ADC+LEDC through QEMU). Usage: python3 editor_ui.py [base_url]"""
import asyncio, re, json, sys, tempfile, os
from playwright.async_api import async_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8765'
TOK = os.environ.get('SIM_TOKEN') or (open('/tmp/sim_token').read().strip() if os.path.exists('/tmp/sim_token') else '')
TQ = ('t=' + TOK + '&') if TOK else ''
CHROME = os.environ.get('CHROME', '/usr/bin/google-chrome')
results = []
def check(name, ok, info=''):
    results.append({'name': name, 'ok': bool(ok), 'info': str(info)}); print(('PASS ' if ok else 'FAIL ') + name + (' — ' + str(info) if info else ''))
SCREEN = "([x,y])=>{const s=document.querySelector('#stage');const p=s.createSVGPoint();p.x=x;p.y=y;const q=p.matrixTransform(s.getScreenCTM());return [q.x,q.y]}"
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=CHROME, args=['--no-sandbox'])
        pg = await b.new_page(viewport={'width': 1600, 'height': 900}); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto(BASE + '/?' + TQ + 'ex=blank'); await pg.wait_for_timeout(1500)
        n0 = await pg.evaluate('app.proj.parts.length')
        # 1. palette drag & drop
        await pg.drag_to if False else None
        await pg.locator('.pitem[data-type=led]').drag_to(pg.locator('#stage'), target_position={'x': 700, 'y': 300})
        await pg.wait_for_timeout(300)
        n1 = await pg.evaluate('app.proj.parts.length'); led = await pg.evaluate('app.proj.parts[app.proj.parts.length-1]')
        check('palette drag&drop adds an LED', n1 == n0 + 1 and led['type'] == 'led', led)
        # 2. drag the part
        a = await pg.evaluate(SCREEN, [led['x'] + 5, led['y'] - 14])
        await pg.mouse.move(*a); await pg.mouse.down(); await pg.mouse.move(a[0] + 80, a[1] + 40, steps=8); await pg.mouse.up()
        led2 = await pg.evaluate(f"app.proj.parts.find(p=>p.id==='{led['id']}')")
        check('dragging moves the part on the 0.1" grid', (led2['x'], led2['y']) != (led['x'], led['y']) and led2['x'] % 10 == 0 and led2['y'] % 10 == 0, f"{led['x']},{led['y']} -> {led2['x']},{led2['y']}")
        # 3. wire from ESP32 D2 to LED anode (pin to pin drag)
        d2 = await pg.evaluate("(()=>{const e=app.proj.parts.find(p=>p.type==='esp32');const q=Parts.T.esp32.pins(e).find(p=>p.name==='D2');return Parts.pinWorld(e,q)})()")
        la = await pg.evaluate(f"(()=>{{const e=app.proj.parts.find(p=>p.id==='{led['id']}');return Parts.pinWorld(e,Parts.T.led.pins(e)[0])}})()")
        s1 = await pg.evaluate(SCREEN, [d2['x'], d2['y']]); s2 = await pg.evaluate(SCREEN, [la['x'], la['y']])
        w0 = await pg.evaluate('app.proj.wires.length')
        await pg.mouse.move(*s1); await pg.mouse.down(); await pg.mouse.move(s2[0], s2[1], steps=10); await pg.mouse.up()
        await pg.wait_for_timeout(200)
        w = await pg.evaluate('app.proj.wires[app.proj.wires.length-1]')
        same = await pg.evaluate(f"app.sim.netAt({d2['x']},{d2['y']})===app.sim.netAt({la['x']},{la['y']}) && app.sim.netAt({d2['x']},{d2['y']})>0")
        check('pin-to-pin drag creates a wire joining both nets', await pg.evaluate('app.proj.wires.length') == w0 + 1 and same, w)
        # 4. undo removes it
        await pg.keyboard.press('Control+z'); await pg.wait_for_timeout(100)
        check('Ctrl+Z undoes the wire', await pg.evaluate('app.proj.wires.length') == w0)
        await pg.keyboard.press('Control+y'); check('Ctrl+Y redoes it', await pg.evaluate('app.proj.wires.length') == w0 + 1)
        # 5. Wokwi import
        diag = {"version": 1, "author": "test", "editor": "wokwi", "parts": [
            {"type": "wokwi-esp32-devkit-v1", "id": "esp", "top": 0, "left": 0, "attrs": {}},
            {"type": "wokwi-resistor", "id": "r1", "top": 150, "left": 200, "attrs": {"value": "220"}},
            {"type": "wokwi-led", "id": "led1", "top": 100, "left": 300, "attrs": {"color": "green"}}],
            "connections": [["esp:D2", "r1:1", "green", []], ["r1:2", "led1:A", "green", []], ["led1:C", "esp:GND.1", "black", []], ["esp:TX0", "$serialMonitor:RX", "", []]]}
        fn = os.path.join(tempfile.gettempdir(), 'diagram.json'); open(fn, 'w').write(json.dumps(diag))
        await pg.set_input_files('#fileIn', fn); await pg.wait_for_timeout(800)
        imp = await pg.evaluate("({n:app.proj.parts.length,w:app.proj.wires.length,types:app.proj.parts.map(p=>p.type),r:app.proj.parts.find(p=>p.id==='r1').props.r,c:app.proj.parts.find(p=>p.id==='led1').props.color})")
        check('Wokwi diagram.json import (parts, attrs, connections)', imp['n'] == 3 and imp['w'] == 3 and imp['r'] == '220' and imp['c'] == 'green', imp)
        # run Blink-on-GPIO2 on the imported circuit
        await pg.click('#bRun'); await pg.wait_for_timeout(9000); s = []
        for i in range(10):
            s.append(await pg.evaluate("Math.round((app.sim.partState(app.proj.parts.find(p=>p.id==='led1')).bright||0)*100)")); await pg.wait_for_timeout(300)
        check('imported circuit runs real Blink firmware (LED toggles)', max(s) > 30 and min(s) == 0, s)
        await pg.click('#bStop')
        # 6. transistor example (real firmware)
        await pg.goto(BASE + '/?' + TQ + 'ex=transistor'); await pg.wait_for_timeout(1200); await pg.click('#bRun'); await pg.wait_for_timeout(9000)
        on, off = [], []
        for i in range(16):
            r = await pg.evaluate("(()=>{const e=app.proj.parts[0];const lv=app.sim.espRuntime(e).pins[4].level;const a=app.proj.parts.find(p=>p.id==='A1');const q=app.proj.parts.find(p=>p.id==='Q1');return [lv, app.sim.partState(a).txt, app.sim.readout(q)]})()")
            (on if r[0] else off).append(r); await pg.wait_for_timeout(180)
        check('transistor firmware: GPIO4 HIGH -> NPN saturates, LED current flows', on and off and 'mA' in on[-1][1] and ('µA' in off[-1][1] or 'nA' in off[-1][1] or 'pA' in off[-1][1] or off[-1][1].startswith('0')), {'on': on[-1], 'off': off[-1]})
        # 7. Stage 2: Pot -> PWM real firmware (ADC + LEDC through QEMU)
        await pg.goto(BASE + '/?' + TQ + 'ex=pot'); await pg.wait_for_timeout(1200); await pg.click('#bRun'); await pg.wait_for_timeout(14000)
        rows = []
        for pos in (0.25, 0.9, 0.05, 0.12, 0.09):
            await pg.evaluate(f"(()=>{{const p=app.proj.parts.find(q=>q.id==='POT1');p.props.pos={pos};app.sim.dirty=true}})()"); await pg.wait_for_timeout(2500)
            r = await pg.evaluate("(()=>{const e=app.proj.parts[0];const rt=app.sim.espRuntime(e);return {v:app.sim.pinVoltage(e,'D34'),pwm:rt.pins[25].pwm,freq:rt.pins[25].pwmFreq,line:app.serialText.trim().split('\\n').pop(),expect:app.sim.analogRead(e,34)}})()")
            m = re.search(r'pot=\s*(\d+).*?(\d+) mV', r['line']); r['raw'], r['mv'] = (int(m.group(1)), int(m.group(2))) if m else (None, None); rows.append(r)
        ok = all(r['pwm'] is not None and r['raw'] is not None and abs(r['raw'] - r['expect']) <= 2 and abs(r['mv'] - min(r['v'] * 1000, 3134)) <= 3 and abs(r['pwm'] - (r['raw'] // 16) / 256) < 0.01 and round(r['freq']) == 1000 for r in rows)
        check('Stage 2: unmodified-API analogRead (SAR ADC, calibrated) + analogReadMilliVolts + analogWrite (LEDC 1 kHz) in QEMU follow the pot', ok, rows)
        await pg.screenshot(path=os.path.join(os.path.dirname(__file__), 'pot_qemu.png'))
        # 8. I2C: SSD1306 + BME280 + MPU6050 with unmodified Adafruit libraries
        await pg.goto(BASE + '/?' + TQ + 'ex=i2c'); await pg.wait_for_timeout(1200); await pg.click('#bRun'); await pg.wait_for_timeout(30000)
        await pg.evaluate("(()=>{const q=app.proj.parts.find(p=>p.id==='BME1');q.props.temp=31.7;q.props.hum=62;})()"); await pg.wait_for_timeout(4000)
        tail = (await pg.evaluate("app.serialText")).strip().splitlines()[-1]
        lit = await pg.evaluate("(()=>{const d=app.i2c.OLED1;let n=0;for(let y=0;y<64;y++)for(let x=0;x<128;x++)n+=d.lit(x,y)?1:0;return n})()")
        check('I2C: BME280 slider -> firmware reads 31.70 C / 62 %, OLED framebuffer drawn', 'T=31.70 C' in tail and 'H=62.0' in tail and lit > 300, {'serial': tail, 'oled_lit_px': lit})
        await pg.screenshot(path=os.path.join(os.path.dirname(__file__), 'i2c_oled.png'))
        # 9. SPI: ILI9341 + MCP3008 + SD card (Adafruit_ILI9341, Adafruit_MCP3008, core SD/FAT)
        await pg.goto(BASE + '/?' + TQ + 'ex=spi'); await pg.wait_for_timeout(1200); await pg.click('#bRun'); await pg.wait_for_timeout(35000)
        r = await pg.evaluate("""(()=>{const d=app.spi.TFT1, sd=app.spi.SD1, e=app.proj.parts[0], m=app.proj.parts.find(p=>p.id==='ADC1');
          const S=app.sim, v=S.pinVoltage(m,'CH0')-S.pinVoltage(m,'GND'), vr=S.pinVoltage(m,'VDD')-S.pinVoltage(m,'GND');
          return {txt:app.serialText, header:d.rgb(230,300), body:d.rgb(49,100), expect:Math.floor(v/vr*1024), log:sd.file('log.txt'), sdreads:sd.reads, sdwrites:sd.writes}})()""")
        lines = r.pop('txt').splitlines(); last = [l for l in lines if l.startswith('MCP3008')][-1:]
        raw = int(re.search(r'CH0=(\d+)', last[0]).group(1)) if last else None
        r['serial'] = [l for l in lines if l.startswith(('SD ', 'hello.txt'))] + last; r['log'] = (r['log'] or '')[:60]
        ok = (any('SD mounted, 64 MB' in l for l in lines) and any('hello.txt: Hello from the virtual SD card!' in l for l in lines)
              and raw is not None and abs(raw - r['expect']) <= 1 and r['log'].startswith('0,') and r['header'] == [255, 166, 0] and r['body'] == [0, 0, 123])
        check('SPI: TFT draws (orange header, navy body), MCP3008 code matches pot voltage, SD mount + read hello.txt + append log.txt', ok, r)
        await pg.screenshot(path=os.path.join(os.path.dirname(__file__), 'spi_tft.png'))
        check('no page errors', not errs, errs)
        await b.close()
    json.dump(results, open(os.path.join(os.path.dirname(__file__), 'editor_ui_result.json'), 'w'), indent=1)
asyncio.run(main())
