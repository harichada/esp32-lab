import asyncio, sys, json, time
from playwright.async_api import async_playwright
BASE=__import__('os').environ.get('BASE','http://localhost:8766')
LOCAL='/workspace/esp32-remote/sim-site/js/examples.js'
INTERCEPT = '--live' not in sys.argv
SAMPLE = r"""(()=>{const S=app.sim, pn=(id,n)=>S.pinNet.get(id+':'+n), esp=app.proj.parts.find(q=>q.type==='esp32');
 const espNet={}; for(const n of [...Parts.ESP_TOP,...Parts.ESP_BOT]) espNet[pn(esp.id,n)]=espNet[pn(esp.id,n)]||n;
 const leds={}; for(const L of app.proj.parts.filter(q=>q.type==='led')){const R=app.proj.parts.find(q=>q.type==='resistor'&&pn(q.id,'2')===pn(L.id,'A')); const g=R?espNet[pn(R.id,'1')]:'?'; leds[g]=+(S.partState(L).bright||0).toFixed(2);}
 const buz=app.proj.parts.filter(q=>q.type==='buzzer').map(q=>!!S.partState(q).on);
 const o=app.i2c&&app.i2c.OLED1; let lit=0; if(o) for(let x=0;x<128;x++)for(let y=0;y<64;y++) if(o.lit(x,y)) lit++;
 return {ser:app.serialText, leds, buz, oled:o?{v:o.version,lit}:null, st:document.querySelector('#stText').textContent};})()"""
res=[]
def check(n, ok, info=''):
    res.append((n,bool(ok),str(info)[:300])); print(('PASS ' if ok else 'FAIL ')+n+('' if ok else ' — '+str(info)[:400]), flush=True)
class T:
    def __init__(s, pg, name): s.pg, s.name = pg, name
    async def S(s): return await s.pg.evaluate(SAMPLE)
    async def wait_ser(s, txt, timeout=30, since=0):
        t0=time.time()
        while time.time()-t0<timeout:
            st=await s.S()
            ser=st['ser']; b=ser.find('entry 0x'); b=b if b>=0 else len(ser)
            if txt in ser[max(since,b):]: return st
            await s.pg.wait_for_timeout(200)
        return None
    async def tap(s, key, ms=150): await s.pg.keyboard.down(key); await s.pg.wait_for_timeout(ms); await s.pg.keyboard.up(key)
    async def setp(s, pid, **kv):
        await s.pg.evaluate("([id,kv])=>{const q=app.proj.parts.find(p=>p.id===id); Object.assign(q.props,kv); app.sim.dirty=true;}", [pid, kv])
    async def serial_in(s, text):
        await s.pg.evaluate("(t)=>{const e=document.querySelector('#serialIn'); e.value=t; e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter'}));}", text)
    async def shot(s, tag): await s.pg.screenshot(path=f'shots/run_{s.name}_{tag}.png')
    async def oled_shot(s, tag):
        import base64
        u = await s.pg.evaluate("(()=>{const q=app.proj.parts.find(p=>p.id==='OLED1'); return q ? app.sim.partState(q).img : null;})()")
        if u: open(f'shots/oled_{s.name}_{tag}.png','wb').write(base64.b64decode(u.split(',')[1]))
    async def watch_leds(s, secs, every=100):
        out=[]; t0=time.time()
        while time.time()-t0<secs: out.append((await s.S())['leds']); await s.pg.wait_for_timeout(every)
        return out

async def t_traffic(t):
    st=await t.wait_ser('Traffic light ready'); check('traffic: boots', st)
    await t.pg.wait_for_timeout(1500); st=await t.S()
    check('traffic: cars green + DON\'T WALK red at idle', st['leds'].get('D25',0)>0.3 and st['leds'].get('D32',0)>0.3 and st['leds'].get('D27',1)<0.05, st['leds'])
    n=len(st['ser']); await t.tap('w', 300)
    st=await t.wait_ser('request accepted', 10, n); check('traffic: WALK button registers', st)
    st=await t.wait_ser('WALK\n', 15, n); 
    await t.pg.wait_for_timeout(800); st=await t.S()
    check('traffic: sequence yellow -> all red -> WALK', st and 'cars YELLOW' in st['ser'][n:] and 'all red' in st['ser'][n:], st['ser'][n:])
    check('traffic: during WALK car red + walk green lit', st['leds'].get('D27',0)>0.3 and st['leds'].get('D33',0)>0.3 and st['leds'].get('D25',1)<0.05, st['leds'])
    bz=[(await t.S())['buz'][0] for _ in range(12) if not await t.pg.wait_for_timeout(100)]
    check('traffic: crossing beeper ticks (on and off)', any(bz) and not all(bz), bz)
    st=await t.wait_ser('cars GO', 20, n); check('traffic: returns to cars GO', st)
