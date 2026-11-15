#!/usr/bin/env python3
"""Loopback lab plus a local OAuth stand-in for the sign-in browser tests.

AUTH_TEST_IDP is the mock origin. auth.py refuses that setting for the live
host, so this process cannot be pointed at esp32lab.duckdns.org. Nothing here
contacts Google or GitHub.
"""
import json, os, sys, tempfile
from pathlib import Path

PORT = int(os.environ.get('AUTH_E2E_PORT', '18941'))
HOST = os.environ.get('AUTH_E2E_HOST', 'localhost')
HTTPS = os.environ.get('AUTH_E2E_HTTPS', '1')
ROOT = Path(__file__).resolve().parents[2]
TMP = tempfile.mkdtemp(prefix='auth-e2e-')

sys.path.insert(0, str(ROOT / 'tests'))
from oauth_mock import MockIdP

idp = MockIdP()
idp.google_secret = 'e2e-google-secret'
idp.github_secret = 'e2e-github-secret'
idp.start_thread()

os.environ['SIM_PREWARM'] = '0'
os.environ['SIM_NETSTACK_WARM'] = '0'
os.environ['HTTPS_ENABLED'] = '1' if HTTPS == '1' else '0'
os.environ['HTTPS_HOST'] = 'localhost' if HTTPS == '1' else ''
os.environ['HSTS_ENABLED'] = '0'
os.environ['AUTH_ENABLED'] = '1'
os.environ['AUTH_GOOGLE'] = os.environ.get('AUTH_GOOGLE', '1')
os.environ['AUTH_GITHUB'] = os.environ.get('AUTH_GITHUB', '1')
os.environ['AUTH_BASE_URL'] = 'http://%s:%d' % (HOST, PORT)
os.environ['AUTH_TEST_IDP'] = idp.origin
proj = Path(TMP) / 'projects'
os.environ['SIM_PROJECT_DIR'] = str(proj)
os.environ['AUTH_DB'] = str(proj / 'accounts' / 'auth.sqlite')
os.environ['AUTH_RATE_MAX'] = '400'
os.environ['AUTH_HTTP_TIMEOUT_S'] = '2'
os.environ['AUTH_SESSION_DAYS'] = '1'
os.environ['GOOGLE_CLIENT_ID'] = 'google-client'
os.environ['GOOGLE_CLIENT_SECRET'] = idp.google_secret
os.environ['GITHUB_CLIENT_ID'] = 'github-client'
os.environ['GITHUB_CLIENT_SECRET'] = idp.github_secret

info = {
    'mock': idp.origin,
    'origin': os.environ['AUTH_BASE_URL'],
    'port': PORT,
    'google': os.environ['AUTH_GOOGLE'],
    'github': os.environ['AUTH_GITHUB'],
}
Path(os.environ.get('AUTH_E2E_INFO', '/tmp/esp32lab-auth-e2e.json')).write_text(json.dumps(info))

sys.path.insert(0, str(ROOT / 'server'))
import server
import https
import uvicorn

https.apply_env()
auth_mod = __import__('auth')
auth_mod.apply_env()

if HOST == 'localhost':
    import socket, threading

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

    gate = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
    gate.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
    gate.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    gate.bind(('::1', PORT))
    gate.listen(64)

    def _accept():
        while True:
            client, _addr = gate.accept()
            try:
                upstream = socket.create_connection(('127.0.0.1', PORT))
            except OSError:
                client.close()
                continue
            threading.Thread(target=_pipe, args=(client, upstream), daemon=True).start()
            threading.Thread(target=_pipe, args=(upstream, client), daemon=True).start()

    threading.Thread(target=_accept, daemon=True).start()

uvicorn.run(
    server.app, host='0.0.0.0', port=PORT, log_level='error', access_log=False,
    proxy_headers=False, forwarded_allow_ips='',
)
