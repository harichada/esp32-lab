import asyncio,json,sys,urllib.request,websockets,time
base,ino,secs=sys.argv[1],sys.argv[2],float(sys.argv[3])
r=json.load(urllib.request.urlopen(urllib.request.Request(base+'/api/compile',json.dumps({'sketch':open(ino).read()}).encode(),{'Content-Type':'application/json'}),timeout=900))
print('id',r['id'],r['ok'])
async def go():
    async with websockets.connect(base.replace('http','ws')+'/api/run/'+r['id'],max_size=None) as ws:
        await ws.send(json.dumps({'t':'sync','on':True}))
        t0=time.time(); types={}; uart=''; out=0; en=0; last=[]
        while time.time()-t0<secs:
            try: m=json.loads(await asyncio.wait_for(ws.recv(),0.3))
            except asyncio.TimeoutError: continue
            t=m['t']; types[t]=types.get(t,0)+1; last=(last+[m])[-6:]
            if t=='uart': uart+=m['d']
            if t in('gpio','mux','rtc'):
                if t=='gpio': out,en=m['out'],m['en']
                await ws.send(json.dumps({'t':'in','in':(out&en)|(1<<34-32 if False else 0)|(0),'in1':0,'q':m.get('q')} if not m.get('fast') else {'t':'noop'}))
            if t=='adcq': await ws.send(json.dumps({'t':'adc','u':m['u'],'ch':m['ch'],'v':2000})); await ws.send(json.dumps({'t':'in','in':out&en,'in1':0}))
        print(types); print(uart[uart.find('entry'):][-400:]); print(last)
        await ws.send(json.dumps({'t':'stop'}))
asyncio.run(go())
