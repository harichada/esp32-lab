import asyncio,json,sys,urllib.request,websockets,time
base=sys.argv[1]
r=json.load(urllib.request.urlopen(urllib.request.Request(base+'/api/compile',json.dumps({'sketch':open('bench.ino').read()}).encode(),{'Content-Type':'application/json'}),timeout=900))
async def go():
    async with websockets.connect(base.replace('http','ws')+'/api/run/'+r['id'],max_size=None) as ws:
        await ws.send(json.dumps({'t':'sync','on':True})); await ws.send(json.dumps({'t':'i2cfast','on':True}))
        t0=time.time(); seen=[]; out=en=0
        while time.time()-t0<10:
            try: m=json.loads(await asyncio.wait_for(ws.recv(),0.3))
            except asyncio.TimeoutError: continue
            t=m['t']
            if t in('gpio','mux','rtc'):
                if t=='gpio': out,en=m['out'],m['en']
                if not m.get('fast'): await ws.send(json.dumps({'t':'in','in':out&en,'in1':0,'q':m.get('q')}))
            if t=='i2c':
                if len(seen)<14: seen.append((m['op'],len(m['a']),m['a'][:6],m.get('fast')))
                if m['op']=='S' and not m.get('fast'): await ws.send(json.dumps({'t':'i2cr','ack':0})); await ws.send(json.dumps({'t':'in','in':out&en,'in1':0}))
        for s in seen: print(s)
        await ws.send(json.dumps({'t':'stop'}))
asyncio.run(go())
