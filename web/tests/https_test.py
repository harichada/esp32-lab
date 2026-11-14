"""HTTPS flags: trusted-proxy redirect, HSTS, and the project handoff.

Flags default off. Nothing here contacts the live host. Host names in these
tests are headers sent to 127.0.0.1. The documented proxy address is
172.30.0.250. This process does not terminate TLS.
"""
import asyncio, base64, http.client, json, os, re, socket, ssl, sys, unittest, urllib.parse
import websockets
from websockets.exceptions import InvalidStatus
from pathlib import Path

os.environ['SIM_PREWARM'] = '0'
os.environ['SIM_NETSTACK_WARM'] = '0'
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import https
import server
import staging

HOST = 'esp32lab.duckdns.org'
PROXY = '172.30.0.250'
NEIGHBOR = '172.30.0.5'
OLD_NET = '172.18.0.5'


def _on(env):
    """Turn the master flag on, then apply ``env``. An explicit 0 in ``env`` wins."""
    merged = {'HTTPS_ENABLED': '1'}
    merged.update(env)
    https.apply_env(merged)


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
    assert 'location.hash' not in text
    assert '__clMove' not in text
    assert 'clMigrate' not in first
    assert end < text.index('clMigrate')
    assert '<script src' not in text
    assert '<link ' not in text
    assert '<img ' not in text
    assert "default-src 'none'" in csp
    assert "script-src 'nonce-" in csp
    assert "script-src 'unsafe-inline'" not in csp
    assert 'unsafe-eval' not in csp
    assert "style-src 'unsafe-inline'" in csp
    assert "img-src 'none'" in csp
    assert "connect-src 'none'" in csp
    assert 'form-action %s' % form_action in csp
    assert 'upgrade-insecure-requests' not in csp


def _via_caddy(port, method, path, host=HOST, **kwargs):
    """A request the loopback peer presents as the trusted proxy."""
    headers = {'X-Forwarded-Proto': 'https'}
    headers.update(kwargs.pop('headers', None) or {})
    return request(port, method, path, host=host, headers=headers, **kwargs)


