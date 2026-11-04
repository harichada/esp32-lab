#!/usr/bin/env python3
"""End-to-end backend test: real arduino-cli build + QEMU run, GPIO bridged to a tiny behavioral circuit.
Usage: python3 tests/e2e_backend.py [http://127.0.0.1:8765]"""
import asyncio, json, sys, time, urllib.request, re, os
from pathlib import Path
import websockets
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8765'
TOK = os.environ.get('SIM_TOKEN') or (open('/tmp/sim_token').read().strip() if os.path.exists('/tmp/sim_token') else '')
Q = ('?t=' + TOK) if TOK else ''
EX = Path(__file__).resolve().parent.parent / 'examples'
results = []
def check(name, cond, detail=''):
    results.append((name, bool(cond), detail)); print(('PASS ' if cond else 'FAIL ') + name + (' — ' + detail if detail else ''), flush=True)

def compile_(sketch, files=None, defines=None):
    req = urllib.request.Request(BASE + '/api/compile' + Q, json.dumps({'sketch': sketch, 'files': files or {}, 'defines': defines or []}).encode(), {'Content-Type': 'application/json'})
    t = time.time(); r = json.load(urllib.request.urlopen(req, timeout=600))
    print(f"  compile ok={r['ok']} cached={r.get('cached')} {time.time() - t:.1f}s")
    if not r['ok']: print(r['log'][-3000:])
    return r

class Run:
    def __init__(self, bid, circuit, sync=False): self.bid, self.circuit, self.sync = bid, circuit, sync; self.uart = ''; self.events = []; self.st = dict(out=0, out1=0, en=0, en1=0); self.mux = {}; self.rtc = {}
    async def go(self, seconds, script=None):
        async with websockets.connect(BASE.replace('http', 'ws') + '/api/run/' + self.bid + Q, max_size=None) as ws:
            self.ws = ws; self.t0 = time.monotonic()
            if self.sync: await ws.send(json.dumps({'t': 'sync', 'on': True}))
            sc = asyncio.create_task(script(self)) if script else None
            try:
                while time.monotonic() - self.t0 < seconds:
                    try: m = json.loads(await asyncio.wait_for(ws.recv(), 0.2))
                    except asyncio.TimeoutError: continue
                    t = m['t']; self.types = getattr(self, 'types', {}); self.types[t] = self.types.get(t, 0) + 1
                    if t not in ('uart','gpio','mux','rtc') and os.environ.get('E2E_TRACE'): print('   msg', m)
                    if t == 'uart': self.uart += m['d']; self.on_uart(m['d'])
                    elif t == 'gpio': self.st.update({k: m[k] for k in ('out', 'out1', 'en', 'en1')}); self.events.append((time.monotonic() - self.t0, m['out'], m['en'])); await self.reply()
                    elif t == 'mux': self.mux[m['off']] = m['v']; await self.reply()
                    elif t == 'rtc': self.rtc[m['off']] = m['v']; await self.reply()
                    elif t == 'net':
                        self.netmsgs = getattr(self, 'netmsgs', []) + [m]
                        await ws.send(json.dumps({'t': 'netr', 'id': m['id'], 'code': 200, 'body': '{}'}))
                    elif t == 'adcq':   # SAR ADC conversion request: the vCPU waits for a value (1.90 V at the pin)
                        await ws.send(json.dumps({'t': 'adc', 'u': m['u'], 'ch': m['ch'], 'v': round((1900 - 142) / (1100 * 196602 / 65536 / 4096))})); await self.reply()
                    elif t == 'i2c':    # no I2C devices on this circuit: NACK address, 0xFF reads
                        if m['op'] == 'S': await ws.send(json.dumps({'t': 'i2cr', 'ack': 0})); await self.reply()
                        elif m['op'] == 'R': await ws.send(json.dumps({'t': 'i2cr', 'b': 255})); await self.reply()
                        elif self.sync: await self.reply()
                    elif t == 'rmt': self.rmt = getattr(self, 'rmt', []) + [m]
                    elif t in ('error', 'exit'): print('  ', m); break
            finally:
                if sc: sc.cancel()
                await ws.send(json.dumps({'t': 'stop'}))
    def on_uart(self, d): pass
    async def reply(self):
        v = self.circuit(self)
        await self.ws.send(json.dumps({'t': 'in', 'in': v & 0xffffffff, 'in1': v >> 32 & 0xff}))
    def high(self, pin): return bool(self.st['out'] >> pin & 1) and bool(self.st['en'] >> pin & 1)
    def outbits(self): return (self.st['out'] | self.st['out1'] << 32), (self.st['en'] | self.st['en1'] << 32)

