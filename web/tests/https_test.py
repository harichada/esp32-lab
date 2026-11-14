"""HTTPS flags: ACME webroot, redirect, HSTS, the TLS listener, and health.

Flags default off. Nothing here contacts the live host. Host names in these
tests are headers sent to 127.0.0.1.
"""
import asyncio, http.client, json, os, re, socket, ssl, subprocess, sys, tempfile, unittest
from datetime import datetime, timezone
from pathlib import Path

os.environ['SIM_PREWARM'] = '0'
os.environ['SIM_NETSTACK_WARM'] = '0'
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import https
import server
import staging

HOST = '129-158-200-25.sslip.io'
IP_HOST = '129.158.200.25'
NS_HTTP = (
    'http://www.w3.org/2000/svg',
    'http://www.w3.org/1999/xlink',
    'http://schemas.xmlsoap.org/',
)


def _qemu_ok():
    return Path(server.QEMU).exists() and bool(server.CLI) and Path(server.CLI).exists()


def _pairs(resp):
    return [(k.lower(), v) for k, v in resp.getheaders()]


def _header(pairs, name):
    vals = [v for k, v in pairs if k == name.lower()]
    if not vals:
        return None
    return vals[0] if len(vals) == 1 else vals


def request(port, method, path, host='127.0.0.1', body=None, headers=None, tls=False, cafile=None):
    if tls:
        ctx = ssl.create_default_context(cafile=cafile)
        conn = http.client.HTTPSConnection('127.0.0.1', port, context=ctx, timeout=5)
    else:
        conn = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
    hdrs = {'Host': host}
    if headers:
        hdrs.update(headers)
    conn.request(method, path, body=body, headers=hdrs)
    resp = conn.getresponse()
    payload = resp.read()
    pairs = _pairs(resp)
    conn.close()
    return resp.status, pairs, payload


def ws_status(port, host, path='/nowhere'):
    sock = socket.create_connection(('127.0.0.1', port), 5)
    try:
        sock.settimeout(5)
        sock.sendall((
            'GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'
            % (path, host)
        ).encode())
        data = b''
        while b'\r\n\r\n' not in data:
            chunk = sock.recv(4096)
            if not chunk:
                break
            data += chunk
        return data
    finally:
        sock.close()