def _chunked_post(port, host, piece, total):
    sock = socket.create_connection(('127.0.0.1', port), 30)
    try:
        sock.settimeout(30)
        sock.sendall((
            'POST /migrate HTTP/1.1\r\nHost: %s\r\n'
            'X-Forwarded-Proto: https\r\n'
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
                return data
            data += chunk
        head, body = data.split(b'\r\n\r\n', 1)
        match = re.search(br'(?i)\r\ncontent-length:\s*(\d+)\r\n', head + b'\r\n')
        if match:
            need = int(match.group(1))
            while len(body) < need:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                body += chunk
        return head + b'\r\n\r\n' + body
    finally:
        sock.close()


class HttpsUnitTest(unittest.TestCase):
    def tearDown(self):
        https.apply_env({})
        https.set_logger(https._default_log)

    def test_trusted_proxy_ips_are_exact_addresses(self):
        logs = []
        https.set_logger(lambda msg: logs.append(str(msg)))
        https.apply_env({})
        self.assertEqual(https.PROXY_IPS, frozenset())
        https.apply_env({'TRUSTED_PROXY_IPS': PROXY})
        self.assertEqual(https.PROXY_IPS, frozenset({PROXY}))
        https.apply_env({'TRUSTED_PROXY_IPS': '%s, 127.0.0.1' % PROXY})
        self.assertEqual(https.PROXY_IPS, frozenset({PROXY, '127.0.0.1'}))
        for bad in ('172.18.0.0/24', '%s/32' % PROXY, 'nope', '%s, nope' % PROXY, '%s,' % PROXY, '::/0'):
            logs.clear()
            https.apply_env({'TRUSTED_PROXY_IPS': bad})
            self.assertEqual(https.PROXY_IPS, frozenset(), bad)
            self.assertTrue(any('trusting nobody' in line for line in logs), (bad, logs))

    def test_redirect_status_and_location_ignore_host(self):
        self.assertEqual(https.redirect_status('GET'), 301)
        self.assertEqual(https.redirect_status('HEAD'), 301)
        self.assertEqual(https.redirect_status('get'), 301)
        for method in ('POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'):
            self.assertEqual(https.redirect_status(method), 308, method)
        scope = {'path': '/some/path', 'raw_path': b'/some/path', 'query_string': b'x=1'}
        self.assertEqual(
            https.redirect_location(scope, HOST),
            'https://esp32lab.duckdns.org/some/path?x=1',
        )
        self.assertEqual(
            https.redirect_location({'path': '/some/path', 'raw_path': b'/some/path', 'query_string': b''}, HOST),
            'https://esp32lab.duckdns.org/some/path',
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
        https.apply_env({'HTTPS_ENABLED': '1', 'HTTPS_HOST': 'lab.example'})
        configured = {
            'type': 'http', 'scheme': 'http', 'method': 'GET', 'path': '/some/path',
            'raw_path': b'/some/path', 'query_string': b'x=1',
            'headers': [(b'host', b'lab.example')],
        }
        self.assertFalse(https.redirect_suppressed(configured))
        self.assertEqual(https.redirect_url(configured), 'https://lab.example/some/path?x=1')

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
        self.assertFalse(https.ENABLED)
        self.assertFalse(https.HSTS_ENABLED)
        self.assertEqual(https.HTTPS_HOST, '')
        self.assertIsNone(https.ALLOWED)
        self.assertEqual(https.PROXY_IPS, frozenset())
        https.apply_env({'ALLOWED_HOSTS': '129.158.200.25, %s' % HOST})
        self.assertEqual(https.ALLOWED, frozenset({IP_HOST, HOST}))
        self.assertEqual(https.normalize_host('129.158.200.25:80'), IP_HOST)
        self.assertEqual(https.normalize_host(HOST.upper()), HOST)

    def test_redirect_stays_off_without_a_valid_host(self):
        logs = []
        https.set_logger(lambda msg: logs.append(str(msg)))
        https.apply_env({'HTTPS_ENABLED': '1', 'HTTPS_HOST': 'https://evil.example/steal'})
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

    def test_empty_proxy_list_is_quiet(self):
        logs = []
        https.set_logger(lambda msg: logs.append(str(msg)))
        https.apply_env({})
        self.assertEqual(https.PROXY_IPS, frozenset())
        self.assertEqual(logs, [])

    def test_no_fetchable_http_urls(self):
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
        doc = (root.parents[0] / 'docs' / 'https.md').read_text()
        self.assertIn(PROXY, doc)
        self.assertIn('circuitlab-caddy', doc)
        self.assertNotIn('172.18.0.0/16', doc)
        self.assertNotIn('-p 443:8443', doc)
        self.assertNotIn('sslip', doc)

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

    def test_master_flag_off_matches_the_inner_response(self):
        https.apply_env({
            'HTTPS_ENABLED': '0',
            'HTTPS_REDIRECT': '1',
            'HTTPS_HOST': HOST,
            'HSTS_ENABLED': '1',
            'HSTS_SECONDS': '300',
            'ALLOWED_HOSTS': '127.0.0.1',
            'TRUSTED_PROXY_IPS': PROXY,
        })
        headers = [
            [b'content-type', b'text/plain'],
            [b'x-parity', b'same'],
            [b'strict-transport-security', b'max-age=9'],
        ]

        async def app(scope, receive, send):
            await send({
                'type': 'http.response.start', 'status': 204,
                'headers': [list(item) for item in headers],
            })
            await send({'type': 'http.response.body', 'body': b'plain-http'})

        scope = {
            'type': 'http', 'scheme': 'http', 'method': 'GET', 'path': '/some/path',
            'raw_path': b'/some/path', 'query_string': b'',
            'client': ('127.0.0.1', 9),
            'headers': [
                (b'host', b'evil.example'),
                (b'x-forwarded-proto', b'https'),
                (b'x-forwarded-for', b'172.30.0.250'),
            ],
        }

        async def run(target):
            sent = []

            async def receive():
                return {'type': 'http.request', 'body': b'', 'more_body': False}

            async def send(message):
                sent.append(message)

            await target(scope, receive, send)
            return sent

        direct = asyncio.run(run(app))
        wrapped = asyncio.run(run(https.HttpsMiddleware(app)))
        self.assertEqual(wrapped, direct)
        self.assertEqual(wrapped[0]['status'], 204)
        self.assertEqual(wrapped[0]['headers'], headers)

    def _scope(self, peer, proto='https', method='GET', path='/some/path', query=b'x=1', extra=None, kind='http'):
        headers = [(b'host', HOST.encode()), (b'x-forwarded-proto', proto.encode() if isinstance(proto, str) else proto)]
        if extra:
            headers.extend(extra)
        scheme = 'ws' if kind == 'websocket' else 'http'
        return {
            'type': kind, 'scheme': scheme, 'method': method, 'path': path,
            'raw_path': path.encode(), 'query_string': query,
            'headers': headers, 'client': (peer, 1234),
        }

    def _invoke(self, scope):
        seen = {}
        sent = []

        async def app(scope, receive, send):
            seen['scheme'] = scope.get('scheme')
            seen['host'] = https._host_header(scope)
            if scope.get('type') == 'websocket':
                await send({'type': 'websocket.close', 'code': 1000})
                return
            await send({'type': 'http.response.start', 'status': 204, 'headers': []})
            await send({'type': 'http.response.body', 'body': b''})

        async def receive():
            return {'type': 'http.request', 'body': b'', 'more_body': False}

        async def send(message):
            sent.append(message)

        asyncio.run(https.HttpsMiddleware(app)(scope, receive, send))
        return sent, seen

    def _location(self, sent):
        for key, value in sent[0].get('headers') or []:
            if bytes(key).lower() == b'location':
                return bytes(value)
        return None

    def test_forwarded_headers_from_anyone_but_the_pinned_proxy_are_ignored(self):
        https.apply_env({
            'HTTPS_ENABLED': '1', 'HTTPS_HOST': HOST, 'TRUSTED_PROXY_IPS': PROXY,
            'HSTS_ENABLED': '1', 'HSTS_SECONDS': '300',
        })
        target = b'https://%s/some/path?x=1' % HOST.encode()
        for peer in (NEIGHBOR, OLD_NET, '127.0.0.1'):
            sent, seen = self._invoke(self._scope(peer, extra=[(b'x-forwarded-for', PROXY.encode())]))
            self.assertEqual(sent[0]['status'], 301, peer)
            self.assertEqual(self._location(sent), target, peer)
            self.assertEqual(seen, {}, peer)
            sts = self._location(sent)
            self.assertNotIn(b'strict-transport-security', b' '.join(
                bytes(k) for k, _v in sent[0].get('headers') or []
            ))
            self.assertIsNotNone(sts)
        sent, seen = self._invoke(self._scope(PROXY, extra=[(b'x-forwarded-for', NEIGHBOR.encode())]))
        self.assertEqual(sent[0]['status'], 204)
        self.assertEqual(seen['scheme'], 'https')
        self.assertIsNone(self._location(sent))
        sent, seen = self._invoke(self._scope(PROXY, proto='http'))
        self.assertEqual(sent[0]['status'], 301)
        self.assertEqual(self._location(sent), target)
        self.assertEqual(seen, {})
        for proto in (b'https, http', b'https,https', b'', b'wss'):
            sent, seen = self._invoke(self._scope(PROXY, proto=proto))
            self.assertEqual(sent[0]['status'], 400, proto)
            self.assertEqual(seen, {}, proto)
        doubled = self._scope(PROXY)
        doubled['headers'].append((b'x-forwarded-proto', b'http'))
        sent, seen = self._invoke(doubled)
        self.assertEqual(sent[0]['status'], 400)
        self.assertEqual(seen, {})
        # The same garbage from a neighbor is not an error. It is ignored.
        sent, seen = self._invoke(self._scope(NEIGHBOR, proto=b'https, http'))
        self.assertEqual(sent[0]['status'], 301)
        self.assertEqual(self._location(sent), target)
        https.apply_env({
            'HTTPS_ENABLED': '1', 'HTTPS_HOST': HOST, 'TRUSTED_PROXY_IPS': PROXY,
            'ALLOWED_HOSTS': HOST,
        })
        sent, seen = self._invoke(self._scope(PROXY, extra=[(b'x-forwarded-host', HOST.encode())]))
        self.assertEqual(sent[0]['status'], 204)
        self.assertEqual(seen['host'], HOST)
        sent, seen = self._invoke(self._scope(PROXY, extra=[(b'x-forwarded-host', b'evil.example')]))
        self.assertEqual(sent[0]['status'], 400)
        self.assertEqual(seen, {})
        sent, seen = self._invoke(self._scope(NEIGHBOR, extra=[(b'x-forwarded-host', b'evil.example')]))
        self.assertEqual(sent[0]['status'], 301)
        self.assertEqual(self._location(sent), target)


class HttpsServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.environ['SIM_PREWARM'] = '0'
        os.environ['SIM_NETSTACK_WARM'] = '0'
        _on({'HTTPS_HOST': HOST, 'TRUSTED_PROXY_IPS': PROXY})
        cls.bg = https.Background(server.app).start()
        cls.http = cls.bg.http_port

    @classmethod
    def tearDownClass(cls):
        cls.bg.stop()
        _on({})
        staging.apply_env({})
        server.TOKEN = ''
        https.set_logger(https._default_log)

    def setUp(self):
        _on({'HTTPS_HOST': HOST, 'TRUSTED_PROXY_IPS': PROXY})
        staging.apply_env({'SIM_STAGING': '0', 'SIM_ACCESS_TOKEN': '', 'SIM_STAGING_UPSTREAM': '', 'SIM_BASE_PATH': ''})
        server.TOKEN = ''

    def test_proxy_headers_stay_off(self):
        self.assertIsNone(self.bg.tls)
        self.assertIsNone(self.bg.tls_port)
        self.assertFalse(self.bg.http.config.proxy_headers)
        self.assertEqual(self.bg.http.config.forwarded_allow_ips, '')
        text = Path(https.__file__).read_text()
        self.assertIn('proxy_headers=False, forwarded_allow_ips=\'\'', text)

    def test_redirect_matrix_for_ip_and_configured_host(self):
        _on({'HTTPS_HOST': HOST, 'TRUSTED_PROXY_IPS': PROXY})
        target = 'https://esp32lab.duckdns.org/some/path?x=1'
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
            'https://esp32lab.duckdns.org/some/path?x=1&y=a%20b',
        )
        root, pairs, page = request(self.http, 'GET', '/', host=IP_HOST)
        self.assertEqual(root, 200)
        self.assertIsNone(_header(pairs, 'location'))
        self.assertIn(b'clMigrate.handoff', page)
        self.assertIn(b'nonce=', page)
        self.assertNotIn(b'upgrade-insecure-requests', page)
        _assert_move_page(page, _header(pairs, 'content-security-policy'), 'https://%s' % HOST)
        self.assertEqual(_header(pairs, 'cache-control'), 'no-store')
        asset, pairs, _ = request(self.http, 'GET', '/js/app.js?v=90', host=IP_HOST)
        self.assertEqual(asset, 301)
        self.assertEqual(_header(pairs, 'location'), 'https://%s/js/app.js?v=90' % HOST)
        posted, pairs, _ = request(self.http, 'POST', '/', host=IP_HOST, body=b'a=1')
        self.assertEqual(posted, 308)
        self.assertEqual(_header(pairs, 'location'), 'https://%s/' % HOST)
        notices, _, notice = request(self.http, 'GET', '/notices.html', host=HOST)
        self.assertEqual(notices, 200)
        self.assertIn(b'clMigrate.handoff', notice)
        # Flag off: the same bookmark is not sent anywhere, and a spoofed proto is ignored.
        _on({'HTTPS_ENABLED': '0', 'HTTPS_HOST': HOST, 'TRUSTED_PROXY_IPS': PROXY})
        status, pairs, _ = request(self.http, 'GET', '/some/path?x=1', host=IP_HOST, headers={
            'X-Forwarded-Proto': 'https', 'X-Forwarded-For': PROXY,
        })
        self.assertNotIn(status, (301, 308))
        self.assertIsNone(_header(pairs, 'location'))

    def test_redirect_exempts_health_and_refuses_websocket(self):
        _on({'HTTPS_HOST': HOST, 'TRUSTED_PROXY_IPS': PROXY})
        status, pairs, body = request(self.http, 'GET', '/api/health', host=IP_HOST)
        self.assertEqual(status, 200)
        self.assertIsNone(_header(pairs, 'location'))
        self.assertNotIn(b'"tls"', body)
        self.assertIn(b'"ok"', body)
        status, pairs, _ = request(self.http, 'POST', '/api/health', host=HOST, body=b'{}')
        self.assertNotIn(status, (301, 308))
        self.assertIsNone(_header(pairs, 'location'))
        raw = ws_status(self.http, IP_HOST)
        self.assertTrue(raw.startswith(b'HTTP/1.1 403'), raw)
        self.assertIn(b'Use wss://', raw)

    def test_staging_path_keeps_its_path_and_is_unchanged_when_the_flag_is_off(self):
        staging.apply_env({'SIM_STAGING': '1', 'SIM_ACCESS_TOKEN': '', 'SIM_STAGING_UPSTREAM': '', 'SIM_BASE_PATH': ''})
        _on({'HTTPS_ENABLED': '0', 'HTTPS_HOST': HOST, 'TRUSTED_PROXY_IPS': PROXY})
        off, off_pairs, _ = request(self.http, 'GET', '/staging/foo?x=1', host=HOST, headers={
            'X-Forwarded-Proto': 'https', 'X-Forwarded-For': PROXY,
        })
        self.assertNotIn(off, (301, 308))
        self.assertIsNone(_header(off_pairs, 'location'))
        _on({'HTTPS_HOST': HOST, 'TRUSTED_PROXY_IPS': PROXY})
        status, pairs, _ = request(self.http, 'GET', '/staging/foo?x=1', host=HOST, headers={
            'X-Forwarded-Proto': 'https', 'X-Forwarded-For': PROXY,
        })
        self.assertEqual(status, 301)
        self.assertEqual(_header(pairs, 'location'), 'https://%s/staging/foo?x=1' % HOST)
        posted, pairs, _ = request(self.http, 'POST', '/staging/foo?x=1', host=HOST, body=b'a=1')
        self.assertEqual(posted, 308)
        self.assertEqual(_header(pairs, 'location'), 'https://%s/staging/foo?x=1' % HOST)
        _on({'HTTPS_HOST': HOST, 'TRUSTED_PROXY_IPS': '127.0.0.1'})
        stayed, stayed_pairs, _ = request(self.http, 'GET', '/staging/foo?x=1', host=HOST, headers={
            'X-Forwarded-Proto': 'https',
        })
        self.assertEqual(stayed, off)
        self.assertIsNone(_header(stayed_pairs, 'location'))

    def test_hsts_and_upgrade_insecure_requests_only_on_https(self):
        _on({
            'HSTS_ENABLED': '1', 'HSTS_SECONDS': '300', 'HTTPS_HOST': HOST,
            'TRUSTED_PROXY_IPS': '127.0.0.1',
        })
        status, pairs, _ = _via_caddy(self.http, 'GET', '/api/health')
        self.assertEqual(status, 200)
        self.assertEqual(_header(pairs, 'strict-transport-security'), 'max-age=300')
        self.assertNotIn('includeSubDomains', _header(pairs, 'strict-transport-security'))
        self.assertNotIn('preload', _header(pairs, 'strict-transport-security'))
        self.assertEqual(_header(pairs, 'content-security-policy'), 'upgrade-insecure-requests')
        status, pairs, _ = request(self.http, 'GET', '/api/health', host=IP_HOST)
        self.assertEqual(status, 200)
        self.assertIsNone(_header(pairs, 'strict-transport-security'))
        self.assertNotIn('upgrade-insecure-requests', _header(pairs, 'content-security-policy') or '')
        _on({'HSTS_SECONDS': '0', 'HTTPS_HOST': HOST, 'TRUSTED_PROXY_IPS': '127.0.0.1'})
        _, pairs, _ = _via_caddy(self.http, 'GET', '/api/health')
        self.assertIsNone(_header(pairs, 'strict-transport-security'))
        # An existing page CSP gains the directive on confirmed https and stays off on plain http.
        staging.apply_env({'SIM_ACCESS_TOKEN': 'tok', 'SIM_STAGING': '0', 'SIM_BASE_PATH': '/'})
        _, secure_pairs, _ = _via_caddy(self.http, 'GET', '/api/health')
        csp = _header(secure_pairs, 'content-security-policy')
        self.assertIn("default-src 'none'", csp)
        self.assertIn('upgrade-insecure-requests', csp)
        _, plain_pairs, _ = request(self.http, 'GET', '/api/health')
        plain = _header(plain_pairs, 'content-security-policy')
        self.assertIn("default-src 'none'", plain)
        self.assertNotIn('upgrade-insecure-requests', plain)
        # Loopback is not the documented proxy. Its proto header does not turn HSTS on.
        _on({'HSTS_ENABLED': '1', 'HSTS_SECONDS': '300', 'HTTPS_HOST': HOST, 'TRUSTED_PROXY_IPS': PROXY})
        _, spoofed, _ = request(self.http, 'GET', '/api/health', headers={'X-Forwarded-Proto': 'https'})
        self.assertIsNone(_header(spoofed, 'strict-transport-security'))

    def test_staging_cookie_is_always_secure_and_spoofed_proto_is_ignored(self):
        staging.apply_env({
            'SIM_STAGING': '1', 'SIM_ACCESS_TOKEN': 'stage-token',
            'SIM_STAGING_UPSTREAM': '', 'SIM_BASE_PATH': '/',
        })
        _on({'HTTPS_HOST': HOST, 'TRUSTED_PROXY_IPS': PROXY, 'HSTS_ENABLED': '1', 'HSTS_SECONDS': '300'})
        status, pairs, _ = request(self.http, 'GET', '/api/health?t=stage-token')
        self.assertEqual(status, 302)
        cookie = _header(pairs, 'set-cookie')
        low = cookie.lower()
        self.assertIn('cl_stage=', cookie)
        self.assertNotIn('stage-token', cookie)
        self.assertIn('secure', low)
        self.assertIn('httponly', low)
        self.assertIn('samesite=lax', low)
        # An untrusted peer cannot turn the request into https. Staging still
        # marks the cookie Secure, because that process is only reached over https.
        status, pairs, _ = request(self.http, 'GET', '/api/health?t=stage-token', headers={
            'X-Forwarded-Proto': 'http',
            'X-Forwarded-Host': 'evil.example',
            'X-Forwarded-For': PROXY,
        })
        self.assertEqual(status, 302)
        self.assertIn('secure', _header(pairs, 'set-cookie').lower())
        status, pairs, _ = request(self.http, 'GET', '/api/health?t=stage-token', headers={
            'X-Forwarded-Proto': 'https',
            'Forwarded': 'proto=https',
            'X-Forwarded-Host': 'evil.example',
            'X-Forwarded-For': PROXY,
        })
        self.assertEqual(status, 302)
        self.assertIn('secure', _header(pairs, 'set-cookie').lower())
        self.assertIsNone(_header(pairs, 'strict-transport-security'))
        self.assertNotIn('upgrade-insecure-requests', (_header(pairs, 'content-security-policy') or ''))
        status, pairs, _ = request(self.http, 'GET', '/some/path?x=1', headers={
            'X-Forwarded-Proto': 'https', 'X-Forwarded-For': PROXY, 'X-Forwarded-Host': 'evil.example',
        })
        self.assertEqual(status, 301)
        self.assertEqual(_header(pairs, 'location'), 'https://%s/some/path?x=1' % HOST)
        self.assertIsNone(_header(pairs, 'strict-transport-security'))
        staging.apply_env({
            'SIM_STAGING': '0', 'SIM_ACCESS_TOKEN': 'stage-token',
            'SIM_STAGING_UPSTREAM': '', 'SIM_BASE_PATH': '/',
        })
        status, pairs, _ = request(self.http, 'GET', '/api/health?t=stage-token', headers={
            'X-Forwarded-Proto': 'https', 'X-Forwarded-For': PROXY,
        })
        self.assertEqual(status, 302)
        self.assertNotIn('secure', _header(pairs, 'set-cookie').lower())
        _on({'HTTPS_HOST': HOST, 'TRUSTED_PROXY_IPS': '127.0.0.1'})
        status, pairs, _ = _via_caddy(self.http, 'GET', '/api/health?t=stage-token')
        self.assertEqual(status, 302)
        trusted = _header(pairs, 'set-cookie')
        self.assertIn('Secure', trusted)
        self.assertIn('HttpOnly', trusted)
        self.assertIn('samesite=lax', trusted.lower())

    def test_conditional_get_is_304_for_files_and_never_for_api(self):
        _on({'HTTPS_ENABLED': '0'})
        status, pairs, body = request(self.http, 'GET', '/js/storage.js')
        self.assertEqual(status, 200)
        self.assertTrue(body)
        etag = _header(pairs, 'etag')
        modified = _header(pairs, 'last-modified')
        self.assertTrue(etag)
        self.assertTrue(modified)
        code, _, empty = request(self.http, 'GET', '/js/storage.js', headers={'If-None-Match': etag})
        self.assertEqual(code, 304)
        self.assertEqual(empty, b'')
        code, _, empty = request(self.http, 'GET', '/js/storage.js', headers={'If-Modified-Since': modified})
        self.assertEqual(code, 304)
        self.assertEqual(empty, b'')
        code, again_pairs, again = request(self.http, 'GET', '/js/storage.js', headers={'If-None-Match': '"nope"'})
        self.assertEqual(code, 200)
        self.assertEqual(again, body)
        page, page_pairs, page_body = request(self.http, 'GET', '/')
        self.assertEqual(page, 200)
        page_etag = _header(page_pairs, 'etag')
        code, _, empty = request(self.http, 'GET', '/', headers={'If-None-Match': page_etag})
        self.assertEqual(code, 304)
        self.assertEqual(empty, b'')
        self.assertNotEqual(page_body, b'')
        health, _, health_body = request(self.http, 'GET', '/api/health', headers={
            'If-None-Match': '*', 'If-Modified-Since': modified,
        })
        self.assertEqual(health, 200)
        self.assertIn(b'"ok"', health_body)

    def test_websocket_resume_through_caddy_ignores_spoofed_forwarded_headers(self):
        link = server.Link('resume-sid')
        link.n = 2
        link.ring.append((2, 'status', '{"t":"status","msg":"replayed-marker","_n":2}'))
        server.SESSIONS['resume-sid'] = link
        try:
            _on({'HTTPS_HOST': HOST, 'TRUSTED_PROXY_IPS': '127.0.0.1'})

            async def resume():
                url = 'ws://127.0.0.1:%d/api/run/abc?sid=resume-sid&since=1' % self.http
                async with websockets.connect(
                    url, open_timeout=3, proxy=None,
                    additional_headers={
                        'X-Forwarded-Proto': 'https',
                        'X-Forwarded-For': '203.0.113.9',
                        'X-Forwarded-Host': 'evil.example',
                    },
                ) as ws:
                    return await asyncio.wait_for(ws.recv(), 3)

            text = asyncio.run(resume())
            self.assertIn('replayed-marker', text)
            self.assertEqual(link.resumes, 1)
            _on({'HTTPS_HOST': HOST, 'TRUSTED_PROXY_IPS': PROXY})

            async def spoofed():
                url = 'ws://127.0.0.1:%d/api/run/abc?sid=resume-sid&since=1' % self.http
                try:
                    async with websockets.connect(
                        url, open_timeout=3, proxy=None,
                        additional_headers={
                            'X-Forwarded-Proto': 'https',
                            'X-Forwarded-For': PROXY,
                            'X-Forwarded-Host': HOST,
                        },
                    ) as ws:
                        await ws.recv()
                    return 101
                except InvalidStatus as exc:
                    return exc.response.status_code

            self.assertEqual(asyncio.run(spoofed()), 403)
            self.assertEqual(link.resumes, 1)
        finally:
            server.SESSIONS.pop('resume-sid', None)

    def test_allowed_hosts_and_health_tls_fields(self):
        _on({
            'ALLOWED_HOSTS': '129.158.200.25, %s' % HOST,
            'HTTPS_HOST': HOST,
            'HSTS_SECONDS': '300',
            'TRUSTED_PROXY_IPS': PROXY,
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
        self.assertNotIn('tls', data)
        raw = ws_status(self.http, 'evil.example')
        self.assertTrue(raw.startswith(b'HTTP/1.1 400'), raw)
        self.assertIn(b'unknown host', raw)

    def test_wss_is_not_refused_when_redirect_is_on(self):
        _on({'HTTPS_HOST': HOST, 'TRUSTED_PROXY_IPS': PROXY})
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
        called.clear()
        sent.clear()
        asyncio.run(https.HttpsMiddleware(app)({
            'type': 'websocket', 'scheme': 'ws', 'path': '/api/run/x',
            'headers': [(b'host', HOST.encode()), (b'x-forwarded-proto', b'https')],
            'query_string': b'', 'client': (PROXY, 9),
        }, receive, send))
        self.assertEqual(called.get('scheme'), 'wss')
        called.clear()
        sent.clear()
        asyncio.run(https.HttpsMiddleware(app)({
            'type': 'websocket', 'scheme': 'ws', 'path': '/api/run/x',
            'headers': [(b'host', HOST.encode()), (b'x-forwarded-proto', b'https')],
            'query_string': b'', 'client': (NEIGHBOR, 9),
        }, receive, send))
        self.assertNotIn('scheme', called)
        self.assertTrue(any(item.get('type') == 'websocket.http.response.start' and item.get('status') == 403 for item in sent))

    def test_index_html_has_no_mixed_content_url(self):
        _on({'HTTPS_ENABLED': '0', 'HTTPS_HOST': HOST})
        status, _, body = request(self.http, 'GET', '/')
        self.assertEqual(status, 200)
        text = body.decode('utf-8')
        for match in re.finditer(r'http://[^\s\'"<>)]+', text):
            self.assertTrue(match.group(0).startswith(NS_HTTP), match.group(0))
        self.assertIn('http://www.w3.org/2000/svg', text)

    def test_a_trusted_https_request_is_not_redirected(self):
        _on({'HTTPS_HOST': HOST, 'TRUSTED_PROXY_IPS': '127.0.0.1'})
        status, pairs, _ = _via_caddy(self.http, 'GET', '/some/path?x=1', host=IP_HOST)
        self.assertNotIn(status, (301, 308))
        self.assertIsNone(_header(pairs, 'location'))
        _on({'HTTPS_HOST': HOST, 'TRUSTED_PROXY_IPS': PROXY})
        status, pairs, _ = request(self.http, 'GET', '/some/path?x=1', host=IP_HOST, headers={
            'X-Forwarded-Proto': 'https', 'X-Forwarded-For': PROXY,
        })
        self.assertEqual(status, 301)
        self.assertEqual(_header(pairs, 'location'), 'https://%s/some/path?x=1' % HOST)

    def test_head_matches_get_headers_and_has_no_body(self):
        _on({'HTTPS_ENABLED': '0'})
        get_status, get_pairs, get_body = request(self.http, 'GET', '/')
        head_status, head_pairs, head_body = request(self.http, 'HEAD', '/')
        self.assertEqual(get_status, 200)
        self.assertEqual(head_status, 200)
        self.assertEqual(head_body, b'')
        for name in ('content-type', 'etag', 'last-modified', 'content-length'):
            self.assertEqual(_header(head_pairs, name), _header(get_pairs, name), name)
        self.assertEqual(_header(head_pairs, 'content-length'), str(len(get_body)))
        page_get, page_pairs, page_body = request(self.http, 'GET', '/index.html')
        page_head, page_head_pairs, page_head_body = request(self.http, 'HEAD', '/index.html')
        self.assertEqual(page_get, 200)
        self.assertEqual(page_head, 200)
        self.assertEqual(page_head_body, b'')
        self.assertEqual(page_body, get_body)
        for name in ('content-type', 'etag', 'last-modified', 'content-length'):
            self.assertEqual(_header(page_head_pairs, name), _header(page_pairs, name), name)
        asset_get, asset_pairs, asset_body = request(self.http, 'GET', '/css/theme.css')
        asset_head, asset_head_pairs, asset_head_body = request(self.http, 'HEAD', '/css/theme.css')
        self.assertEqual(asset_get, 200)
        self.assertEqual(asset_head, 200)
        self.assertEqual(asset_head_body, b'')
        self.assertGreater(len(asset_body), 0)
        for name in ('content-type', 'etag', 'last-modified', 'content-length'):
            self.assertEqual(_header(asset_head_pairs, name), _header(asset_pairs, name), name)
        staging.apply_env({'SIM_STAGING': '1', 'SIM_ACCESS_TOKEN': '', 'SIM_STAGING_UPSTREAM': '', 'SIM_BASE_PATH': ''})
        staged_get, staged_pairs, staged_body = request(self.http, 'GET', '/')
        staged_head, staged_head_pairs, staged_head_body = request(self.http, 'HEAD', '/')
        self.assertEqual(staged_get, 200)
        self.assertEqual(staged_head, 200)
        self.assertIn(b'data-cl-env="staging"', staged_body)
        self.assertEqual(staged_head_body, b'')
        self.assertEqual(_header(staged_head_pairs, 'content-length'), str(len(staged_body)))
        for name in ('content-type', 'etag', 'last-modified', 'content-length'):
            self.assertEqual(_header(staged_head_pairs, name), _header(staged_pairs, name), name)

    def test_forged_host_is_not_a_redirect_target(self):
        _on({
            'ALLOWED_HOSTS': '%s,%s' % (IP_HOST, HOST),
            'HTTPS_HOST': HOST,
            'TRUSTED_PROXY_IPS': PROXY,
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
        _on({'HTTPS_HOST': HOST, 'TRUSTED_PROXY_IPS': '127.0.0.1'})
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
        status, _, body = _via_caddy(
            self.http, 'POST', '/migrate', host=HOST,
            headers={'Content-Type': 'application/x-www-form-urlencoded'},
            body=urllib_body(packed),
        )
        self.assertEqual(status, 200, body[:200])
        self.assertIn(b'clMigrate.receive', body)
        self.assertNotIn(b'Lamp </script>', body)
        self.assertIn(b'Lamp \\u003c/script>', body)
        digest = https.payload_checksum(record).encode()
        self.assertIn(digest, body)
        self.assertIn(b'"count":1', body)
        self.assertIsNone(_header(_, 'location'))
        for href in re.findall(br'href="([^"]*)"', body):
            self.assertNotIn(b'Lamp', href)
            self.assertNotIn(digest, href)
        bad = _via_caddy(
            self.http, 'POST', '/migrate', host=HOST,
            headers={'Content-Type': 'application/x-www-form-urlencoded'},
            body=urllib_body('0.' + _b64url(b'{"v":2}')),
        )
        self.assertEqual(bad[0], 400)
        self.assertEqual(_header(bad[1], 'cache-control'), 'no-store')
        self.assertIn(b'still safe at the original address', bad[2])
        self.assertNotIn(b'clMigrate.receive', bad[2])
        self.assertIn("default-src 'none'", _header(bad[1], 'content-security-policy'))

    def test_cancel_stays_and_the_receipt_is_not_a_url(self):
        _on({'HTTPS_HOST': HOST})
        status, pairs, body = request(self.http, 'GET', '/')
        self.assertEqual(status, 200, body[:200])
        self.assertIn(b'>Cancel<', body)
        self.assertIn(b'clstay=1', body)
        self.assertIn(b'#08090b', body)
        self.assertIn(b'#22d3ee', body)
        self.assertNotIn(b'/migrate#', body)
        self.assertNotIn(b'__clMove', body)
        csp = _header(pairs, 'content-security-policy')
        self.assertIn("style-src 'unsafe-inline'", csp)
        self.assertIn('frame-src https://%s' % HOST, csp)
        self.assertNotIn("script-src 'unsafe-inline'", csp)
        stayed = request(self.http, 'GET', '/?clstay=1')
        self.assertEqual(stayed[0], 200, stayed[2][:200])
        self.assertNotIn(b'clMigrate.handoff', stayed[2])
        self.assertIn(b'schematic.js', stayed[2])
        projects = {}
        for i in range(65):
            pid = 'p%d' % i
            projects[pid] = {
                'id': pid, 'name': 'N', 'updated': 1,
                'proj': {'id': pid, 'name': 'N', 'parts': [], 'wires': []},
            }
        packed = '0.' + _b64url(json.dumps({
            'v': 1, 'origin': 'http://127.0.0.1', 'exportedAt': 1, 'path': '/', 'query': '',
            'items': [{'k': 'esp32lab.projects.v1', 'v': json.dumps(projects)}],
        }).encode())
        _on({'HTTPS_HOST': HOST, 'TRUSTED_PROXY_IPS': '127.0.0.1'})
        too_many = _via_caddy(
            self.http, 'POST', '/migrate', host=HOST,
            headers={'Content-Type': 'application/x-www-form-urlencoded'},
            body=urllib_body(packed),
        )
        self.assertEqual(too_many[0], 400, too_many[2][:200])
        self.assertIn(b'still safe at the original address', too_many[2])
        self.assertNotIn(b'"p64"', too_many[2])
        raw = json.dumps({
            'v': 1, 'origin': 'http://127.0.0.1', 'exportedAt': 1, 'path': '/', 'query': '',
            'items': [{'k': 'esp32lab.projects.v1', 'v': json.dumps({
                'p1': {'id': 'p1', 'name': 'Desk', 'updated': 1, 'proj': {'id': 'p1', 'name': 'Desk', 'parts': [], 'wires': []}},
            })}],
        })
        posted = _via_caddy(
            self.http, 'POST', '/migrate', host=HOST,
            headers={'Content-Type': 'application/x-www-form-urlencoded'},
            body=urllib_body(raw),
        )
        self.assertEqual(posted[0], 200, posted[2][:240])
        obj = json.loads(raw)
        self.assertIn(https.payload_checksum(obj).encode(), posted[2])
        self.assertFalse(any('Desk' in value for _, value in posted[1]))
        self.assertIsNone(_header(posted[1], 'location'))

    def test_migrate_page_clears_the_fragment_first_and_locks_the_csp(self):
        _on({'HTTPS_HOST': HOST, 'TRUSTED_PROXY_IPS': '127.0.0.1'})
        status, pairs, body = _via_caddy(self.http, 'GET', '/migrate', host=HOST)
        self.assertEqual(status, 200, body[:180])
        self.assertIn(b'clMigrate.receive', body)
        _assert_move_page(body, _header(pairs, 'content-security-policy'), "'none'")
        self.assertEqual(_header(pairs, 'cache-control'), 'no-store')
        self.assertEqual(_header(pairs, 'referrer-policy'), 'no-referrer')
        self.assertNotIn(b'upgrade-insecure-requests', body)
        self.assertNotIn(b'upgrade-insecure-requests', _header(pairs, 'content-security-policy').encode())

    def test_post_cap_content_type_and_no_body_in_logs(self):
        import logging
        _on({'HTTPS_HOST': HOST, 'TRUSTED_PROXY_IPS': '127.0.0.1'})
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
            over = _via_caddy(
                self.http, 'POST', '/migrate', host=HOST,
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

            missing = _via_caddy(
                self.http, 'POST', '/migrate', host=HOST,
                body=('payload=' + marker).encode(),
            )
            self.assertEqual(missing[0], 415)
            self.assertEqual(_header(missing[1], 'cache-control'), 'no-store')
            self.assertIn(b'unsupported media type', missing[2])
            self.assertNotIn(marker.encode(), missing[2])

            for media in ('text/plain', 'application/json', 'application/x-www-form-urlencoded; charset=utf-8'):
                sent = _via_caddy(
                    self.http, 'POST', '/migrate', host=HOST,
                    headers={'Content-Type': media},
                    body=('payload=' + marker).encode(),
                )
                if media.startswith('application/x-www-form-urlencoded'):
                    self.assertEqual(sent[0], 400, media)
                    self.assertIn(b'still safe at the original address', sent[2])
                else:
                    self.assertEqual(sent[0], 415, media)
                    self.assertIn(b'unsupported media type', sent[2])
                self.assertEqual(_header(sent[1], 'cache-control'), 'no-store', media)
                self.assertNotIn(marker.encode(), sent[2])

            malformed = _via_caddy(
                self.http, 'POST', '/migrate', host=HOST,
                headers={'Content-Type': 'application/x-www-form-urlencoded'},
                body=urllib_body('0.' + _b64url(('{"v":2,"note":"%s"}' % marker).encode())),
            )
            self.assertEqual(malformed[0], 400)
            self.assertEqual(_header(malformed[1], 'cache-control'), 'no-store')
            self.assertIn(b'still safe at the original address', malformed[2])
            self.assertNotIn(marker.encode(), malformed[2])
            self.assertNotIn(b'clMigrate.receive', malformed[2])

            original = https.unpack_payload
            def boom(_text):
                raise RuntimeError('TRACE-MARKER-991')
            https.unpack_payload = boom
            try:
                traced = _via_caddy(
                    self.http, 'POST', '/migrate', host=HOST,
                    headers={'Content-Type': 'application/x-www-form-urlencoded'},
                    body=urllib_body('0.' + _b64url(b'{"v":1}')),
                )
            finally:
                https.unpack_payload = original
            self.assertEqual(traced[0], 400)
            self.assertNotIn(b'TRACE-MARKER-991', traced[2])
            self.assertNotIn(b'clMigrate.receive', traced[2])

            chunked = _chunked_post(self.http, HOST, marker.encode() * 64, https.MIGRATE_CAP + 1)
            self.assertEqual(chunked[0], 413, chunked[2][:200])
            self.assertEqual(_header(chunked[1], 'cache-control'), 'no-store')
            self.assertIn(b'request too large', chunked[2])
            self.assertNotIn(marker.encode(), chunked[2])
            self.assertLess(len(chunked[2]), 4000)
        finally:
            for lg in loggers:
                lg.removeHandler(handler)
            https.set_logger(https._default_log)
        joined = '\n'.join(logs + grabbed)
        self.assertNotIn(marker, joined)
        self.assertNotIn('TRACE-MARKER-991', joined)

    def test_hsts_header_is_absent_by_default(self):
        _on({
            'HTTPS_HOST': HOST, 'HSTS_ENABLED': '0', 'HSTS_SECONDS': '31536000',
            'TRUSTED_PROXY_IPS': '127.0.0.1',
        })
        _, pairs, _ = _via_caddy(self.http, 'GET', '/api/health')
        self.assertIsNone(_header(pairs, 'strict-transport-security'))
        _on({'HTTPS_HOST': HOST, 'TRUSTED_PROXY_IPS': '127.0.0.1'})
        _, pairs, _ = _via_caddy(self.http, 'GET', '/api/health')
        self.assertIsNone(_header(pairs, 'strict-transport-security'))
        self.assertNotIn('strict-transport-security', ' '.join(name for name, _value in pairs))


