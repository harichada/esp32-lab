#!/usr/bin/env python3
"""slirp guestfwd helper: QEMU runs this per guest TCP connection with the connection on stdin/stdout;
we splice it to the simulator server's per-run unix socket."""
import os, socket, sys, threading
s = socket.socket(socket.AF_UNIX); s.connect(sys.argv[1])
def up():
    while True:
        d = os.read(0, 65536)
        if not d: break
        s.sendall(d)
    try: s.shutdown(socket.SHUT_WR)
    except OSError: pass
threading.Thread(target=up, daemon=True).start()
while True:
    d = s.recv(65536)
    if not d: break
    os.write(1, d)