async def t_reaction(t):
    st=await t.wait_ser('Reaction game'); check('reaction: boots', st)
    await t.pg.wait_for_timeout(2500); st=await t.S(); check('reaction: OLED drawn (READY screen)', st['oled'] and st['oled']['lit']>150, st['oled'])
    await t.oled_shot('ready')
    await t.tap('Enter'); await t.pg.wait_for_timeout(300)
    # wait for GO LED, then press
    t0=time.time(); go=False
    while time.time()-t0<12:
        st=await t.S()
        if st['leds'].get('D25',0)>0.3: go=True; break
        await t.pg.wait_for_timeout(30)
    check('reaction: GO LED lights after a random wait', go, st['leds'])
    n=len(st['ser']); await t.tap('Enter')
    st=await t.wait_ser('reaction:', 10, n); check('reaction: time measured and printed', st, st and st['ser'][n:])
    await t.pg.wait_for_timeout(2500); await t.oled_shot('result')
    # false start
    await t.pg.wait_for_timeout(600); await t.tap('Enter'); await t.pg.wait_for_timeout(500); n=len((await t.S())['ser']); await t.tap('Enter')
    await t.pg.wait_for_timeout(400); st=await t.S()
    check('reaction: false start detected + red LED', 'FALSE START' in st['ser'][n-5:] and st['leds'].get('D26',0)>0.3, (st['ser'][n-5:], st['leds']))
async def t_simon(t):
    st=await t.wait_ser('SIMON'); check('simon: boots', st)
    st=await t.wait_ser('level 1:', 15); check('simon: level 1 sequence', st)
    keys={'red':'1','green':'2','blue':'3','yellow':'4'}
    # brightness check during the attract/sequence: sample LEDs
    for lvl in (1,2,3):
        st=await t.wait_ser(f'level {lvl}:', 20)
        line=st['ser'].split(f'level {lvl}:')[-1]
        while '\n' not in line: await t.pg.wait_for_timeout(200); line=(await t.S())['ser'].split(f'level {lvl}:')[-1]
        cols=line.split('\n')[0].split()
        for c in cols: await t.tap(keys[c], 200); await t.pg.wait_for_timeout(150)
        st=await t.wait_ser(f'correct! score {lvl}', 10); check(f'simon: level {lvl} repeated correctly ({" ".join(cols)})', st)
    st=await t.wait_ser('level 4:', 20); line=st['ser'].split('level 4:')[-1]
    while '\n' not in line: await t.pg.wait_for_timeout(200); line=(await t.S())['ser'].split('level 4:')[-1]
    first=line.split()[0]; wrong=[k for c,k in keys.items() if c!=first][0]
    lv=await t.watch_leds(0.6, 50)
    await t.tap(wrong, 200); st=await t.wait_ser('GAME OVER', 10); check('simon: wrong key -> GAME OVER', st)
    await t.pg.wait_for_timeout(300); st=await t.S(); check('simon: all 4 LEDs light on game over (brightness)', all(st['leds'].get(p,0)>0.3 for p in ('D27','D26','D25','D33')), st['leds'])
async def t_weather(t):
    st=await t.wait_ser('T='); check('weather: boots + reads BME280', st and 'not found' not in st['ser'], st and st['ser'])
    ser=st and st['ser'][st['ser'].find('entry 0x'):]; check('weather: first reading is sane: 23.5 C / 45 % / 1013 hPa', ser and 'T=23.5 C  RH=45 %  P=1013.' in ser and '-140' not in ser, ser)
    await t.pg.wait_for_timeout(1500); st=await t.S(); check('weather: OLED overview drawn', st['oled'] and st['oled']['lit']>200, st['oled']); await t.oled_shot('p0')
    await t.setp('BME1', temp=31.0, hum=70, press=1000)
    for p in range(1,4):
        await t.tap('n', 200); await t.pg.wait_for_timeout(2500); await t.oled_shot(f'p{p}')
    st=await t.wait_ser('T=31.0', 15); check('weather: live slider change seen (31 C / 70 % / 1000 hPa, no garbage)', st and 'T=31.0 C  RH=70 %  P=1000.0' in st['ser'] and 'P=-' not in st['ser'], (await t.S())['ser'][-300:])
    await t.pg.wait_for_timeout(5500); st=await t.S(); check('weather: forecast reacts to falling pressure', 'Storm alert' in st['ser'] or 'Rain likely' in st['ser'], st['ser'][-200:])
    await t.oled_shot('forecast')
