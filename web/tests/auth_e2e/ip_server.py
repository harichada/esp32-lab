#!/usr/bin/env python3
"""Plain-HTTP IP origin for the sign-in handoff test. The lab is served here.

Sign-in on this origin leaves for AUTH_E2E_HTTPS_ORIGIN before any provider
redirect. This process does not contact Google or GitHub.
"""
import asyncio, os, sys, tempfile
from pathlib import Path

PORT = int(os.environ.get('AUTH_E2E_IP_PORT', '18943'))
TARGET = os.environ['AUTH_E2E_HTTPS_ORIGIN']
ROOT = Path(__file__).resolve().parents[2]
TMP = tempfile.mkdtemp(prefix='auth-e2e-ip-')

os.environ['SIM_PREWARM'] = '0'
os.environ['SIM_NETSTACK_WARM'] = '0'
os.environ['HTTPS_ENABLED'] = '0'
os.environ['HTTPS_HOST'] = ''
os.environ['AUTH_ENABLED'] = '1'
os.environ['AUTH_GOOGLE'] = '1'
os.environ['AUTH_GITHUB'] = '1'
os.environ['AUTH_BASE_URL'] = 'http://127.0.0.1:%d' % PORT
proj = Path(TMP) / 'projects'
os.environ['SIM_PROJECT_DIR'] = str(proj)
os.environ['AUTH_DB'] = str(proj / 'accounts' / 'auth.sqlite')
os.environ['AUTH_RATE_MAX'] = '100'
os.environ['GOOGLE_CLIENT_ID'] = 'google-client'
os.environ['GOOGLE_CLIENT_SECRET'] = 'e2e-google-secret'
os.environ['GITHUB_CLIENT_ID'] = 'github-client'
os.environ['GITHUB_CLIENT_SECRET'] = 'e2e-github-secret'

sys.path.insert(0, str(ROOT / 'server'))
import server
import https

https.apply_env()
https.set_redirect_base(TARGET)
__import__('auth').apply_env()

asyncio.run(https.serve_listeners(
    server.app, '127.0.0.1', PORT, signals=False, log_level='error', access_log=False,
))