async def test_blink():
    # ---------- Stage 1a: unmodified Blink -------------
    r = compile_((EX / 'Blink.ino').read_text())
    run = Run(r['id'], lambda s: s.st['out'] & s.st['en'])
    await run.go(9)
    tog = [(t, o >> 2 & 1) for t, o, e in run.events if e >> 2 & 1]
    edges = [t for (t, v), (t0, v0) in zip(tog[1:], tog[:-1]) if v != v0]
    per = [b - a for a, b in zip(edges, edges[1:])]
    check('Blink: GPIO2 configured as output', any(e >> 2 & 1 for _, _, e in run.events))
    check('Blink: GPIO2 toggles >=5 times in 9 s', len(edges) >= 5, f'{len(edges)} edges')
    check('Blink: half-period ≈ 1000 ms (±15%)', per and all(0.85 < p < 1.15 for p in per[1:]), 'periods ' + ', '.join(f'{p * 1000:.0f}' for p in per))
async def test_button():
    # ---------- Stage 1b: unmodified Button (pin 2 in w/ external pulldown, LED pin 13) ----
    r = compile_((EX / 'Button.ino').read_text())
    pressed = {'v': False}
    def circ(s):   # button to 3V3 + 10k pulldown on GPIO2; inputs mirror outputs for output pins
        return (s.st['out'] & s.st['en']) | ((1 << 2) if pressed['v'] else 0)
    run = Run(r['id'], circ)
    led = []
    async def script(rn):
        await asyncio.sleep(3)
        for k in range(3):
            pressed['v'] = True; await rn.reply(); tp = time.monotonic(); led.append(('press', tp - rn.t0))
            await asyncio.sleep(0.6)
            pressed['v'] = False; await rn.reply(); led.append(('release', time.monotonic() - rn.t0))
            await asyncio.sleep(0.6)
    await run.go(8, script)
    on = [t for t, o, e in run.events if o >> 13 & 1]
    off_after = [t for t, o, e in run.events if not o >> 13 & 1 and e >> 13 & 1]
    lat = []
    for kind, tp in led:
        evs = [t for t, o, e in run.events if t >= tp and ((o >> 13 & 1) == (kind == 'press'))]
        if evs: lat.append(evs[0] - tp)
    check('Button: LED pin 13 follows button (3 presses, 3 releases)', len(lat) == 6, f'latencies ms: {[round(x * 1000) for x in lat]}')
    check('Button: latency < 100 ms', lat and max(lat) < 0.1)