async def t_dice(t):
    st=await t.wait_ser('Dice ready'); check('dice: boots, MPU found', st and 'MPU6050 found' in st['ser'], st and st['ser'])
    n=len(st['ser']); await t.tap('Enter'); st=await t.wait_ser('roll #1 (button)', 15, n); check('dice: button roll', st, st and st['ser'][n:])
    await t.pg.wait_for_timeout(500); await t.oled_shot('roll1')
    st=await t.S(); check('dice: OLED shows dice', st['oled']['lit']>800, st['oled'])
    await t.setp('MPU1', ax=1.8, az=1.8); st=await t.wait_ser('(shake)', 10); check('dice: shake roll via MPU6050', st, (await t.S())['ser'][-200:])
    await t.setp('MPU1', ax=0, az=1)
async def t_stopwatch(t):
    st=await t.wait_ser('Stopwatch:'); check('stopwatch: boots', st)
    await t.tap('s'); await t.pg.wait_for_timeout(2600); st=await t.S()
    check('stopwatch: start + run LED', 'start' in st['ser'] and st['leds'].get('D25',0)>0.3, st['leds'])
    await t.tap('l'); await t.pg.wait_for_timeout(1500); await t.tap('l'); await t.pg.wait_for_timeout(500); await t.tap('s'); await t.pg.wait_for_timeout(800)
    st=await t.S(); s=st['ser']
    check('stopwatch: laps and stop printed', 'lap 1' in s and 'lap 2' in s and 'stop ' in s, s[-300:])
    import re; m=re.search(r'lap 1  00:0(\d)\.(\d\d)', s); check('stopwatch: lap 1 ≈ 2.6 s (virtual time ≈ wall time)', m and 1.8 < int(m.group(1))+int(m.group(2))/100 < 3.6, s[-300:])
    await t.oled_shot('stopped')
    await t.tap('l'); st=await t.wait_ser('reset', 5); check('stopwatch: reset', st)
async def t_vumeter(t):
    st=await t.wait_ser('VU meter'); check('vumeter: boots', st)
    await t.setp('POT1', pos=0.0); await t.pg.wait_for_timeout(1800); a=(await t.S())['leds']
    await t.setp('POT1', pos=1.0); await t.pg.wait_for_timeout(1800); b=(await t.S())['leds']
    lit=lambda L: sum(1 for v in L.values() if v>0.3)
    check('vumeter: pot 0 -> ~0 LEDs, pot max -> 8 LEDs', lit(a)<=1 and lit(b)==8, (a,b))
    await t.setp('POT1', pos=0.5); await t.pg.wait_for_timeout(2500); c=(await t.S())['leds']; check('vumeter: pot half -> about half', 3<=lit(c)<=5, c)
    await t.pg.evaluate("(()=>{const q=app.proj.parts.find(p=>p.id==='SW1'); q.props.pos=1; app.sim.dirty=true; app.sim.topoDirty=true;})()")
    seq=await t.watch_leds(2.0, 80); counts=[lit(x) for x in seq]
    st=await t.S(); check('vumeter: MUSIC mode pulses', 'MUSIC' in st['ser'] and max(counts)-min(counts)>=3, counts)
async def t_morse(t):
    st=await t.wait_ser('TX done', 30); check('morse: boots and sends SOS', st and '... --- ...' in st['ser'], st and st['ser'])
    await t.serial_in('HI'); seq=[]; t0=time.time()
    while time.time()-t0<3: s=await t.S(); seq.append((s['leds'].get('D25',0)>0.3, s['buz'][0])); await t.pg.wait_for_timeout(20)
    st=await t.wait_ser('TX "HI"', 5); check('morse: serial text keyed out (HI = .... ..)', st and '.... ..' in st['ser'], st and st['ser'][-100:])
    edges=sum(1 for a,b in zip(seq,seq[1:]) if a[0] and not b[0]); check('morse: LED blinks during TX (~6 elements)', edges>=4, edges)
    check('morse: buzzer follows LED', any(x[1] for x in seq) and all(x[0]==x[1] for x in seq[5:-5] if True) or sum(1 for x in seq if x[0]==x[1])/len(seq)>0.9, seq[:20])
    await t.pg.wait_for_timeout(1000); n=len((await t.S())['ser'])
    for i,(hold,gap) in enumerate([(60,120),(60,120),(60,900),(400,120),(400,120),(400,120)]):   # ... (gap) ---  -> S, O
        await t.tap('m', hold); await t.pg.wait_for_timeout(gap)
    st=await t.wait_ser('RX word', 8, n); s=(await t.S())['ser'][n:]
    check('morse: straight key decoded (S, O)', 'RX ... -> S' in s and 'RX --- -> O' in s, s)
