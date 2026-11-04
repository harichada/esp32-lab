from playwright.sync_api import sync_playwright
import sys, json
D = '/workspace/esp32-lab-android/ui-shots/'
URL = 'http://127.0.0.1:18765/'
RUN = '--run' in sys.argv
log = []
def L(*a): print(*a); log.append(' '.join(map(str, a)))
with sync_playwright() as p:
    b = p.chromium.launch()
    # desktop must be unchanged
    dc = b.new_context(viewport={'width': 1440, 'height': 900})
    dp = dc.new_page(); dp.goto(URL); dp.wait_for_timeout(1500); dp.screenshot(path=D + 'after-desktop-1440.png')
    L('desktop html.m =', dp.evaluate("document.documentElement.classList.contains('m')"))
    c = b.new_context(viewport={'width': 412, 'height': 915}, device_scale_factor=2, is_mobile=True, has_touch=True,
                      user_agent='Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36 ESP32Lab/4')
    pg = c.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e))); pg.on('console', lambda m: m.type == 'error' and errs.append(m.text))
    pg.goto(URL + '?ex=blink'); pg.wait_for_timeout(2000)
    L('mobile html.m =', pg.evaluate("document.documentElement.classList.contains('m')"))
    pg.evaluate("document.querySelector('#selExample').value='blink';document.querySelector('#selExample').dispatchEvent(new Event('change'))"); pg.wait_for_timeout(600)
    pg.locator('#mFit').tap(); pg.wait_for_timeout(300)
    pg.screenshot(path=D + 'after-01-circuit.png')
    st = pg.evaluate("(()=>{const r=document.querySelector('#stageWrap').getBoundingClientRect();return {h:r.height,top:r.top,vh:innerHeight}})()"); L('stage', st, 'share', round(st['h']/st['vh']*100), '%')
    # pinch zoom with real 2-finger touch events via CDP
    cdp = c.new_cdp_session(pg)
    def touch(t, pts): cdp.send('Input.dispatchTouchEvent', {'type': t, 'touchPoints': [{'x': x, 'y': y, 'id': i} for i, (x, y) in enumerate(pts)]})
    s0 = pg.evaluate('app.editor.view.s')
    touch('touchStart', [(170, 450), (240, 450)])
    for k in range(1, 11): touch('touchMove', [(170 - 8*k, 450 - 3*k), (240 + 8*k, 450 + 3*k)]); pg.wait_for_timeout(16)
    touch('touchEnd', []); pg.wait_for_timeout(200)
    s1 = pg.evaluate('app.editor.view.s'); L('pinch zoom', round(s0, 3), '->', round(s1, 3))
    pg.screenshot(path=D + 'after-02-pinch-zoomed.png')
    # one-finger pan
    v0 = pg.evaluate('({...app.editor.view})'); touch('touchStart', [(200, 600)])
    for k in range(1, 8): touch('touchMove', [(200 + 10*k, 600 + 6*k)]); pg.wait_for_timeout(16)
    touch('touchEnd', []); v1 = pg.evaluate('({...app.editor.view})'); L('pan dx(world)', round(v0['x'] - v1['x'], 1))
    pg.locator('#mFit').tap(); pg.wait_for_timeout(300)
    # drawer + overflow
    pg.locator('#mMenu').tap(); pg.wait_for_timeout(350); pg.screenshot(path=D + 'after-03-drawer.png'); pg.locator('.m-scrim').tap(position={'x': 390, 'y': 400}); pg.wait_for_timeout(300)
    pg.locator('#mMore').tap(); pg.wait_for_timeout(200); pg.screenshot(path=D + 'after-04-overflow.png'); pg.locator('#mMore').tap(); pg.wait_for_timeout(200)
    # make an editable copy, then add a part from the parts sheet
    pg.locator('#mKind').tap(); pg.wait_for_timeout(500); L('readOnly after copy', pg.evaluate('app.readOnly'))
    pg.locator('.m-tabs [data-mv=parts]').tap(); pg.wait_for_timeout(400); pg.screenshot(path=D + 'after-05-parts-sheet.png')
    pg.locator('#palSearch').fill('resistor'); pg.wait_for_timeout(200); pg.screenshot(path=D + 'after-06-parts-search.png')
    n0 = pg.evaluate('app.proj.parts.length'); pg.locator('.pitem[data-type=resistor]').first.tap(); pg.wait_for_timeout(500)
    n1 = pg.evaluate('app.proj.parts.length'); L('add part', n0, '->', n1)
    pg.locator('#palSearch').fill(''); pg.evaluate("document.querySelector('#palSearch').dispatchEvent(new Event('input'))")
    pg.screenshot(path=D + 'after-07-part-added.png')
    # tap the new part -> inspector sheet
    def scr(expr):  # world -> screen
        return pg.evaluate("(()=>{const q=%s;const r=document.querySelector('#stage').getBoundingClientRect(),v=app.editor.view;return [r.left+(q.x-v.x)*v.s,r.top+(q.y-v.y)*v.s]})()" % expr)
    newid = pg.evaluate('app.proj.parts[app.proj.parts.length-1].id')
    bb = pg.evaluate("(()=>{const r=app.editor.partEls.get('%s').getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()" % newid)
    pg.touchscreen.tap(bb[0], bb[1]); pg.wait_for_timeout(400)
    L('selected', pg.evaluate('JSON.stringify(app.editor.sel)'), 'sheet open', pg.evaluate("document.querySelector('#mInsp').classList.contains('on')"))
    pg.screenshot(path=D + 'after-08-inspector-sheet.png')
    pg.locator('#mInsp [data-x]').tap(); pg.wait_for_timeout(300)
    # long-press drag to move it
    p0 = pg.evaluate("(()=>{const p=app.editor.part('%s');return [p.x,p.y]})()" % newid)
    touch('touchStart', [(bb[0], bb[1])]); pg.wait_for_timeout(520)
    for k in range(1, 9): touch('touchMove', [(bb[0] + 6*k, bb[1] + 9*k)]); pg.wait_for_timeout(20)
    touch('touchEnd', []); pg.wait_for_timeout(300); pg.locator('#mInsp [data-x]').tap(); pg.wait_for_timeout(250)
    p1 = pg.evaluate("(()=>{const p=app.editor.part('%s');return [p.x,p.y]})()" % newid); L('long-press move', p0, '->', p1)
    # wire: tap resistor pin, tap ESP32 GND-ish pin
    pins = pg.evaluate("""(()=>{const P=Parts,ed=app.editor,np=ed.part('%s');const a=P.pinWorld(np,P.T[np.type].pins(np)[0]);
        const e=app.proj.parts.find(p=>p.type==='esp32');const pe=P.T.esp32.pins(e).find(q=>/GND/.test(q.name))||P.T.esp32.pins(e)[0];const b=P.pinWorld(e,pe);return {a,b,bn:pe.name}})()""" % newid)
    w0 = pg.evaluate('app.proj.wires.length')
    A = scr(json.dumps(pins['a'])); pg.touchscreen.tap(*A); pg.wait_for_timeout(300)
    L('wiring mode', pg.evaluate("app.editor.mode&&app.editor.mode.k"), pg.evaluate("document.querySelector('.m-wiring span').textContent"))
    pg.screenshot(path=D + 'after-09-wiring.png')
    B = scr(json.dumps(pins['b'])); pg.touchscreen.tap(*B); pg.wait_for_timeout(400)
    L('wires', w0, '->', pg.evaluate('app.proj.wires.length'), 'to', pins['bn'])
    pg.screenshot(path=D + 'after-10-wired.png')
    # undo the extra resistor+wire so Blink is the stock circuit
    pg.locator('#mUndo').tap(); pg.locator('#mUndo').tap(); pg.locator('#mUndo').tap(); pg.wait_for_timeout(300)
    pg.locator('.m-tabs [data-mv=code]').tap(); pg.wait_for_timeout(300); pg.screenshot(path=D + 'after-11-code.png')
    pg.locator('.m-tabs [data-mv=serial]').tap(); pg.wait_for_timeout(300); pg.screenshot(path=D + 'after-12-serial-idle.png')
    pg.locator('#mMore').tap(); pg.locator('.m-menu [data-m=build]').tap(); pg.wait_for_timeout(300); pg.screenshot(path=D + 'after-13-buildlog-sheet.png')
    pg.locator('.dock-close').tap(); pg.wait_for_timeout(200)
    pg.locator('.m-tabs [data-mv=circuit]').tap(); pg.wait_for_timeout(200)
    if RUN:
        pg.locator('#mFab').tap(); L('run tapped')
        pg.wait_for_function("document.body.classList.contains('running')", timeout=180000); L('running; status', pg.evaluate("document.querySelector('#stText').textContent"))
        pg.screenshot(path=D + 'after-14-running-circuit.png')
        pg.wait_for_function("/entry 0x/.test(document.querySelector('#serial').textContent)", timeout=150000); L('firmware booted (ROM entry seen)')
        pg.evaluate("window.__ledv=new Set();setInterval(()=>{const l=app.proj.parts.find(p=>p.type==='led');const st=l&&app.sim&&app.sim.partState?app.sim.partState(l):null;const g=app.editor.partEls.get(l.id);__ledv.add(g?g.innerHTML.length:0)},200)")
        pg.wait_for_timeout(25000); L('LED svg variants seen while running', pg.evaluate("[...__ledv].length"))
        pg.screenshot(path=D + 'after-15-running-circuit-led.png')
        pg.locator('.m-tabs [data-mv=serial]').tap(); pg.wait_for_timeout(500); pg.screenshot(path=D + 'after-16-running-serial.png')
        L('serial tail', repr(pg.evaluate("document.querySelector('#serial').textContent.slice(-300)")))
        L('fab', pg.evaluate("document.querySelector('#mFab').textContent"))
        pg.locator('#mFab').tap(); pg.wait_for_timeout(1500); L('after stop running=', pg.evaluate("document.body.classList.contains('running')"))
    L('page errors', errs)
    open(D + 'after-log.txt', 'w').write('\n'.join(log))
    b.close()