async def test_remote():
    # ---------- Remote firmware (real remote.ino, QemuNet shim) with matrix circuit model -----
    files = {'remote_logic.h': (EX / 'remote' / 'remote_logic.h').read_text()}
    r = compile_((EX / 'remote' / 'remote.ino').read_text(), files, ['SIM'])   # firmware's own emulator build flag: no boot discovery / light sleep
    ROWS = [13, 14, 27, 26]; COLS = [25, 33, 32, 19, 18]
    held = set()   # (row, col)
    def mcirc(s):
        v = 0
        o, e = s.outbits()
        for c, cp in enumerate(COLS):
            low = any((r_, c) in held and (e >> ROWS[r_] & 1) and not (o >> ROWS[r_] & 1) for r_ in range(4))
            if not low: v |= 1 << cp      # pulled up (INPUT_PULLUP)
        return v | (o & e)
    run = Run(r['id'], mcirc, sync=True)
    net = []
    def on_uart(d):
        run.buf = getattr(run, 'buf', '') + d
        while '\n' in run.buf:
            line, run.buf = run.buf.split('\n', 1)
            if line.startswith('@NET '):
                j = json.loads(line[5:]); net.append(j)
                if j['k'] == 'http': asyncio.get_event_loop().create_task(run.ws.send(json.dumps({'t': 'uart', 'd': '@R 200 {}\n'})))
    run.on_uart = on_uart
    keys = [('SonyOn', 0, 0), ('Vol+', 0, 2), ('Mode', 3, 1), ('Up', 1, 1), ('Mode', 3, 1), ('Up', 1, 1)]
    async def script(rn):
        await asyncio.sleep(4)
        for name, r_, c in keys:
            held.add((r_, c)); await asyncio.sleep(0.5); held.discard((r_, c)); await asyncio.sleep(0.6)
    await run.go(4 + len(keys) * 1.1 + 2, script)
    Path(__file__).with_name('remote_uart.log').write_text(run.uart)
    print('  events', len(run.events), run.events[-6:])
    lw = getattr(run, 'netmsgs', [])
    http = [j for j in net if j['k'] == 'http'] + lw
    check('Remote: HTTP carried by real lwIP TCP (open_eth + slirp)', len(lw) >= 2 and 'lwIP up on open_eth' in run.uart, f'{len(lw)} TCP requests')
    print('  serial tail:\n    ' + '\n    '.join([l for l in run.uart.splitlines() if l.strip() and not l.startswith('@NET')][-14:]))
    for j in http: print('  NET', j['method'], j['url'], j['headers'], j['body'][:90])
    exp = json.loads('[' + ','.join(l for l in (Path(__file__).resolve().parents[2] / 'tests/out/captured.jsonl').read_text().splitlines()) + ']')
    expd = {e['tag']: e for e in exp}
    vb = re.search(r'VBAT ~ ([\d.]+) V', run.uart)
    check('Remote: analogReadMilliVolts(VBAT) via calibrated SAR ADC (1.90 V pin x2 divider = 3.80 V)', vb and abs(float(vb.group(1)) - 3.80) < 0.03, vb.group(0) if vb else None)
    check('Remote: SonyOn -> IR SIRC 0x750 x3 printed', 'IR SIRC 0x750 x3' in run.uart)
    check('Remote: SonyOn -> POST /sony/system body matches native test', any(j['url'].endswith('/sony/system') and j['body'] == expd['tv/SonyOn']['body'] and j['headers'].get('X-Auth-PSK') == '0000' for j in http))
    check('Remote: Vol+ -> IRCC SOAP body + SOAPACTION match native test', any(j['url'].endswith('/sony/IRCC') and j['body'] == expd['tv/Vol+']['body'] and j['headers'].get('SOAPACTION') == '"urn:schemas-sony-com:service:IRCC:1#X_SendIRCC"' for j in http))
    check('Remote: Mode -> "Mode: Roku" then Up -> Roku ECP /keypress/Up', 'Mode: Roku' in run.uart and any(j['url'].endswith(':8060/keypress/Up') for j in http))
    check('Remote: Mode again -> TV, Up -> IRCC Up code', run.uart.count('Mode: TV') >= 1 and any(j['body'] == expd['tv/Up']['body'] for j in http))
    check('Remote: Mode LED (GPIO2) went HIGH in Roku mode', any(o >> 2 & 1 for t, o, e in run.events if t > 4))
    rm = getattr(run, 'rmt', [])
    def sirc_decode(m):
        ws_ = [int(x, 16) for x in m['items']]; marks = []
        for w in ws_:
            for d, l in ((w & 0x7fff, w >> 15 & 1), (w >> 16 & 0x7fff, w >> 31 & 1)):
                if l and d: marks.append(d * m['tick_ns'] / 1000)
        bits = ''.join('1' if mk > 900 else '0' for mk in marks[1:])
        return marks, bits
    dec = [sirc_decode(m) for m in rm]
    check('Remote: RMT frames emitted for IR (3 per Sony ON)', len(rm) >= 3, f'{len(rm)} frames; first marks(us)={[round(x) for x in dec[0][0]] if dec else None}')
    check('Remote: RMT frame decodes to SIRC 0x750 (header 2400us, 12 bits)', dec and abs(dec[0][0][0] - 2400) < 50 and int(dec[0][1][:12], 2) == 0x750, dec[0][1] if dec else '')
    check('Remote: 40 kHz carrier configured on RMT', rm and rm[0]['car_en'] == 1 and abs(1e9 / ((rm[0]['car_hi'] + rm[0]['car_lo']) * 12.5) - 40000) < 2000, f"hi={rm[0]['car_hi']} lo={rm[0]['car_lo']}" if rm else '')

async def main():
    sel = sys.argv[2:] or ['blink', 'button', 'remote']
    for t in sel: await globals()['test_' + t]()
    n = sum(1 for _, ok, _ in results if ok)
    print(f'\n{n}/{len(results)} passed')
    Path(__file__).with_name('e2e_backend_result.json').write_text(json.dumps([{'name': a, 'pass': b, 'detail': c} for a, b, c in results], indent=1))
    sys.exit(0 if n == len(results) else 1)
asyncio.run(main())
