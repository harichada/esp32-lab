"""Loopback-only real auth API with a fake example.test mailbox, never production mail."""
import os
import smtplib
import sys
import tempfile
from pathlib import Path

import uvicorn
from starlette.applications import Starlette
from starlette.responses import HTMLResponse, JSONResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

WEB = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(WEB / 'server'))
import auth

PORT = int(os.environ.get('AUTH_EMAIL_E2E_PORT', '4194'))
BASE = 'http://127.0.0.1:%d' % PORT
MAIL = {}


def deliver(address, code):
    if address.rsplit('@', 1)[-1] != 'example.test':
        raise smtplib.SMTPException('Only reserved test addresses are accepted')
    MAIL[address] = code


async def index(request):
    body = (WEB / 'index.html').read_text(encoding='utf-8')
    body = body.replace('<head>', '<head><meta name="cl-auth" content="1"><meta name="ui2" content="1">')
    return HTMLResponse(body)


async def mailbox(request):
    address = request.query_params.get('email', '').lower()
    if address not in MAIL:
        return JSONResponse({'error': 'missing'}, status_code=404)
    return JSONResponse({'code': MAIL[address]}, headers={'Cache-Control': 'no-store'})


with tempfile.TemporaryDirectory(prefix='email-auth-e2e-') as temporary:
    projects = Path(temporary) / 'projects'
    auth.apply_env({
        'AUTH_ENABLED': '1', 'AUTH_EMAIL': '1', 'AUTH_GOOGLE': '0', 'AUTH_GITHUB': '0',
        'AUTH_BASE_URL': BASE, 'SIM_PROJECT_DIR': str(projects),
        'AUTH_DB': str(projects / 'accounts' / 'auth.sqlite'), 'AUTH_RATE_MAX': '200',
        'AUTH_SMTP_HOST': 'smtp.example.test', 'AUTH_SMTP_FROM': 'no-reply@example.test',
        'AUTH_SMTP_USER': 'test-mail-user', 'AUTH_SMTP_PASSWORD': 'test-only-mail-password',
    })
    auth._send_email_code = deliver
    app = auth.AuthMiddleware(Starlette(routes=[
        Route('/', index), Route('/index.html', index),
        Route('/__test__/email-code', mailbox),
        Mount('/', StaticFiles(directory=str(WEB), html=True)),
    ]))
    try:
        uvicorn.run(app, host='127.0.0.1', port=PORT, access_log=False, log_level='error')
    finally:
        auth.apply_env({'AUTH_ENABLED': '0'})
