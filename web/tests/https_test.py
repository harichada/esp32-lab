"""HTTPS flags: ACME webroot, redirect, HSTS, the TLS listener, and health.

Flags default off. Nothing here contacts the live host. Host names in these
tests are headers sent to 127.0.0.1.
"""
import asyncio, base64, http.client, json, os, re, socket, ssl, subprocess, sys, tempfile, unittest, urllib.parse
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


def _b64url(raw):
    return base64.urlsafe_b64encode(raw).decode('ascii').rstrip('=')


def urllib_body(payload):
    return urllib.parse.urlencode({'payload': payload}).encode()


def _assert_move_page(body, csp, form_action):
    text = body.decode('utf-8')
    end = text.index('</script>')
    first = text[:end]
    assert 'history.replaceState' in first
    assert 'location.hash' in first
    assert 'clMigrate' not in first
    assert end < text.index('clMigrate')
    assert '<script src' not in text
    assert '<link ' not in text
    assert '<img ' not in text
    assert "default-src 'none'" in csp
    assert "script-src 'nonce-" in csp
    assert 'unsafe-inline' not in csp
    assert 'unsafe-eval' not in csp
    assert "style-src 'none'" in csp
    assert "img-src 'none'" in csp
    assert "connect-src 'none'" in csp
    assert 'form-action %s' % form_action in csp
    assert 'upgrade-insecure-requests' not in csp


def _chunked_post(port, host, cafile, piece, total):
    ctx = ssl.create_default_context(cafile=cafile)
    raw = socket.create_connection(('127.0.0.1', port), 30)
    sock = ctx.wrap_socket(raw, server_hostname='127.0.0.1')
    try:
        sock.settimeout(30)
        sock.sendall((
            'POST /migrate HTTP/1.1\r\nHost: %s\r\n'
            'Content-Type: application/x-www-form-urlencoded\r\n'
            'Transfer-Encoding: chunked\r\n\r\n' % host
        ).encode())
        sent = 0
        while sent < total:
            blob = piece[:min(len(piece), total - sent)]
            sock.sendall(b'%x\r\n%s\r\n' % (len(blob), blob))
            sent += len(blob)
        sock.sendall(b'0\r\n\r\n')
        data = b''
        while b'\r\n\r\n' not in data:
            chunk = sock.recv(4096)
            if not chunk:
                break
            data += chunk
        head, _, rest = data.partition(b'\r\n\r\n')
        status = int(head.split(b' ', 2)[1])
        pairs = []
        for line in head.split(b'\r\n')[1:]:
            if b':' in line:
                name, value = line.split(b':', 1)
                pairs.append((name.decode().lower(), value.decode().strip()))
        length = _header(pairs, 'content-length')
        body = rest
        if length is not None:
            need = int(length) - len(body)
            while need > 0:
                chunk = sock.recv(need)
                if not chunk:
                    break
                body += chunk
                need -= len(chunk)
        return status, pairs, body
    finally:
        sock.close()


def _response_headers(raw):
    head = raw.split(b'\r\n\r\n', 1)[0]
    lines = head.split(b'\r\n')
    status = int(lines[0].split(b' ', 2)[1])
    found = {}
    for line in lines[1:]:
        if b':' not in line:
            continue
        name, value = line.split(b':', 1)
        found.setdefault(name.lower(), []).append(value.strip())
    return status, found, head


def _assert_absolute_form(testcase, raw, forged, location):
    """400, or a 301 whose Location is exactly ``location``. The authority is not a header."""
    status, headers, head = _response_headers(raw)
    folded = head.lower()
    for name in forged:
        testcase.assertNotIn(name.lower(), folded)
    if status == 400:
        testcase.assertNotIn(b'location', headers, raw[:300])
        return
    testcase.assertEqual(status, 301, raw[:300])
    testcase.assertEqual(headers.get(b'location'), [location])


def _raw_request(port, text):
    sock = socket.create_connection(('127.0.0.1', port), 5)
    try:
        sock.settimeout(5)
        sock.sendall(text.encode())
        data = b''
        while b'\r\n\r\n' not in data:
            chunk = sock.recv(4096)
            if not chunk:
                break
            data += chunk
        return data
    finally:
        sock.close()


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
    os.chmod(key, 0o600)
    return cert, key


