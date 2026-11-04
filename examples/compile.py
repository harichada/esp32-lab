import json,sys,urllib.request,time
B=__import__('os').environ.get('BASE','http://localhost:8766')
for f in sys.argv[1:]:
    for att in range(30):
        req=urllib.request.Request(B+'/api/compile',json.dumps({'sketch':open(f).read()}).encode(),{'Content-Type':'application/json'})
        try: r=json.load(urllib.request.urlopen(req,timeout=900))
        except urllib.error.HTTPError as e:
            if e.code==429: time.sleep(5); continue
            raise
        if not r['ok'] and 'another compile' in r['log']: time.sleep(5); continue
        break
    print(f, r['ok'], r.get('id'))
    if not r['ok']:
        import re; print('\n'.join(l for l in r['log'].splitlines() if 'error' in l.lower())[-3000:])
