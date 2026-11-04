#!/usr/bin/env python3
"""Boot proof: run the aarch64 static QEMU under qemu-aarch64 user mode, chardevs as TCP clients to 127.0.0.1 (as the Android app does)."""
import socket, subprocess, sys, threading, time, os
QA, QEMU, FLASH, SECS = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4])
d = os.path.dirname(os.path.abspath(__file__))
def lsn():
    s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(('127.0.0.1', 0)); s.listen(1); return s
ser, gp = lsn(), lsn()
out = {'ser': b'', 'gp': b''}
def pump(srv, k):
    c, _ = srv.accept(); c.settimeout(0.5)
    while True:
        try:
            b = c.recv(4096)
            if not b: break
            out[k] += b
        except socket.timeout: pass
        except OSError: break
for s, k in ((ser, 'ser'), (gp, 'gp')): threading.Thread(target=pump, args=(s, k), daemon=True).start()
cmd = ([QA] if QA != '-' else []) + [QEMU, '-display', 'none', '-machine', 'esp32', '-drive', f'file={FLASH},if=mtd,format=raw', *(['-net','nic,model=open_eth','-net','user'] if os.environ.get('NET') else ['-nic','none']),
  '-chardev', f'socket,id=ser,host=127.0.0.1,port={ser.getsockname()[1]}', '-serial', 'chardev:ser',
  '-chardev', f'socket,id=gp,host=127.0.0.1,port={gp.getsockname()[1]}', '-global', 'driver=esp32.gpio,property=chardev,value=gp',
  '-drive', f'file={d}/efuse.bin,if=none,format=raw,id=efuse', '-global', 'driver=nvram.esp32.efuse,property=drive,value=efuse',
  '-L', f'{d}/../rom', '-monitor', 'none', '-icount', 'shift=4,align=off,sleep=on']
t0 = time.time(); p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
time.sleep(SECS); p.kill(); po = p.communicate()[0]
print('=== qemu stdout/stderr ===\n' + po.decode(errors='replace')[-1500:])
print('=== SERIAL (%d bytes) ===\n' % len(out['ser']) + out['ser'].decode(errors='replace')[-2500:])
g = out['gp'].decode(errors='replace').splitlines()
print('=== GPIO lines: %d, first 15 ===' % len(g)); print('\n'.join(g[:15]))