async def t_snake(t):
    st=await t.wait_ser('new game'); check('snake: boots', st)
    await t.pg.wait_for_timeout(1500); st=await t.S(); check('snake: OLED board drawn', st['oled'] and st['oled']['lit']>100, st['oled']); v0=st['oled']['v']
    await t.pg.wait_for_timeout(1500); st=await t.S(); check('snake: animates (frames keep coming)', st['oled']['v']>v0, (v0, st['oled']['v']))
    await t.oled_shot('play')
    await t.pg.keyboard.down('ArrowUp'); await t.pg.wait_for_timeout(500); await t.pg.keyboard.up('ArrowUp')
    st=await t.wait_ser('crash!', 15); check('snake: steering up drives into the wall -> crash', st, (await t.S())['ser'][-200:])
    await t.pg.wait_for_timeout(1000); await t.oled_shot('over')
    await t.tap('ArrowLeft', 200); st=await t.wait_ser('new game', 5, len(st['ser'])); check('snake: key restarts', st)
async def t_pong(t):
    st=await t.wait_ser('PONG'); check('pong: boots', st)
    await t.pg.wait_for_timeout(2000); st=await t.S(); v0=st['oled']['v']; check('pong: OLED drawn', st['oled']['lit']>40, st['oled'])
    t0=time.time(); await t.pg.wait_for_timeout(3000); st=await t.S()
    frames=(st['oled']['v']-v0); check('pong: frames keep updating', frames>0, frames)
    await t.setp('POT1', pos=0.0)
    st=await t.wait_ser('score', 40); check('pong: a point is scored', st, (await t.S())['ser'][-200:])
    await t.oled_shot('play')
async def t_level(t):
    st=await t.wait_ser('pitch'); check('level: boots, reads MPU6050', st and 'not found' not in st['ser'], st and st['ser'])
    await t.pg.wait_for_timeout(1500); st=await t.S(); check('level: flat -> green LED on, red off', st['leds'].get('D25',0)>0.3 and st['leds'].get('D26',1)<0.05, st['leds']); await t.oled_shot('flat')
    await t.setp('MPU1', ax=0.5, az=0.87); await t.pg.wait_for_timeout(2500); st=await t.S()
    check('level: tilted 30° -> red LED on, green off', st['leds'].get('D26',0)>0.3 and st['leds'].get('D25',1)<0.05, st['leds']); await t.oled_shot('tilt')
    st=await t.wait_ser('TILTED', 15); check('level: Serial reports ~+30° pitch, TILTED', st and '+30.0' in st['ser'] or (st and 'TILTED' in st['ser']), st and st['ser'][-150:])
    await t.setp('MPU1', ax=0.1, az=1); await t.pg.wait_for_timeout(2000); st=await t.S(); check('level: small tilt -> neither LED', st['leds'].get('D25',1)<0.05 and st['leds'].get('D26',1)<0.05, st['leds'])

async def pstate(t, pid, keys):
    return await t.pg.evaluate("([id,ks])=>{const q=app.proj.parts.find(p=>p.id===id); const st=app.sim.partState(q); const o={}; for(const k of ks) o[k]=st[k]; return o;}", [pid, keys])
async def part_shot(t, pid, tag):
    el=t.pg.locator(f'#lParts g[data-id="{pid}"]')
    try:
        if await el.count(): await el.first.screenshot(path=f'shots/part_{t.name}_{tag}.png')
    except Exception as e: print('shot fail', e)
async def lcd_text(t):
    return await t.pg.evaluate("(()=>{const d=app.i2c&&app.i2c.LCD1; return d? d.text():null;})()")