class HttpsUnitTest(unittest.TestCase):
    def tearDown(self):
        https.apply_env({})
        https.set_listener(False, '')
        https.set_logger(https._default_log)

    def test_token_alphabet_and_length(self):
        self.assertEqual(https.TOKEN_RE.pattern, r'^[A-Za-z0-9_-]{20,128}$')
        self.assertIsNotNone(https.TOKEN_RE.fullmatch('abcXYZ_09-abcdefghij'))
        self.assertIsNotNone(https.TOKEN_RE.fullmatch('a' * 20))
        self.assertIsNotNone(https.TOKEN_RE.fullmatch('a' * 128))
        for bad in ('', 'a' * 19, 'a' * 129, '.', '..', '../etc/passwd', 'a/b', 'a.b', 'a b', 'a\\b', 'a%2e', '%2e%2e', '%2f', '%5c'):
            self.assertIsNone(https.TOKEN_RE.fullmatch(bad), bad)

    def test_challenge_file_layout_and_traversal(self):
        with tempfile.TemporaryDirectory() as tmp:
            challenge = Path(tmp) / '.well-known' / 'acme-challenge'
            challenge.mkdir(parents=True)
            token = 'a' * 20
            (challenge / token).write_bytes(b'challenge-body')
            (challenge / ('b' * 19)).write_bytes(b'too-short')
            (Path(tmp) / token).write_bytes(b'wrong-place')
            (challenge / ('c' * 20)).symlink_to('/etc/passwd')
            (challenge / ('d' * 20)).symlink_to(challenge / token)
            (challenge / 'subdir').mkdir()
            self.assertEqual(https.load_challenge(tmp, token), b'challenge-body')
            self.assertIsNone(https.load_challenge(tmp, 'b' * 19))
            self.assertIsNone(https.load_challenge(tmp, 'c' * 20))
            self.assertIsNone(https.load_challenge(tmp, 'd' * 20))
            self.assertIsNone(https.load_challenge(tmp, 'missingtoken1234567890'))
            self.assertIsNone(https.load_challenge(tmp, '..'))
            self.assertIsNone(https.load_challenge(tmp, 'subdir'))
            self.assertIsNone(https.load_challenge('', token))
            self.assertIsNone(https.load_challenge(tmp, 'a/b'))

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
        https.apply_env({
            'ALLOWED_HOSTS': '%s,%s' % (IP_HOST, HOST),
            'HTTPS_REDIRECT': '1',
            'HTTPS_HOST': HOST,
        })
        self.assertEqual(https.normalize_authority('http', HOST.upper() + '.:80'), HOST)
        self.assertEqual(https.normalize_authority('https', IP_HOST + ':443'), IP_HOST)
        self.assertEqual(https.normalize_authority('http', 'evil.example:444'), 'evil.example:444')
        self.assertEqual(https.normalize_authority('http', 'user@' + HOST), '')
        evil = {
            'path': '/some/path', 'raw_path': b'/some/path', 'query_string': b'x=1',
            'headers': [(b'host', HOST.encode())],
            'cl_request_target': b'http://evil.example/some/path?x=1',
        }
        self.assertIsNone(https._origin_scope(evil))
        built = https.redirect_location(evil, HOST)
        self.assertEqual(built, 'https://%s/some/path?x=1' % HOST)
        self.assertNotIn('evil.example', built)
        dotted = dict(evil)
        dotted['cl_request_target'] = ('http://%s.:80/some/path?x=1' % HOST.upper()).encode()
        origin = https._origin_scope(dotted)
        self.assertEqual(origin['path'], '/some/path')
        self.assertEqual(origin['query_string'], b'x=1')
        self.assertNotIn(b'://', origin['raw_path'])
        self.assertEqual(https.redirect_location(origin, HOST), 'https://%s/some/path?x=1' % HOST)

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
                self.assertEqual(off, {'enabled': False, 'cert_not_after': None, 'days_left': None, 'warning': False, 'reason': None})
                https._load_expiry = lambda path: ('2026-12-01T00:00:00Z', 13)
                https.set_listener(True, cert)
                soon = https.tls_status(now=3000)
                self.assertTrue(soon['warning'])
                self.assertEqual(soon['reason'], 'certificate has 13 days left')
                https._load_expiry = lambda path: ('2026-12-01T00:00:00Z', 14)
                https.set_listener(True, cert)
                later = https.tls_status(now=4000)
                self.assertFalse(later['warning'])
                self.assertIsNone(later['reason'])
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
        renew = (root.parents[0] / 'docker' / 'letsencrypt' / 'esp32lab-certbot-renew.sh').read_text()
        self.assertIn('set -eu', renew)
        self.assertLess(renew.index('certbot renew --dry-run'), renew.index('certbot renew\n'))
        timer = (root.parents[0] / 'docker' / 'letsencrypt' / 'esp32lab-certbot.timer').read_text()
        self.assertIn('OnCalendar=weekly', timer)
        self.assertIn('Persistent=true', timer)
        unit = (root.parents[0] / 'docker' / 'letsencrypt' / 'esp32lab-certbot.service').read_text()
        self.assertIn('Type=oneshot', unit)
        self.assertIn('esp32lab-certbot-renew', unit)

    def test_each_project_is_checked_before_a_merge_would_run(self):
        big = 'x' * (https.PROJECT_CAP + 1)
        record = {
            'v': 1, 'origin': 'http://127.0.0.1', 'exportedAt': 1, 'path': '/', 'query': '',
            'items': [{'k': 'esp32lab.projects.v1', 'v': json.dumps({'p1': {
                'id': 'p1', 'name': 'Lamp', 'updated': 1,
                'proj': {'id': 'p1', 'name': 'Lamp', 'parts': [], 'wires': [], 'blob': big},
            }})}],
        }
        self.assertEqual(https.validate_bundle(record), 'bad project')
        record['items'][0]['v'] = json.dumps({'p1': {
            'id': 'p1', 'name': 'Lamp', 'updated': 1,
            'proj': {'id': 'p1', 'name': 'Lamp', 'parts': [], 'wires': []},
        }})
        self.assertEqual(https.validate_bundle(record), '')

    def test_streamed_body_over_the_cap_is_discarded(self):
        chunks = [
            {'type': 'http.request', 'body': b'abcd', 'more_body': True},
            {'type': 'http.request', 'body': b'e', 'more_body': False},
        ]

        async def pull():
            return chunks.pop(0)

        self.assertIs(asyncio.run(https._read_capped(pull, 4)), False)
        self.assertEqual(chunks, [])

        async def exact():
            return {'type': 'http.request', 'body': b'abcd', 'more_body': False}

        self.assertEqual(asyncio.run(https._read_capped(exact, 4)), b'abcd')


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
        cls.token = 'goodtoken0123456789abcd'
        (challenge / cls.token).write_text('challenge-body', encoding='ascii')
        (challenge / 'short').write_text('too-short', encoding='ascii')
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
        root, pairs, page = request(self.http, 'GET', '/', host=IP_HOST)
        self.assertEqual(root, 200)
        self.assertIsNone(_header(pairs, 'location'))
        self.assertIn(b'clMigrate.handoff', page)
        self.assertIn(b'nonce=', page)
        self.assertNotIn(b'upgrade-insecure-requests', page)
        _assert_move_page(page, _header(pairs, 'content-security-policy'), 'https://%s' % HOST)
        self.assertEqual(_header(pairs, 'cache-control'), 'no-store')
        asset, pairs, _ = request(self.http, 'GET', '/js/app.js?v=80', host=IP_HOST)
        self.assertEqual(asset, 301)
        self.assertEqual(_header(pairs, 'location'), 'https://%s/js/app.js?v=80' % HOST)
        posted, pairs, _ = request(self.http, 'POST', '/', host=IP_HOST, body=b'a=1')
        self.assertEqual(posted, 308)
        self.assertEqual(_header(pairs, 'location'), 'https://%s/' % HOST)
        notices, _, notice = request(self.http, 'GET', '/notices.html', host=HOST)
        self.assertEqual(notices, 200)
        self.assertIn(b'clMigrate.handoff', notice)
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
        status, pairs, body = request(self.http, 'GET', '/.well-known/acme-challenge/' + self.token, host=IP_HOST)
        self.assertEqual(status, 200, body)
        self.assertEqual(_header(pairs, 'content-type'), 'text/plain')
        self.assertEqual(body, b'challenge-body')
        self.assertIsNone(_header(pairs, 'location'))
        status, _, body = request(self.http, 'GET', '/.well-known/acme-challenge/', host=IP_HOST)
        self.assertEqual(status, 404)
        self.assertNotIn(self.token.encode(), body)
        raw = ws_status(self.http, IP_HOST)
        self.assertTrue(raw.startswith(b'HTTP/1.1 403'), raw)
        self.assertIn(b'Use wss://', raw)

    def test_acme_rejects_traversal_even_when_redirect_is_on(self):
        https.apply_env({'HTTPS_REDIRECT': '1', 'HTTPS_HOST': HOST, 'ACME_WEBROOT': str(self.webroot)})
        server.TOKEN = 'secret'
        status, _, body = request(self.http, 'GET', '/.well-known/acme-challenge/' + self.token)
        self.assertEqual(status, 200)
        self.assertEqual(body, b'challenge-body')
        status, _, _ = request(self.http, 'GET', '/api/health')
        self.assertEqual(status, 401)
        for path in (
            '/.well-known/acme-challenge/escape',
            '/.well-known/acme-challenge/..',
            '/.well-known/acme-challenge/%2e%2e',
            '/.well-known/acme-challenge/%2e%2e/%2e%2e/etc/passwd',
            '/.well-known/acme-challenge/' + self.token + '/../../etc/passwd',
            '/.well-known/acme-challenge/a.b',
            '/.well-known/acme-challenge/' + ('a' * 129),
            '/.well-known/acme-challenge/%2fetc%2fpasswd',
            '/.well-known/acme-challenge/%5cetc%5cpasswd',
            '/.well-known/acme-challenge/%252e%252e',
            '/.well-known/acme-challenge/%252fetc',
            '/.well-known/acme-challenge/%255cetc',
            '/.well-known/acme-challenge/short',
            '/.well-known/acme-challenge/' + ('a' * 19),
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
        self.assertEqual(set(data['tls']), {'enabled', 'cert_not_after', 'days_left', 'warning', 'reason'})
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

    def test_redirect_stays_off_for_the_ip_while_tls_is_down(self):
        logs = []
        https.set_logger(lambda msg: logs.append(str(msg)))
        https.set_listener(False, '')
        https.apply_env({'HTTPS_REDIRECT': '1', 'HTTPS_HOST': IP_HOST})
        status, pairs, _ = request(self.http, 'GET', '/some/path?x=1', host=IP_HOST)
        self.assertNotIn(status, (301, 308))
        self.assertIsNone(_header(pairs, 'location'))
        self.assertTrue(any('IP host' in line and 'TLS is down' in line for line in logs), logs)
        https.set_listener(True, self.cert)
        https.apply_env({'HTTPS_REDIRECT': '1', 'HTTPS_HOST': HOST})
        status, pairs, _ = request(self.http, 'GET', '/some/path?x=1', host=IP_HOST)
        self.assertEqual(status, 301)
        self.assertEqual(_header(pairs, 'location'), 'https://%s/some/path?x=1' % HOST)

    def test_forged_host_is_not_a_redirect_target(self):
        https.apply_env({
            'ALLOWED_HOSTS': '%s,%s' % (IP_HOST, HOST),
            'HTTPS_REDIRECT': '1',
            'HTTPS_HOST': HOST,
        })
        for host in (HOST + ':443', HOST + '.', HOST.upper(), IP_HOST + ':80'):
            status, pairs, _ = request(self.http, 'GET', '/some/path?x=1', host=host)
            self.assertEqual(status, 301, host)
            self.assertEqual(_header(pairs, 'location'), 'https://%s/some/path?x=1' % HOST, host)
        for host in ('evil.example', 'evil.example:443', 'evil.example.'):
            status, pairs, body = request(self.http, 'GET', '/some/path?x=1', host=host)
            self.assertEqual(status, 400, host)
            self.assertIn(b'unknown host', body)
            self.assertIsNone(_header(pairs, 'location'), host)
        wanted = b'https://%s/some/path?x=1' % HOST.encode()
        raw = _raw_request(
            self.http,
            'GET http://evil.example/some/path?x=1 HTTP/1.1\r\nHost: %s\r\n\r\n' % HOST,
        )
        _assert_absolute_form(self, raw, (b'evil.example',), wanted)
        both = _raw_request(
            self.http,
            'GET http://evil.example/some/path?x=1 HTTP/1.1\r\nHost: forged.example\r\n\r\n',
        )
        status, headers, head = _response_headers(both)
        self.assertEqual(status, 400, both[:240])
        self.assertNotIn(b'location', headers)
        self.assertNotIn(b'evil.example', head.lower())
        self.assertNotIn(b'forged.example', head.lower())
        denied = _raw_request(
            self.http,
            'GET http://evil.example/some/path?x=1 HTTP/1.1\r\nHost: evil.example\r\n\r\n',
        )
        self.assertTrue(denied.startswith(b'HTTP/1.1 400'), denied[:240])
        self.assertNotIn(b'location:', denied.lower())
        self.assertNotIn(b'evil.example', denied.split(b'\r\n\r\n', 1)[0].lower())
        allowed = _raw_request(
            self.http,
            'GET http://%s.:80/some/path?x=1 HTTP/1.1\r\nHost: %s\r\n\r\n' % (HOST.upper(), HOST),
        )
        status, headers, head = _response_headers(allowed)
        self.assertEqual(status, 301, allowed[:240])
        self.assertEqual(headers.get(b'location'), [wanted])
        self.assertNotIn(HOST.upper().encode(), head)
        self.assertNotIn(b':80', head.lower())

    def test_move_post_is_validated_and_not_stored(self):
        https.apply_env({'HTTPS_REDIRECT': '1', 'HTTPS_HOST': HOST})
        record = {
            'v': 1,
            'origin': 'http://127.0.0.1',
            'exportedAt': 1,
            'path': '/some/path',
            'query': 'x=1',
            'items': [{
                'k': 'esp32lab.projects.v1',
                'v': json.dumps({'p1': {
                    'id': 'p1', 'name': 'Lamp </script>', 'updated': 5,
                    'proj': {'id': 'p1', 'name': 'Lamp </script>', 'parts': [], 'wires': []},
                }}),
            }],
        }
        packed = '0.' + _b64url(json.dumps(record).encode())
        status, _, body = request(
            self.tls, 'POST', '/migrate', host=HOST, tls=True, cafile=self.cert,
            headers={'Content-Type': 'application/x-www-form-urlencoded'},
            body=urllib_body(packed),
        )
        self.assertEqual(status, 200, body[:200])
        self.assertIn(b'clMigrate.receive', body)
        self.assertNotIn(b'Lamp </script>', body)
        self.assertIn(b'Lamp \\u003c/script>', body)
        bad = request(
            self.tls, 'POST', '/migrate', host=HOST, tls=True, cafile=self.cert,
            headers={'Content-Type': 'application/x-www-form-urlencoded'},
            body=urllib_body('0.' + _b64url(b'{"v":2}')),
        )
        self.assertEqual(bad[0], 400)
        self.assertEqual(_header(bad[1], 'cache-control'), 'no-store')
        self.assertIn(b'could not be moved', bad[2])
        self.assertNotIn(b'clMigrate.receive', bad[2])
        self.assertIn("default-src 'none'", _header(bad[1], 'content-security-policy'))

    def test_migrate_page_clears_the_fragment_first_and_locks_the_csp(self):
        https.apply_env({'HTTPS_REDIRECT': '1', 'HTTPS_HOST': HOST})
        status, pairs, body = request(self.tls, 'GET', '/migrate', host=HOST, tls=True, cafile=self.cert)
        self.assertEqual(status, 200, body[:180])
        self.assertIn(b'clMigrate.receive', body)
        _assert_move_page(body, _header(pairs, 'content-security-policy'), "'none'")
        self.assertEqual(_header(pairs, 'cache-control'), 'no-store')
        self.assertEqual(_header(pairs, 'referrer-policy'), 'no-referrer')
        self.assertNotIn(b'upgrade-insecure-requests', body)
        self.assertNotIn(b'upgrade-insecure-requests', _header(pairs, 'content-security-policy').encode())

    def test_post_cap_content_type_and_no_body_in_logs(self):
        import logging
        https.apply_env({'HTTPS_REDIRECT': '1', 'HTTPS_HOST': HOST})
        logs = []
        https.set_logger(lambda msg: logs.append(str(msg)))
        grabbed = []

        class Grab(logging.Handler):
            def emit(self, record):
                grabbed.append(record.getMessage())
                if record.exc_info and record.exc_info[1] is not None:
                    grabbed.append(str(record.exc_info[1]))
                if record.exc_text:
                    grabbed.append(record.exc_text)

        handler = Grab()
        loggers = [logging.getLogger(name) for name in ('', 'uvicorn', 'uvicorn.error', 'uvicorn.access')]
        for lg in loggers:
            lg.addHandler(handler)
        marker = 'MOVESECRET-not-stored-991'
        try:
            over = request(
                self.tls, 'POST', '/migrate', host=HOST, tls=True, cafile=self.cert,
                headers={
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': str(https.MIGRATE_CAP + 1),
                },
                body=('payload=' + marker).encode(),
            )
            self.assertEqual(over[0], 413, over[2][:200])
            self.assertEqual(_header(over[1], 'cache-control'), 'no-store')
            self.assertIn(b'request too large', over[2])
            self.assertNotIn(marker.encode(), over[2])

            missing = request(
                self.tls, 'POST', '/migrate', host=HOST, tls=True, cafile=self.cert,
                body=('payload=' + marker).encode(),
            )
            self.assertEqual(missing[0], 415)
            self.assertEqual(_header(missing[1], 'cache-control'), 'no-store')
            self.assertIn(b'unsupported media type', missing[2])
            self.assertNotIn(marker.encode(), missing[2])

            for media in ('text/plain', 'application/json', 'application/x-www-form-urlencoded; charset=utf-8'):
                sent = request(
                    self.tls, 'POST', '/migrate', host=HOST, tls=True, cafile=self.cert,
                    headers={'Content-Type': media},
                    body=('payload=' + marker).encode(),
                )
                if media.startswith('application/x-www-form-urlencoded'):
                    self.assertEqual(sent[0], 400, media)
                    self.assertIn(b'could not be moved', sent[2])
                else:
                    self.assertEqual(sent[0], 415, media)
                    self.assertIn(b'unsupported media type', sent[2])
                self.assertEqual(_header(sent[1], 'cache-control'), 'no-store', media)
                self.assertNotIn(marker.encode(), sent[2])

            malformed = request(
                self.tls, 'POST', '/migrate', host=HOST, tls=True, cafile=self.cert,
                headers={'Content-Type': 'application/x-www-form-urlencoded'},
                body=urllib_body('0.' + _b64url(('{"v":2,"note":"%s"}' % marker).encode())),
            )
            self.assertEqual(malformed[0], 400)
            self.assertEqual(_header(malformed[1], 'cache-control'), 'no-store')
            self.assertIn(b'could not be moved', malformed[2])
            self.assertNotIn(marker.encode(), malformed[2])
            self.assertNotIn(b'clMigrate.receive', malformed[2])

            original = https.unpack_payload
            def boom(_text):
                raise RuntimeError('TRACE-MARKER-991')
            https.unpack_payload = boom
            try:
                traced = request(
                    self.tls, 'POST', '/migrate', host=HOST, tls=True, cafile=self.cert,
                    headers={'Content-Type': 'application/x-www-form-urlencoded'},
                    body=urllib_body('0.' + _b64url(b'{"v":1}')),
                )
            finally:
                https.unpack_payload = original
            self.assertEqual(traced[0], 400)
            self.assertNotIn(b'TRACE-MARKER-991', traced[2])
            self.assertNotIn(b'clMigrate.receive', traced[2])

            chunked = _chunked_post(self.tls, HOST, self.cert, marker.encode() * 64, https.MIGRATE_CAP + 1)
            self.assertEqual(chunked[0], 413, chunked[2][:200])
            self.assertEqual(_header(chunked[1], 'cache-control'), 'no-store')
            self.assertIn(b'request too large', chunked[2])
            self.assertNotIn(marker.encode(), chunked[2])
            self.assertLess(len(chunked[2]), 400)
        finally:
            for lg in loggers:
                lg.removeHandler(handler)
            https.set_logger(https._default_log)
        joined = '\n'.join(logs + grabbed)
        self.assertNotIn(marker, joined)
        self.assertNotIn('TRACE-MARKER-991', joined)


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
            self.assertEqual(data['tls']['enabled'], False)
            self.assertEqual(data['tls']['warning'], False)
            self.assertEqual(data['ok'], _qemu_ok())
        finally:
            bg.stop()
        warnings = [line for line in logs if line.startswith('tls key warning')]
        self.assertEqual(len(warnings), 1, logs)
        self.assertIn('reason=missing', warnings[0])
        self.assertIn('serving=http', warnings[0])
        self.assertIn('path=/tmp/esp32lab-no-such-privkey.pem', warnings[0])

    def test_bad_pem_and_busy_port_keep_http(self):
        with tempfile.TemporaryDirectory() as tmp:
            cert = os.path.join(tmp, 'cert.pem')
            key = os.path.join(tmp, 'key.pem')
            Path(cert).write_text('not a certificate\n', encoding='ascii')
            Path(key).write_text('not a key\n', encoding='ascii')
            os.chmod(key, 0o600)
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
            warnings = [line for line in logs if line.startswith('tls key warning')]
            self.assertEqual(len(warnings), 1, logs)
            self.assertIn('reason=invalid', warnings[0])
            self.assertIn('serving=http', warnings[0])
            self.assertIn('mode=600', warnings[0])

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

    def test_unreadable_key_keeps_http(self):
        with tempfile.TemporaryDirectory() as tmp:
            cert, key = _make_cert(tmp)
            os.chmod(key, 0o000)
            logs = []
            https.set_logger(lambda msg: logs.append(str(msg)))
            https.apply_env({'TLS_CERT_FILE': cert, 'TLS_KEY_FILE': key, 'HTTPS_HOST': HOST, 'HTTPS_REDIRECT': '1'})
            bg = https.Background(server.app, tls_port=0).start()
            try:
                self.assertIsNone(bg.tls_port)
                status, pairs, body = request(bg.http_port, 'GET', '/api/health')
                self.assertEqual(status, 200)
                data = json.loads(body)
                self.assertEqual(data['ok'], _qemu_ok())
                self.assertFalse(data['tls']['enabled'])
                page, page_pairs, _ = request(bg.http_port, 'GET', '/')
                self.assertNotIn(page, (301, 308))
                self.assertIsNone(_header(page_pairs, 'location'))
                posture = https.key_posture(key)
                self.assertEqual(posture['mode'], '000')
                self.assertFalse(posture['readable'])
                self.assertIn('root', https.key_posture.__doc__)
                self.assertIn('600', https.key_posture.__doc__)
                self.assertIn('read-only', https.key_posture.__doc__)
            finally:
                os.chmod(key, 0o600)
                bg.stop()
            warnings = [line for line in logs if line.startswith('tls key warning')]
            self.assertEqual(len(warnings), 1, logs)
            self.assertIn('reason=unreadable', warnings[0])
            self.assertIn('mode=000', warnings[0])
            self.assertIn('serving=http', warnings[0])


if __name__ == '__main__':
    unittest.main()
