#!/usr/bin/env python3
"""Local stand-in for Google and GitHub. Tests start it. The app never imports it.

AUTH_TEST_IDP is the only way the app talks to this process, and auth.py refuses
that setting when AUTH_BASE_URL is the live host or any non-loopback origin.
"""
import base64, hashlib, json, secrets, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urlparse

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa

ACCESS_TOKEN = 'gho_mock_access_token_value'


def _b64url(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b'=').decode('ascii')


def _challenge(verifier):
    return _b64url(hashlib.sha256(verifier.encode('ascii')).digest())


class MockIdP(ThreadingHTTPServer):
    allow_reuse_address = True

    def __init__(self):
        super().__init__(('127.0.0.1', 0), _Handler)
        self.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        numbers = self.key.public_key().public_numbers()
        self._n = numbers.n
        self._e = numbers.e
        self.mode = 'ok'
        self.sub = 'google-sub-1001'
        self.github_id = 4242
        self.google_secret = ''
        self.github_secret = ''
        self.pending = {}
        self.codes = {}
        self.last_authorize = {}
        self.last_token = {}
        self.token_calls = 0
        self._lock = threading.Lock()

    @property
    def origin(self):
        return 'http://127.0.0.1:%d' % self.server_address[1]

    def jwks(self):
        def enc(num):
            length = max(1, (num.bit_length() + 7) // 8)
            return _b64url(num.to_bytes(length, 'big'))
        return {'keys': [{
            'kty': 'RSA', 'kid': 'test-key', 'alg': 'RS256', 'use': 'sig',
            'n': enc(self._n), 'e': enc(self._e),
        }]}

    def sign(self, payload, bad=False):
        header = _b64url(json.dumps({'alg': 'RS256', 'kid': 'test-key', 'typ': 'JWT'}, separators=(',', ':')).encode())
        body = _b64url(json.dumps(payload, separators=(',', ':')).encode())
        signing = (header + '.' + body).encode('ascii')
        sig = self.key.sign(signing, padding.PKCS1v15(), hashes.SHA256())
        if bad:
            flipped = bytearray(sig)
            flipped[-1] ^= 0x01
            sig = bytes(flipped)
        return header + '.' + body + '.' + _b64url(sig)

    def start_thread(self):
        thread = threading.Thread(target=self.serve_forever, name='oauth-mock', daemon=True)
        thread.start()
        self.thread = thread
        return self


class _Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        return

    def _query(self):
        return parse_qs(urlparse(self.path).query, keep_blank_values=True)

    def _one(self, params, name):
        values = params.get(name) or []
        return values[0] if len(values) == 1 else ''

    def _send(self, status, body, content_type='application/json', headers=None):
        data = body if isinstance(body, bytes) else body.encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        for key, value in headers or []:
            self.send_header(key, value)
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            return

    def _redirect(self, location):
        self._send(302, b'', content_type='text/plain', headers=[('Location', location)])

    def _loopback(self, url):
        try:
            parsed = urlparse(url)
        except ValueError:
            return False
        return parsed.scheme in ('http', 'https') and parsed.hostname in ('127.0.0.1', 'localhost')

    def _read_form(self):
        length = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(length) if length else b''
        return parse_qs(raw.decode('utf-8', 'replace'), keep_blank_values=True)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/google/certs':
            self._send(200, json.dumps(self.server.jwks()))
            return
        if path == '/control/last':
            with self.server._lock:
                payload = {
                    'authorize': self.server.last_authorize,
                    'token': self.server.last_token,
                    'token_calls': self.server.token_calls,
                }
            self._send(200, json.dumps(payload))
            return
        if path in ('/google/authorize', '/github/authorize'):
            self._authorize('google' if 'google' in path else 'github')
            return
        if path == '/github/user':
            self._send(200, json.dumps({
                'id': self.server.github_id, 'login': 'ada', 'name': 'Ada Lovelace',
            }))
            return
        if path == '/github/emails':
            verified = self.server.mode != 'noemail'
            self._send(200, json.dumps([{
                'email': 'ada@example.com', 'primary': True, 'verified': verified,
            }]))
            return
        self._send(404, '{"error":"not found"}')

    def do_POST(self):
        path = urlparse(self.path).path
        if path == '/control':
            length = int(self.headers.get('Content-Length') or 0)
            raw = self.rfile.read(length) if length else b'{}'
            try:
                body = json.loads(raw.decode('utf-8'))
            except json.JSONDecodeError:
                body = {}
            if isinstance(body, dict):
                if body.get('mode'):
                    self.server.mode = str(body['mode'])
                if body.get('sub'):
                    self.server.sub = str(body['sub'])
                if body.get('github_id'):
                    self.server.github_id = int(body['github_id'])
            self._send(200, '{"ok":true}')
            return
        if path in ('/google/token', '/github/token'):
            self._token('google' if 'google' in path else 'github')
            return
        self._send(404, '{"error":"not found"}')

    def _authorize(self, provider):
        params = self._query()
        redirect_uri = self._one(params, 'redirect_uri')
        state = self._one(params, 'state')
        if not self._loopback(redirect_uri) or not state:
            self._send(400, '{"error":"bad redirect"}')
            return
        record = {
            'provider': provider,
            'state': state,
            'redirect_uri': redirect_uri,
            'code_challenge': self._one(params, 'code_challenge'),
            'code_challenge_method': self._one(params, 'code_challenge_method'),
            'nonce': self._one(params, 'nonce'),
            'client_id': self._one(params, 'client_id'),
        }
        code = secrets.token_urlsafe(18)
        with self.server._lock:
            self.server.pending[state] = record
            self.server.codes[code] = state
            self.server.last_authorize = dict(record, code=code)
        if self.server.mode == 'cancel':
            self._redirect(redirect_uri + '?' + urlencode({'error': 'access_denied', 'state': state}))
            return
        if self.server.mode == 'provider_error':
            self._redirect(redirect_uri + '?' + urlencode({'error': 'server_error', 'state': state}))
            return
        if self.server.mode == 'hold':
            self._send(200, 'provider is waiting', content_type='text/plain')
            return
        self._redirect(redirect_uri + '?' + urlencode({'code': code, 'state': state}))

    def _token(self, provider):
        if self.server.mode == 'timeout':
            time.sleep(3)
        if self.server.mode == 'outage':
            self._send(500, '{"error":"server_error"}')
            return
        form = self._read_form()
        code = (form.get('code') or [''])[0]
        verifier = (form.get('code_verifier') or [''])[0]
        secret = (form.get('client_secret') or [''])[0]
        redirect_uri = (form.get('redirect_uri') or [''])[0]
        with self.server._lock:
            state = self.server.codes.get(code, '')
            pending = self.server.pending.get(state, {})
            expected = self.server.google_secret if provider == 'google' else self.server.github_secret
            secret_ok = bool(expected) and secret == expected
            match = bool(verifier) and _challenge(verifier) == pending.get('code_challenge')
            self.server.token_calls += 1
            self.server.last_token = {
                'provider': provider,
                'redirect_uri': redirect_uri,
                'verifier_matches': match,
                'secret_ok': secret_ok,
                'code_len': len(code),
            }
        if self.server.mode == 'pkce' or not match or not secret_ok:
            self._send(400, '{"error":"invalid_grant"}')
            return
        if provider == 'github':
            self._send(200, json.dumps({
                'access_token': ACCESS_TOKEN, 'token_type': 'bearer', 'scope': 'read:user,user:email',
            }))
            return
        now = int(time.time())
        nonce = pending.get('nonce') or ''
        aud = pending.get('client_id') or ''
        exp = now + 300
        sub = self.server.sub
        if self.server.mode == 'badaud':
            aud = 'someone-else'
        elif self.server.mode == 'badnonce':
            nonce = 'not-the-nonce'
        elif self.server.mode == 'badexp':
            exp = now - 3600
        token = self.server.sign({
            'iss': 'https://accounts.google.com',
            'aud': aud,
            'sub': sub,
            'email': 'ada@example.com',
            'email_verified': True,
            'name': 'Ada Lovelace',
            'nonce': nonce,
            'exp': exp,
            'iat': now,
        }, bad=self.server.mode == 'badsig')
        self._send(200, json.dumps({
            'access_token': ACCESS_TOKEN,
            'refresh_token': 'refresh-should-not-be-stored',
            'id_token': token,
            'token_type': 'Bearer',
        }))