async def t_servo(t):
    st=await t.wait_ser('Servo ready'); check('servo: boots', st)
    await t.setp('POT1', pos=0.0); await t.pg.wait_for_timeout(2500); a=await pstate(t,'SERVO1',['angle','us','hz','target'])
    end1=a
    await t.setp('POT1', pos=1.0); await t.pg.wait_for_timeout(2500); b=await pstate(t,'SERVO1',['angle','us','hz','target'])
    check('servo: 50 Hz pulse decoded', a['hz'] and 45<a['hz']<55, a)
    check('servo: knob ends drive the horn to opposite ends (0/180)', a['angle'] is not None and b['angle'] is not None and abs(a['angle']-b['angle'])>150, (a,b))
    await part_shot(t,'SERVO1','knob')
    await t.setp('POT1', pos=0.5); await t.pg.wait_for_timeout(2500); c=await pstate(t,'SERVO1',['angle','us'])
    check('servo: mid knob ~90 deg (pulse ~1470 us)', abs(c['angle']-90)<12 and abs(c['us']-1472)<120, c)
    n=len((await t.S())['ser']); await t.tap('s',300)
    st=await t.wait_ser('RADAR SWEEP',10,n); check('servo: s toggles sweep mode', st)
    angs=[]
    for _ in range(25): angs.append((await pstate(t,'SERVO1',['angle']))['angle']); await t.pg.wait_for_timeout(200)
    check('servo: horn sweeps in radar mode', max(angs)-min(angs)>60, angs)
    st=await t.S(); check('servo: sweep LED lit', st['leds'].get('D25',0)>0.3, st['leds'])
    await part_shot(t,'SERVO1','sweep')
async def t_neoring(t):
    st=await t.wait_ser('NeoPixel ring'); check('neoring: boots', st)
    await t.pg.wait_for_timeout(2000)
    a=await pstate(t,'RING1',['px','frames'])
    check('neoring: frames arrive, 16 px', a['frames'] and a['px'] and len(a['px'])==16, a)
    hues=set(tuple(int(v>100) for v in c) for c in (a['px'] or []))
    check('neoring: rainbow has many colours', len(hues)>=4, a['px'])
    await t.pg.wait_for_timeout(500); b=await pstate(t,'RING1',['px','frames'])
    check('neoring: animation moving', b['frames']>a['frames'] and b['px']!=a['px'], (a['frames'],b['frames']))
    st=await t.S(); check('neoring: no PX control lines leak into Serial', '\x1e' not in st['ser'] and 'PX ' not in st['ser'], st['ser'][-300:])
    await part_shot(t,'RING1','rainbow')
    n=len(st['ser']); await t.tap('m',300); st=await t.wait_ser('effect: fire',10,n); check('neoring: m -> fire', st)
    await t.pg.wait_for_timeout(1500); f=await pstate(t,'RING1',['px'])
    check('neoring: fire is red/orange (R dominant, no blue)', f['px'] and all(c[0]>=c[2] for c in f['px']) and sum(c[0] for c in f['px'])>300, f['px'])
    await part_shot(t,'RING1','fire')
    await t.setp('POT1', pos=0.0); await t.pg.wait_for_timeout(1200); g=await pstate(t,'RING1',['px'])
    await t.setp('POT1', pos=1.0); await t.pg.wait_for_timeout(1200); h=await pstate(t,'RING1',['px'])
    sg=sum(sum(c) for c in g['px']); sh=sum(sum(c) for c in h['px'])
    check('neoring: knob changes brightness', sh>sg*2, (sg,sh))
    for e in ('comet','breathing'):
        n=len((await t.S())['ser']); await t.tap('m',300); st=await t.wait_ser('effect: '+e,10,n); check('neoring: m -> '+e, st)
        await t.pg.wait_for_timeout(1200); await part_shot(t,'RING1',e)
async def t_lcdclock(t):
    st=await t.wait_ser('LCD clock running',20); check('lcdclock: boots', st)
    await t.pg.wait_for_timeout(1500); tx=await lcd_text(t)
    check('lcdclock: LCD shows time 09:4x:xx', tx and '09:4' in tx and 'AM' in tx, repr(tx))
    s1=tx; await t.pg.wait_for_timeout(2500); s2=await lcd_text(t); check('lcdclock: seconds advance', s1!=s2, (s1,s2))
    check('lcdclock: degree glyph via 0xDF', await t.pg.evaluate("(()=>{const d=app.i2c.LCD1; for(let c=0;c<16;c++) if(d.charAt(1,c)===0xDF) return true; return false;})()"))
    await part_shot(t,'LCD1','clock')
    n=len((await t.S())['ser']); await t.tap('m',200); await t.wait_ser('menu 1',5,n)
    for _ in range(3): await t.tap('+',150); await t.pg.wait_for_timeout(250)
    await t.pg.wait_for_timeout(500); tx=await lcd_text(t); check('lcdclock: SET HOURS menu', 'SET HOURS' in tx, repr(tx))
    await t.tap('m',200); await t.pg.wait_for_timeout(300); await t.tap('m',200); await t.pg.wait_for_timeout(1500)
    tx=await lcd_text(t); check('lcdclock: + advanced hours to 12', '12:4' in tx and 'PM' in tx, repr(tx))
    await part_shot(t,'LCD1','set')
