"""Headless-Chrome tests: examples are read-only + copy-on-edit, My Projects persistence (localStorage + server copy),
click-click wiring with preview/hover labels/net highlight, wire select+Delete/Backspace, right-click menu, double-click bend,
Esc cancel, undo. Usage: python3 projects_wiring_ui.py [base_url]  (token from SIM_TOKEN or /tmp/sim_token; works via ngrok)."""
import asyncio, json, os, sys
from playwright.async_api import async_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8765'
TOK = os.environ.get('SIM_TOKEN') or (open('/tmp/sim_token').read().strip() if os.path.exists('/tmp/sim_token') else '')
CHROME = os.environ.get('CHROME', '/usr/bin/google-chrome')
res = []
def check(n, ok, info=''): res.append((n, bool(ok))); print(('PASS ' if ok else 'FAIL ') + n + (' — ' + str(info)[:200] if info and not ok else ''), flush=True)
SCREEN = "([x,y])=>{const s=document.querySelector('#stage');const p=s.createSVGPoint();p.x=x;p.y=y;const q=p.matrixTransform(s.getScreenCTM());return [q.x,q.y]}"
PIN = "([id,n])=>{const p=app.proj.parts.find(q=>q.id===id);const d=Parts.T[p.type].pins(p).find(q=>q.name===n);return Parts.pinWorld(p,d)}"
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=CHROME, args=['--no-sandbox'])
        ctx = await b.new_context(viewport={'width': 1500, 'height': 900}, extra_http_headers={'ngrok-skip-browser-warning': '1'})
        pg = await ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        async def at(x, y): return await pg.evaluate(SCREEN, [x, y])
        async def pin(pid, n): w = await pg.evaluate(PIN, [pid, n]); return w, await at(w['x'], w['y'])
        await pg.goto(f'{BASE}/?t={TOK}&ex=blink'); await pg.wait_for_timeout(2500)
        # ---- 1. example is read-only, copy on first edit ----
        check('example opens read-only with a "Make a copy" button', await pg.evaluate('app.readOnly') and await pg.locator('#bCopy').is_visible())
        code0 = await pg.evaluate('app.proj.code')
        await pg.click('#tabs button[data-tab=code]'); await pg.click('#code'); await pg.keyboard.press('Control+End'); await pg.keyboard.type('\n// my edit 123\n')
        await pg.wait_for_timeout(1200)
        st = await pg.evaluate("({ro:app.readOnly,id:app.proj.id,name:app.proj.name,url:location.search,n:app.store.list().length,code:app.store.get(app.proj.id)&&app.store.get(app.proj.id).code,toast:[...document.querySelectorAll('.toast')].map(t=>t.textContent).join('|')})")
        check('typing in an example auto-copies it (toast, ?p=, My Projects entry)', not st['ro'] and 'p=' in st['url'] and st['n'] == 1 and 'read-only' in st['toast'], st)
        check('the edit is saved in the copy', '// my edit 123' in (st['code'] or ''))
        check('copy name marks it as a copy', '(copy)' in st['name'], st['name'])
        await pg.reload(); await pg.wait_for_timeout(2500)
        check('reload reopens the copy with the edit', await pg.evaluate("app.proj.code.includes('// my edit 123') && !app.readOnly"))
        await pg.goto(f'{BASE}/?ex=blink'); await pg.wait_for_timeout(2000)
        check('the original example stays pristine', await pg.evaluate('app.proj.code') == code0 and await pg.evaluate('app.readOnly'))
        # ---- 2. circuit edits on an example (remote: keys used to be un-draggable) ----
        await pg.goto(f'{BASE}/?ex=remote'); await pg.wait_for_timeout(3000)
        k = await pg.evaluate("(()=>{const p=app.proj.parts.find(q=>q.id==='K_Mode');return {x:p.x,y:p.y}})()")
        a = await at(k['x'] + 15, k['y'] - 5); await pg.mouse.move(*a); await pg.mouse.down(); await pg.mouse.move(a[0] + 60, a[1] + 40, steps=6); await pg.mouse.up(); await pg.wait_for_timeout(900)
        k2 = await pg.evaluate("(()=>{const p=app.proj.parts.find(q=>q.id==='K_Mode');return {x:p.x,y:p.y,ro:app.readOnly,n:app.store.list().length}})()")
        check('remote example: a key part can be dragged when not running, and that makes a copy', (k2['x'], k2['y']) != (k['x'], k['y']) and not k2['ro'] and k2['n'] == 2, (k, k2))
        await pg.keyboard.press('r'); await pg.wait_for_timeout(200)
        check("'r' rotates the selected part when not running (was swallowed as the Roku Home key)", await pg.evaluate("app.proj.parts.find(q=>q.id==='K_Mode').rot") == 1)
        await pg.keyboard.press('Control+z'); await pg.keyboard.press('Control+z'); await pg.wait_for_timeout(200)
        check('undo restores the part', await pg.evaluate("(()=>{const p=app.proj.parts.find(q=>q.id==='K_Mode');return p.x+','+p.y+','+p.rot})()") == f"{k['x']},{k['y']},0")
        # ---- 3. click-click wiring on a blank copy ----
        await pg.goto(f'{BASE}/?ex=blank'); await pg.wait_for_timeout(2500)
        await pg.locator('.pitem[data-type=led]').drag_to(pg.locator('#stage'), target_position={'x': 520, 'y': 200}); await pg.wait_for_timeout(400)
        led = await pg.evaluate("app.proj.parts.filter(q=>q.type==='led').pop().id")
        check('adding a part to the blank example auto-copies it', not await pg.evaluate('app.readOnly'))
        nw = await pg.evaluate('app.proj.wires.length'); esp = await pg.evaluate("app.proj.parts.find(q=>q.type==='esp32').id")
        wa, sa = await pin(esp, 'D4'); wb, sb = await pin(led, 'A')
        await pg.mouse.move(sa[0] + 3, sa[1] + 3); await pg.wait_for_timeout(250)   # 3 px off: larger hit area
        tip = await pg.evaluate("document.querySelector('#tip').hidden?'':document.querySelector('#tip').textContent")
        check('hovering near a pin shows "ESP32 GPIO4" and highlights it', 'ESP32 GPIO4' in tip and await pg.evaluate("document.querySelectorAll('#lOver .hl-pin').length") >= 1, tip)
        await pg.mouse.click(sa[0] + 3, sa[1] + 3); await pg.mouse.move((sa[0] + sb[0]) / 2, (sa[1] + sb[1]) / 2, steps=5); await pg.wait_for_timeout(150)
        check('after clicking a pin a rubber-band preview follows the cursor', await pg.evaluate("document.querySelectorAll('#lOver .w-preview').length") == 1 and 'Wiring from' in await pg.inner_text('.hint'))
        await pg.mouse.move(sb[0] + 2, sb[1] - 2, steps=3); await pg.mouse.click(sb[0] + 2, sb[1] - 2); await pg.wait_for_timeout(300)
        w = await pg.evaluate('app.proj.wires[app.proj.wires.length-1]')
        check('click pin → click pin creates a wire (L-shaped bend)', await pg.evaluate('app.proj.wires.length') == nw + 1 and (w['a'], w['b']) == ({'x': wa['x'], 'y': wa['y']}, {'x': wb['x'], 'y': wb['y']}) and len(w['pts']) == 1, w)
        check('the two pins are now on one net', await pg.evaluate(f"app.sim.netAt({wa['x']},{wa['y']})===app.sim.netAt({wb['x']},{wb['y']}) && app.sim.netAt({wa['x']},{wa['y']})>0"))
        # Esc cancels
        await pg.mouse.click(sa[0], sa[1]); await pg.mouse.move(sa[0] + 80, sa[1] + 80, steps=3); await pg.keyboard.press('Escape'); await pg.wait_for_timeout(150)
        check('Esc cancels a wire in progress', await pg.evaluate("app.editor.mode===null && !document.querySelector('#lOver .w-preview')") and await pg.evaluate('app.proj.wires.length') == nw + 1)
        # select wire + Delete, undo, Backspace
        cx, cy = w['pts'][0]['x'], w['pts'][0]['y']; mid = await at((wa['x'] + cx) / 2, cy)
        await pg.mouse.click(*mid); await pg.wait_for_timeout(150)
        check('clicking a wire selects it', await pg.evaluate('app.editor.sel && app.editor.sel.wire') == w['id'])
        await pg.keyboard.press('Delete'); await pg.wait_for_timeout(150); n1 = await pg.evaluate('app.proj.wires.length')
        await pg.keyboard.press('Control+z'); await pg.wait_for_timeout(150); n2 = await pg.evaluate('app.proj.wires.length')
        check('Delete removes the selected wire, Ctrl+Z brings it back', n1 == nw and n2 == nw + 1, (n1, n2))
        await pg.mouse.click(*mid); await pg.keyboard.press('Backspace'); await pg.wait_for_timeout(150)
        check('Backspace removes the selected wire too', await pg.evaluate('app.proj.wires.length') == nw)
        await pg.keyboard.press('Control+z'); await pg.wait_for_timeout(150)
        # right-click menu: colour
        await pg.mouse.click(*mid, button='right'); await pg.wait_for_timeout(150)
        check('right-click on a wire opens a menu', await pg.locator('.ctxmenu').is_visible())
        await pg.click('.ctxmenu [data-c=red]'); await pg.wait_for_timeout(150)
        check('menu colour changes the wire to red', await pg.evaluate(f"app.proj.wires.find(q=>q.id==='{w['id']}').color") == 'red')
        # double-click adds a bend
        p0 = len(await pg.evaluate(f"app.proj.wires.find(q=>q.id==='{w['id']}').pts")); await pg.mouse.dblclick(*mid); await pg.wait_for_timeout(150)
        check('double-click on a wire adds a bend point', len(await pg.evaluate(f"app.proj.wires.find(q=>q.id==='{w['id']}').pts")) == p0 + 1)
        # breadboard hover highlights the 5-hole strip
        hb = await pg.evaluate("(()=>{const b=app.proj.parts.find(q=>q.type==='breadboard');const d=Parts.T.breadboard.pins(b).find(q=>q.name==='a50');return Parts.pinWorld(b,d)})()")
        if hb:
            s = await at(hb['x'], hb['y']); await pg.mouse.move(*s); await pg.wait_for_timeout(200)
            check('hovering a breadboard hole highlights its strip (5 holes)', await pg.evaluate("document.querySelectorAll('#lOver .hl-net').length") >= 5 and 'Breadboard a50' in await pg.evaluate("document.querySelector('#tip').textContent"))
        # ---- 4. My Projects: rename / duplicate / delete / import / server copy ----
        await pg.wait_for_timeout(900); pid = await pg.evaluate('app.proj.id')
        await pg.reload(); await pg.wait_for_timeout(2500)
        check('the wired blank copy is restored after reload', await pg.evaluate(f"app.proj.id==='{pid}' && app.proj.wires.length") == nw + 1)
        await pg.click('#bProjects'); await pg.wait_for_timeout(200)
        rows = await pg.evaluate("document.querySelectorAll('#projDlg tr[data-id]').length")
        check('My Projects lists the 3 copies', rows == 3, rows)
        pg.once('dialog', lambda d: asyncio.ensure_future(d.accept('Renamed proj')))
        await pg.click(f"#projDlg tr[data-id='{pid}'] [data-a=ren]"); await pg.wait_for_timeout(300)
        check('rename updates list, banner and storage', await pg.evaluate(f"app.store.get('{pid}').name==='Renamed proj' && document.querySelector('#pbName').textContent==='Renamed proj'"))
        await pg.click(f"#projDlg tr[data-id='{pid}'] [data-a=dup]"); await pg.wait_for_timeout(300)
        check('duplicate adds a project', await pg.evaluate('app.store.list().length') == 4)
        dup = await pg.evaluate(f"app.store.list().find(e=>e.id!=='{pid}' && e.name.startsWith('Renamed proj')).id")
        pg.once('dialog', lambda d: asyncio.ensure_future(d.accept()))
        await pg.click(f"#projDlg tr[data-id='{dup}'] [data-a=del]"); await pg.wait_for_timeout(300)
        check('delete removes it', await pg.evaluate('app.store.list().length') == 3)
        imp = await pg.evaluate("(()=>{const o=JSON.parse(app.store.exportJson(app.proj.id));o.name='Imported X';return app.store.importJson(JSON.stringify(o)).id})()")
        check('export → import round-trips a project', await pg.evaluate(f"app.store.get('{imp}').wires.length") == nw + 1)
        await pg.check('#cbSrv'); await pg.wait_for_timeout(200); await pg.evaluate('app.store.flushBackup(app.proj, {reason:"save"})'); await pg.wait_for_timeout(800)
        saved = await pg.evaluate("""async () => {
          const id = app.proj.id, secret = app.store.secretFor(id);
          const list = await fetch('api/projects').then(r => r.json());
          const got = await fetch('api/projects/' + encodeURIComponent(id));
          const denied = await fetch('api/projects/' + encodeURIComponent(id), {method:'DELETE'});
          const removed = await fetch('api/projects/' + encodeURIComponent(id), {method:'DELETE', headers:{'X-Edit-Secret': secret}});
          return {hasSecret: !!secret, list, got: got.status, denied: denied.status, removed: removed.status};
        }""")
        check('server copy: the list does not enumerate projects', saved['list'] == [] and saved['hasSecret'], saved)
        check('server copy: the project is readable by id', saved['got'] == 200, saved)
        check('server copy: delete without the edit secret is rejected', saved['denied'] == 403, saved)
        check('server copy: delete with the edit secret removes it', saved['removed'] == 200, saved)
        await pg.evaluate('app.store.serverSync=false')
        check('no page errors', not errs, errs)
        await b.close()
    print(f"\n{sum(o for _, o in res)}/{len(res)} passed"); sys.exit(0 if all(o for _, o in res) else 1)
asyncio.run(main())
