#!/usr/bin/env python3
"""Two loopback origins for the project-move browser test.

127.0.0.1 is the plain-HTTP origin. localhost is the stand-in for the HTTPS
origin. This machine cannot bind port 443, so the redirect target is
http://localhost:<port> via the loopback-only test seam. Production still
redirects to https://HTTPS_HOST. Nothing here contacts the live host.
"""
import asyncio
import os
import socket
import sys
import threading
from pathlib import Path

PORT = int(os.environ.get('MIGRATE_E2E_PORT', '18931'))
os.environ['SIM_PREWARM'] = '0'
os.environ['SIM_NETSTACK_WARM'] = '0'
os.environ['HTTPS_ENABLED'] = '1'
os.environ['HTTPS_REDIRECT'] = '1'
os.environ['HTTPS_HOST'] = 'localhost'
os.environ['ALLOWED_HOSTS'] = 'localhost,127.0.0.1'
os.environ['HSTS_SECONDS'] = '0'
os.environ['TLS_CERT_FILE'] = ''
os.environ['TLS_KEY_FILE'] = ''

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'server'))
import server
import https

https.apply_env({
    'HTTPS_ENABLED': '1',
    'HTTPS_REDIRECT': '1',
    'HTTPS_HOST': 'localhost',
    'ALLOWED_HOSTS': 'localhost,127.0.0.1',
    'HSTS_SECONDS': '0',
    'TLS_CERT_FILE': '',
    'TLS_KEY_FILE': '',
})
https.set_redirect_base('http://localhost:%d' % PORT)


def _pipe(left, right):
    try:
        while True:
            data = left.recv(65536)
            if not data:
                break
            right.sendall(data)
    except OSError:
        pass
    finally:
        for sock in (left, right):
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            sock.close()


def _listen_on_ipv6_loopback(port):
    """Chrome often dials localhost as ::1. The app socket is IPv4."""
    gate = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
    gate.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
    gate.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    gate.bind(('::1', port))
    gate.listen(64)

    def accept():
        while True:
            client, _addr = gate.accept()
            try:
                upstream = socket.create_connection(('127.0.0.1', port))
            except OSError:
                client.close()
                continue
            threading.Thread(target=_pipe, args=(client, upstream), daemon=True).start()
            threading.Thread(target=_pipe, args=(upstream, client), daemon=True).start()

    threading.Thread(target=accept, daemon=True).start()


_listen_on_ipv6_loopback(PORT)
asyncio.run(https.serve_listeners(
    server.app, '0.0.0.0', PORT, tls_port=None, signals=True, log_level='error', access_log=False,
))