async def t_thermostat(t):
    st=await t.wait_ser('T=',25); check('thermostat: DHT22 read OK', st and 'T=20.5' in st['ser'] and 'RH=48.0' in st['ser'], st and st['ser'][-300:])
    await t.pg.wait_for_timeout(800); tx=await lcd_text(t); st=await t.S()
    check('thermostat: LCD shows 20.5C and 48%RH', tx and '20.5' in tx and '48%RH' in tx, repr(tx))
    check('thermostat: heating at 20.5 < 22 (red on, blue off)', st['leds'].get('D25',0)>0.3 and st['leds'].get('D26',1)<0.05, st['leds'])
    await part_shot(t,'LCD1','heat'); await part_shot(t,'DHT1','dht')
    await t.setp('DHT1', temp=26.3, hum=61.5); n=len(st['ser'])
    st=await t.wait_ser('T=26.3',8,n); check('thermostat: slider change seen by firmware', st, (await t.S())['ser'][n:])
    await t.pg.wait_for_timeout(500); st=await t.S(); tx=await lcd_text(t)
    check('thermostat: cooling at 26.3 (blue on, red off) + LCD COOL', st['leds'].get('D26',0)>0.3 and st['leds'].get('D25',1)<0.05 and 'COOL' in tx, (st['leds'],tx))
    for _ in range(10): await t.tap('ArrowUp',200); await t.pg.wait_for_timeout(200)
    await t.pg.wait_for_timeout(2600); tx=await lcd_text(t); check('thermostat: UP x10 -> set 27.0, heating again (26.3 < 26.5)', 'Set 27.0' in tx and 'HEAT' in tx, repr(tx))
    await t.setp('DHT1', temp=-5.2); n=len((await t.S())['ser']); st=await t.wait_ser('T=-5.2',8,n); check('thermostat: negative temperature decoded', st)
    await part_shot(t,'LCD1','final')
    st=await t.S(); check('thermostat: no failed DHT22 reads (incl. during key presses)', 'read failed' not in st['ser'], st['ser'][-400:])

TESTS={k[2:]:v for k,v in globals().items() if k.startswith('t_')}
async def main():
    names=[a for a in sys.argv[1:] if not a.startswith('--')] or list(TESTS)
    async with async_playwright() as p:
        b=await p.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--no-sandbox','--autoplay-policy=no-user-gesture-required'])
        for n in names:
            ctx=await b.new_context(viewport={'width':1500,'height':950})
            if INTERCEPT:
                await ctx.route('**/js/examples.js*', lambda r: r.fulfill(path=LOCAL, content_type='application/javascript'))
                await ctx.route('**/js/app.js*', lambda r: r.fulfill(path=LOCAL.replace('examples.js','app.js'), content_type='application/javascript'))
            pg=await ctx.new_page(); errs=[]; pg.on('pageerror',lambda e: errs.append(str(e)))
            await pg.goto(f'{BASE}/?ex={n}'); await pg.wait_for_timeout(1500)
            await pg.click('#tabs button[data-tab=serial]') if await pg.locator('#tabs button[data-tab=serial]').count() else None
            await pg.evaluate('app.cmd.run()')
            t=T(pg,n)
            try: await asyncio.wait_for(TESTS[n](t), 240)
            except Exception as e: check(f'{n}: test crashed', False, repr(e))
            st=await t.S(); open(f'shots/serial_{n}.txt','w').write(st['ser'])
            check(f'{n}: no page errors', not errs, errs)
            await pg.evaluate('app.cmd.stop()'); await ctx.close()
        await b.close()
    print('\nSUMMARY', sum(r[1] for r in res), '/', len(res))
    json.dump(res, open('ft_result.json','w'), indent=1)
asyncio.run(main())