def _make_cert(directory, days=40):
    cert = os.path.join(directory, 'cert.pem')
    key = os.path.join(directory, 'key.pem')
    subprocess.check_call([
        'openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', cert,
        '-days', str(days), '-nodes', '-subj', '/CN=127.0.0.1',
        '-addext', 'subjectAltName=IP:127.0.0.1',
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return cert, key


class HttpsUnitTest(unittest.TestCase):
    def tearDown(self):
        https.apply_env({})
        https.set_listener(False, '')
        https.set_logger(https._default_log)

    def test_token_alphabet_and_length(self):
        self.assertIsNotNone(https.TOKEN_RE.fullmatch('abcXYZ_09-'))
        self.assertIsNotNone(https.TOKEN_RE.fullmatch('a' * 128))
        for bad in ('', 'a' * 129, '.', '..', '../etc/passwd', 'a/b', 'a.b', 'a b', 'a\\b', 'a%2e', '%2e%2e'):
            self.assertIsNone(https.TOKEN_RE.fullmatch(bad), bad)

    def test_challenge_file_layout_and_traversal(self):
        with tempfile.TemporaryDirectory() as tmp:
            challenge = Path(tmp) / '.well-known' / 'acme-challenge'
            challenge.mkdir(parents=True)
            (challenge / 'good').write_bytes(b'challenge-body')
            (Path(tmp) / 'good').write_bytes(b'wrong-place')
            (challenge / 'escape').symlink_to('/etc/passwd')
            (challenge / 'subdir').mkdir()
            self.assertEqual(https.load_challenge(tmp, 'good'), b'challenge-body')
            self.assertIsNone(https.load_challenge(tmp, 'escape'))
            self.assertIsNone(https.load_challenge(tmp, 'missing'))
            self.assertIsNone(https.load_challenge(tmp, '..'))
            self.assertIsNone(https.load_challenge(tmp, 'subdir'))
            self.assertIsNone(https.load_challenge('', 'good'))
            self.assertIsNone(https.load_challenge(tmp, 'a/b'))
            escaped = https.load_challenge(tmp, 'escape')
            self.assertIsNone(escaped)

    def test_redirect_status_and_location_ignore_host(self):
        self.assertEqual(https.redirect_status('GET'), 301)
        self.assertEqual(https.redirect_status('HEAD'), 301)
        self.assertEqual(https.redirect_status('get'), 301)
        for method in ('POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'):
            self.assertEqual(https.redirect_status(method), 308, method)
        scope = {'path': '/some/path', 'raw_path': b'/some/path', 'query_string': b'x=1'}
        self.assertEqual(
            https.redirect_location(scope, HOST),
            'https://129-158-200-25.sslip.io/some/path?x=1',
        )
        self.assertEqual(
            https.redirect_location({'path': '/some/path', 'raw_path': b'/some/path', 'query_string': b''}, HOST),
            'https://129-158-200-25.sslip.io/some/path',
        )
        self.assertIsNone(https.redirect_location(scope, 'https://' + HOST))
        self.assertIsNone(https.redirect_location(scope, HOST + '/steal'))
        self.assertIsNone(https.redirect_location(scope, 'user@' + HOST))
        self.assertIsNone(https.redirect_location(
            {'path': '//evil.com', 'raw_path': b'//evil.com', 'query_string': b'x=1'}, HOST,
        ))

    def test_hsts_parse_and_host_list(self):
        logs = []
        https.set_logger(lambda msg: logs.append(str(msg)))
        self.assertEqual(https._parse_hsts(''), 0)
        self.assertEqual(https._parse_hsts('0'), 0)
        self.assertEqual(https._parse_hsts('300'), 300)
        self.assertEqual(https._parse_hsts('86400'), 86400)
        self.assertEqual(https._parse_hsts('31536000'), 31536000)
        self.assertEqual(https._parse_hsts('-1'), 0)
        self.assertEqual(https._parse_hsts('abc'), 0)
        self.assertEqual(https._parse_hsts('63072001'), 0)
        self.assertTrue(logs)
        https.apply_env({})
        self.assertIsNone(https.ALLOWED)
        https.apply_env({'ALLOWED_HOSTS': '129.158.200.25, %s' % HOST})
        self.assertEqual(https.ALLOWED, frozenset({IP_HOST, HOST}))
        self.assertEqual(https.normalize_host('129.158.200.25:80'), IP_HOST)
        self.assertEqual(https.normalize_host(HOST.upper()), HOST)
        self.assertEqual(https.tls_port_from_env({}), 8443)

    def test_cert_date_math(self):
        when = https.parse_not_after('Nov 14 00:00:00 2027 GMT')
        self.assertEqual(when, datetime(2027, 11, 14, tzinfo=timezone.utc))
        self.assertEqual(https.days_left(when, datetime(2027, 11, 13, 12, tzinfo=timezone.utc)), 0)
        self.assertEqual(https.days_left(when, datetime(2027, 11, 4, tzinfo=timezone.utc)), 10)
        self.assertIsNone(https.parse_not_after('not a date'))

    def test_expiry_cache_rereads_at_most_every_60s(self):
        with tempfile.TemporaryDirectory() as tmp:
            cert, _key = _make_cert(tmp)
            calls = {'n': 0}
            real = https._load_expiry
            def wrapped(path):
                calls['n'] += 1
                return real(path)
            https._load_expiry = wrapped
            try:
                https.set_listener(True, cert)
                first = https.tls_status(now=1000)
                second = https.tls_status(now=1059.9)
                self.assertEqual(calls['n'], 1)
                self.assertEqual(second, first)
                third = https.tls_status(now=1060)
                self.assertEqual(calls['n'], 2)
                self.assertEqual(third['cert_not_after'], first['cert_not_after'])
                self.assertTrue(first['enabled'])
                self.assertRegex(first['cert_not_after'], r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$')
                self.assertIsInstance(first['days_left'], int)
                https.set_listener(False, '')
                off = https.tls_status(now=2000)
                self.assertEqual(off, {'enabled': False, 'cert_not_after': None, 'days_left': None})
                self.assertEqual(calls['n'], 2)
            finally:
                https._load_expiry = real

    def test_redirect_stays_off_without_a_valid_host(self):
        logs = []
        https.set_logger(lambda msg: logs.append(str(msg)))
        https.apply_env({'HTTPS_REDIRECT': '1', 'HTTPS_HOST': 'https://evil.example/steal'})
        self.assertEqual(https.HTTPS_HOST, '')
        self.assertTrue(any('HTTPS_HOST rejected' in line for line in logs))
        called = {}

        async def app(scope, receive, send):
            called['yes'] = True
            await send({'type': 'http.response.start', 'status': 204, 'headers': []})
            await send({'type': 'http.response.body', 'body': b''})

        async def receive():
            return {'type': 'http.request', 'body': b'', 'more_body': False}

        async def send(message):
            return None

        asyncio.run(https.HttpsMiddleware(app)({
            'type': 'http', 'scheme': 'http', 'method': 'GET', 'path': '/some/path',
            'raw_path': b'/some/path', 'query_string': b'x=1',
            'headers': [(b'host', b'evil.example')],
        }, receive, send))
        self.assertTrue(called.get('yes'))

    def test_unset_tls_is_quiet(self):
        logs = []
        https.set_logger(lambda msg: logs.append(str(msg)))
        https.apply_env({})
        self.assertIsNone(https.tls_material())
        self.assertEqual(logs, [])

    def test_no_fetchable_http_urls_and_hook_restarts(self):
        root = Path(__file__).resolve().parents[1]
        files = [root / 'index.html']
        files += [p for p in (root / 'css').rglob('*') if p.is_file()]
        files += [p for p in (root / 'js').rglob('*') if p.is_file()]
        pattern = re.compile(r'http://[^\s\'"<>)]+')
        for path in files:
            text = path.read_text(encoding='utf-8', errors='replace')
            for match in pattern.finditer(text):
                url = match.group(0)
                self.assertTrue(url.startswith(NS_HTTP), '%s has %s' % (path, url))
        loader = re.compile(
            r'''(?:src|href|action)\s*=\s*['\"]http://|url\(\s*['\"]?http://|fetch\(\s*['\"]http://''',
            re.I,
        )
        for base in (root / 'js', root / 'css', root / 'vendor'):
            if not base.exists():
                continue
            for path in base.rglob('*'):
                if path.suffix not in ('.js', '.css', '.html'):
                    continue
                self.assertIsNone(loader.search(path.read_text(encoding='utf-8', errors='replace')), path)
        for page in (staging.PRIVATE_HTML, staging.DOWN_HTML):
            self.assertNotIn('http://', page)
        hook = (root.parents[0] / 'docker' / 'letsencrypt' / 'esp32lab-deploy-hook.sh').read_text()
        self.assertIn('docker restart esp32lab', hook)
        self.assertNotIn('-p 8765', hook)
        self.assertNotIn('8765:8765', hook)


class HttpsServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.environ['SIM_PREWARM'] = '0'
        os.environ['SIM_NETSTACK_WARM'] = '0'
        cls.tmp = tempfile.TemporaryDirectory()
        cls.cert, cls.key = _make_cert(cls.tmp.name)
        cls.webroot = Path(cls.tmp.name) / 'acme'
        challenge = cls.webroot / '.well-known' / 'acme-challenge'
        challenge.mkdir(parents=True)
        (challenge / 'goodtoken').write_text('challenge-body', encoding='ascii')
        (challenge / 'escape').symlink_to('/etc/passwd')
        https.apply_env({
            'TLS_CERT_FILE': cls.cert,
            'TLS_KEY_FILE': cls.key,
            'HTTPS_HOST': HOST,
            'ACME_WEBROOT': str(cls.webroot),
        })
        cls.bg = https.Background(server.app).start()
        cls.http = cls.bg.http_port
        cls.tls = cls.bg.tls_port

    @classmethod
    def tearDownClass(cls):
        cls.bg.stop()
        cls.tmp.cleanup()
        https.apply_env({})
        https.set_listener(False, '')
        staging.apply_env({})
        server.TOKEN = ''
        https.set_logger(https._default_log)

    def setUp(self):
        https.apply_env({'HTTPS_HOST': HOST, 'ACME_WEBROOT': str(self.webroot)})
        https.set_listener(True, self.cert)
        staging.apply_env({'SIM_STAGING': '0', 'SIM_ACCESS_TOKEN': '', 'SIM_STAGING_UPSTREAM': '', 'SIM_BASE_PATH': ''})
        server.TOKEN = ''

    def test_listener_is_the_self_signed_cert_and_proxy_headers_stay_off(self):
        self.assertIsNotNone(self.tls)
        self.assertNotEqual(self.http, self.tls)
        self.assertFalse(self.bg.http.config.proxy_headers)
        self.assertEqual(self.bg.http.config.forwarded_allow_ips, '')
        self.assertFalse(self.bg.tls.config.proxy_headers)
        self.assertEqual(self.bg.tls.config.forwarded_allow_ips, '')
        status, _, body = request(self.tls, 'GET', '/api/health', tls=True, cafile=self.cert)
        self.assertEqual(status, 200)
        ctx = ssl.create_default_context()
        conn = http.client.HTTPSConnection('127.0.0.1', self.tls, context=ctx, timeout=5)
        with self.assertRaises(ssl.SSLError):
            conn.request('GET', '/api/health')
            conn.getresponse()
        conn.close()
        self.assertIn(b'"ok"', body)

    def test_redirect_matrix_for_ip_and_sslip_hosts(self):
        https.apply_env({'HTTPS_REDIRECT': '1', 'HTTPS_HOST': HOST, 'ACME_WEBROOT': str(self.webroot)})
        target = 'https://129-158-200-25.sslip.io/some/path?x=1'
        for host in (IP_HOST, HOST, IP_HOST + ':80', 'evil.example'):
            for method, code in (('GET', 301), ('HEAD', 301), ('POST', 308), ('PUT', 308)):
                status, pairs, _ = request(self.http, method, '/some/path?x=1', host=host, body=b'{}' if method == 'POST' else None)
                self.assertEqual(status, code, '%s %s' % (method, host))
                self.assertEqual(_header(pairs, 'location'), target, host)
                self.assertNotIn(IP_HOST, _header(pairs, 'location'))
                self.assertIsNone(_header(pairs, 'strict-transport-security'))
        encoded, pairs, _ = request(self.http, 'GET', '/some/path?x=1&y=a%20b', host=IP_HOST)
        self.assertEqual(encoded, 301)
        self.assertEqual(
            _header(pairs, 'location'),
            'https://129-158-200-25.sslip.io/some/path?x=1&y=a%20b',
        )
        root, pairs, _ = request(self.http, 'GET', '/', host=IP_HOST)
        self.assertEqual(_header(pairs, 'location'), 'https://%s/' % HOST)
        self.assertNotEqual(_header(pairs, 'location'), 'https://%s' % HOST)
        # Redirect off: the same bookmark is not sent anywhere.
        https.apply_env({'HTTPS_REDIRECT': '0', 'HTTPS_HOST': HOST})
        status, pairs, _ = request(self.http, 'GET', '/some/path?x=1', host=IP_HOST)
        self.assertNotIn(status, (301, 308))
        self.assertIsNone(_header(pairs, 'location'))

    def test_redirect_exempts_health_and_acme_and_refuses_websocket(self):
        https.apply_env({'HTTPS_REDIRECT': '1', 'HTTPS_HOST': HOST, 'ACME_WEBROOT': str(self.webroot)})
        status, pairs, body = request(self.http, 'GET', '/api/health', host=IP_HOST)
        self.assertEqual(status, 200)
        self.assertIsNone(_header(pairs, 'location'))
        self.assertIn(b'"ok"', body)
        status, pairs, _ = request(self.http, 'POST', '/api/health', host=HOST, body=b'{}')
        self.assertNotIn(status, (301, 308))
        self.assertIsNone(_header(pairs, 'location'))
        status, pairs, body = request(self.http, 'GET', '/.well-known/acme-challenge/goodtoken', host=IP_HOST)
        self.assertEqual(status, 200, body)
        self.assertEqual(_header(pairs, 'content-type'), 'text/plain')
        self.assertEqual(body, b'challenge-body')
        self.assertIsNone(_header(pairs, 'location'))
        status, _, body = request(self.http, 'GET', '/.well-known/acme-challenge/', host=IP_HOST)
        self.assertEqual(status, 404)
        self.assertNotIn(b'goodtoken', body)
        raw = ws_status(self.http, IP_HOST)
        self.assertTrue(raw.startswith(b'HTTP/1.1 403'), raw)
        self.assertIn(b'Use wss://', raw)

    def test_acme_rejects_traversal_even_when_redirect_is_on(self):
        https.apply_env({'HTTPS_REDIRECT': '1', 'HTTPS_HOST': HOST, 'ACME_WEBROOT': str(self.webroot)})
        server.TOKEN = 'secret'
        status, _, body = request(self.http, 'GET', '/.well-known/acme-challenge/goodtoken')
        self.assertEqual(status, 200)
        self.assertEqual(body, b'challenge-body')
        status, _, _ = request(self.http, 'GET', '/api/health')
        self.assertEqual(status, 401)
        for path in (
            '/.well-known/acme-challenge/escape',
            '/.well-known/acme-challenge/..',
            '/.well-known/acme-challenge/%2e%2e',
            '/.well-known/acme-challenge/%2e%2e/%2e%2e/etc/passwd',
            '/.well-known/acme-challenge/goodtoken/../../etc/passwd',
            '/.well-known/acme-challenge/a.b',
            '/.well-known/acme-challenge/' + ('a' * 129),
            '/.well-known/acme-challenge/%2fetc%2fpasswd',
        ):
            status, pairs, body = request(self.http, 'GET', path, host=IP_HOST)
            self.assertNotIn(status, (301, 308), path)
            self.assertNotEqual(status, 200, path)
            self.assertNotIn(b'root:', body, path)
            self.assertIsNone(_header(pairs, 'location'), path)

    def test_hsts_and_upgrade_insecure_requests_only_on_https(self):
        https.apply_env({'HSTS_SECONDS': '300', 'HTTPS_REDIRECT': '1', 'HTTPS_HOST': HOST})
        status, pairs, _ = request(self.tls, 'GET', '/api/health', tls=True, cafile=self.cert)
        self.assertEqual(status, 200)
        self.assertEqual(_header(pairs, 'strict-transport-security'), 'max-age=300')
        self.assertNotIn('includeSubDomains', _header(pairs, 'strict-transport-security'))
        self.assertNotIn('preload', _header(pairs, 'strict-transport-security'))
        self.assertEqual(_header(pairs, 'content-security-policy'), 'upgrade-insecure-requests')
        status, pairs, _ = request(self.http, 'GET', '/api/health', host=IP_HOST)
        self.assertEqual(status, 200)
        self.assertIsNone(_header(pairs, 'strict-transport-security'))
        self.assertNotIn('upgrade-insecure-requests', _header(pairs, 'content-security-policy') or '')
        https.apply_env({'HSTS_SECONDS': '0', 'HTTPS_HOST': HOST})
        _, pairs, _ = request(self.tls, 'GET', '/api/health', tls=True, cafile=self.cert)
        self.assertIsNone(_header(pairs, 'strict-transport-security'))
        # An existing page CSP gains the directive on HTTPS and keeps it off on HTTP.
        staging.apply_env({'SIM_ACCESS_TOKEN': 'tok', 'SIM_STAGING': '0', 'SIM_BASE_PATH': '/'})
        _, secure_pairs, _ = request(self.tls, 'GET', '/api/health', tls=True, cafile=self.cert)
        csp = _header(secure_pairs, 'content-security-policy')
        self.assertIn("default-src 'none'", csp)
        self.assertIn('upgrade-insecure-requests', csp)
        _, plain_pairs, _ = request(self.http, 'GET', '/api/health')
        plain = _header(plain_pairs, 'content-security-policy')
        self.assertIn("default-src 'none'", plain)
        self.assertNotIn('upgrade-insecure-requests', plain)

    def test_secure_staging_cookie_follows_the_socket(self):
        https.apply_env({'HTTPS_REDIRECT': '0', 'HTTPS_HOST': HOST})
        staging.apply_env({
            'SIM_STAGING': '1', 'SIM_ACCESS_TOKEN': 'stage-token',
            'SIM_STAGING_UPSTREAM': '', 'SIM_BASE_PATH': '/',
        })
        status, pairs, _ = request(self.tls, 'GET', '/?t=stage-token', tls=True, cafile=self.cert)
        self.assertEqual(status, 302)
        cookie = _header(pairs, 'set-cookie')
        self.assertIn('cl_stage=', cookie)
        self.assertNotIn('stage-token', cookie)
        self.assertIn('Secure', cookie)
        self.assertIn('HttpOnly', cookie)
        status, pairs, _ = request(self.http, 'GET', '/?t=stage-token', headers={
            'X-Forwarded-Proto': 'https',
            'Forwarded': 'proto=https',
            'X-Forwarded-Host': 'evil.example',
        })
        self.assertEqual(status, 302)
        plain = _header(pairs, 'set-cookie').lower()
        self.assertIn('cl_stage=', plain)
        self.assertNotIn('secure', plain)

    def test_allowed_hosts_and_health_tls_fields(self):
        https.apply_env({
            'ALLOWED_HOSTS': '129.158.200.25, %s' % HOST,
            'HTTPS_REDIRECT': '1',
            'HTTPS_HOST': HOST,
            'HSTS_SECONDS': '300',
        })
        for host in (IP_HOST, HOST, IP_HOST + ':80', HOST.upper()):
            status, pairs, _ = request(self.http, 'GET', '/some/path?x=1', host=host)
            self.assertEqual(status, 301, host)
            self.assertEqual(_header(pairs, 'location'), 'https://%s/some/path?x=1' % HOST)
        status, pairs, body = request(self.http, 'GET', '/some/path?x=1', host='evil.example')
        self.assertEqual(status, 400)
        self.assertIn(b'unknown host', body)
        self.assertIsNone(_header(pairs, 'location'))
        status, _, body = request(self.http, 'GET', '/api/health', host=IP_HOST)
        self.assertEqual(status, 200)
        data = json.loads(body)
        self.assertEqual(data['ok'], _qemu_ok())
        self.assertEqual(set(data['tls']), {'enabled', 'cert_not_after', 'days_left'})
        iso, left = https._load_expiry(self.cert)
        self.assertEqual(data['tls']['enabled'], True)
        self.assertEqual(data['tls']['cert_not_after'], iso)
        self.assertEqual(data['tls']['days_left'], left)
        raw = ws_status(self.http, 'evil.example')
        self.assertTrue(raw.startswith(b'HTTP/1.1 400'), raw)
        self.assertIn(b'unknown host', raw)

    def test_wss_is_not_refused_when_redirect_is_on(self):
        https.apply_env({'HTTPS_REDIRECT': '1', 'HTTPS_HOST': HOST})
        called = {}

        async def app(scope, receive, send):
            called['scheme'] = scope.get('scheme')
            await send({'type': 'websocket.close', 'code': 1000})

        async def receive():
            return {'type': 'websocket.connect'}

        sent = []

        async def send(message):
            sent.append(message)

        asyncio.run(https.HttpsMiddleware(app)({
            'type': 'websocket', 'scheme': 'wss', 'path': '/api/run/x',
            'headers': [(b'host', HOST.encode())], 'query_string': b'',
        }, receive, send))
        self.assertEqual(called.get('scheme'), 'wss')
        self.assertTrue(any(item.get('type') == 'websocket.close' for item in sent))

    def test_index_html_has_no_mixed_content_url(self):
        status, _, body = request(self.tls, 'GET', '/', tls=True, cafile=self.cert)
        self.assertEqual(status, 200)
        text = body.decode('utf-8')
        for match in re.finditer(r'http://[^\s\'"<>)]+', text):
            self.assertTrue(match.group(0).startswith(NS_HTTP), match.group(0))
        self.assertIn('http://www.w3.org/2000/svg', text)


class HttpsFailSafeTest(unittest.TestCase):
    def tearDown(self):
        https.apply_env({})
        https.set_listener(False, '')
        https.set_logger(https._default_log)
        server.TOKEN = ''

    def test_missing_cert_serves_http_and_health_ok_is_unchanged(self):
        logs = []
        https.set_logger(lambda msg: logs.append(str(msg)))
        https.apply_env({
            'TLS_CERT_FILE': '/tmp/esp32lab-no-such-fullchain.pem',
            'TLS_KEY_FILE': '/tmp/esp32lab-no-such-privkey.pem',
            'HTTPS_HOST': HOST,
        })
        bg = https.Background(server.app, tls_port=0).start()
        try:
            self.assertIsNone(bg.tls)
            self.assertIsNone(bg.tls_port)
            status, _, body = request(bg.http_port, 'GET', '/api/health')
            self.assertEqual(status, 200)
            data = json.loads(body)
            self.assertEqual(data['ok'], _qemu_ok())
            self.assertEqual(data['tls'], {'enabled': False, 'cert_not_after': None, 'days_left': None})
        finally:
            bg.stop()
        text = '\n'.join(logs)
        self.assertIn('missing or unreadable', text)
        self.assertIn('serving HTTP only', text)
        self.assertIn('TLS_CERT_FILE=/tmp/esp32lab-no-such-fullchain.pem', text)

    def test_bad_pem_and_busy_port_keep_http(self):
        with tempfile.TemporaryDirectory() as tmp:
            cert = os.path.join(tmp, 'cert.pem')
            key = os.path.join(tmp, 'key.pem')
            Path(cert).write_text('not a certificate\n', encoding='ascii')
            Path(key).write_text('not a key\n', encoding='ascii')
            logs = []
            https.set_logger(lambda msg: logs.append(str(msg)))
            https.apply_env({'TLS_CERT_FILE': cert, 'TLS_KEY_FILE': key})
            bg = https.Background(server.app, tls_port=0).start()
            try:
                self.assertIsNone(bg.tls_port)
                status, _, body = request(bg.http_port, 'GET', '/api/health')
                self.assertEqual(status, 200)
                self.assertFalse(json.loads(body)['tls']['enabled'])
                self.assertEqual(json.loads(body)['ok'], _qemu_ok())
            finally:
                bg.stop()
            self.assertTrue(any('did not load' in line and 'serving HTTP only' in line for line in logs), logs)

            good, good_key = _make_cert(tmp)
            blocker = socket.socket()
            blocker.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            blocker.bind(('127.0.0.1', 0))
            blocker.listen(1)
            busy = blocker.getsockname()[1]
            logs.clear()
            https.apply_env({'TLS_CERT_FILE': good, 'TLS_KEY_FILE': good_key})
            bg = https.Background(server.app, tls_port=busy).start()
            try:
                self.assertIsNone(bg.tls_port)
                status, _, body = request(bg.http_port, 'GET', '/api/health')
                self.assertEqual(status, 200)
                self.assertFalse(json.loads(body)['tls']['enabled'])
            finally:
                bg.stop()
                blocker.close()
            self.assertTrue(any('cannot bind' in line and 'serving HTTP only' in line for line in logs), logs)


if __name__ == '__main__':
    unittest.main()
