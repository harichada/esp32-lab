"""Staging flags and the /staging/ pass-through. Flags default off."""
import asyncio, http.client, inspect, json, os, shutil, sys, tempfile, threading, unittest, urllib.request
from contextlib import contextmanager
from pathlib import Path

os.environ['SIM_PREWARM'] = '0'
os.environ['SIM_NETSTACK_WARM'] = '0'
os.environ['SIM_STAGING'] = '0'
os.environ['SIM_ACCESS_TOKEN'] = ''
os.environ['SIM_STAGING_UPSTREAM'] = ''
os.environ['SIM_BASE_PATH'] = ''
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import diskkeep
import server
import staging
import uvicorn
import websockets
from websockets.exceptions import ConnectionClosed, InvalidStatus

TOKEN = 'test123'
PRIVATE = 'This is a private test copy of Circuit Lab.'
DOWN = "The test copy isn't running right now."


class _NoRedirect(urllib.request.HTTPErrorProcessor):
    def http_response(self, request, response):
        return response
    https_response = http_response


def _http_app(record):
    async def handle(reader, writer):
        try:
            data = b''
            while b'\r\n\r\n' not in data:
                chunk = await reader.read(4096)
                if not chunk:
                    break
                data += chunk
            head, _, rest = data.partition(b'\r\n\r\n')
            lines = head.split(b'\r\n')
            method, target, _ = lines[0].decode('latin1').split(' ', 2)
            headers = {}
            names = []
            for line in lines[1:]:
                if b':' in line:
                    k, v = line.split(b':', 1)
                    name = k.decode('latin1').lower()
                    names.append(name)
                    headers[name] = v.decode('latin1').strip()
            n = int(headers.get('content-length') or '0')
            body = rest
            while len(body) < n:
                chunk = await reader.read(n - len(body))
                if not chunk:
                    break
                body += chunk
            record.append({'method': method, 'target': target, 'headers': headers, 'names': names, 'body': body})
            if target.startswith('/hang'):
                await asyncio.sleep(30)
                return
            payload = b'upstream-ok'
            writer.write(
                b'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: %d\r\n'
                b'X-Upstream: yes\r\nConnection: close\r\n\r\n' % len(payload) + payload)
            await writer.drain()
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass
    return handle


class StagingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http_log = []
        cls.ws_log = []
        cls.loop = asyncio.new_event_loop()
        cls.loop_thread = threading.Thread(target=cls.loop.run_forever, daemon=True)
        cls.loop_thread.start()

        async def start_http():
            return await asyncio.start_server(_http_app(cls.http_log), '127.0.0.1', 0)

        cls.http_server = asyncio.run_coroutine_threadsafe(start_http(), cls.loop).result(5)
        cls.http_port = cls.http_server.sockets[0].getsockname()[1]

        async def ws_handler(ws):
            path = ws.request.path
            headers = {k.lower(): v for k, v in ws.request.headers.items()}
            cls.ws_log.append({'path': path, 'headers': headers})
            if path.endswith('/bye'):
                await ws.send('bye')
                await ws.close(4002)
                return
            async for message in ws:
                await ws.send(message)

        async def start_ws():
            return await websockets.serve(ws_handler, '127.0.0.1', 0, compression=None)

        cls.ws_server = asyncio.run_coroutine_threadsafe(start_ws(), cls.loop).result(5)
        cls.ws_port = cls.ws_server.sockets[0].getsockname()[1]

        sock = __import__('socket').socket()
        sock.bind(('127.0.0.1', 0))
        cls.dead_port = sock.getsockname()[1]
        sock.close()

        config = uvicorn.Config(
            server.app, host='127.0.0.1', port=0, log_level='error', access_log=False,
            proxy_headers=False, forwarded_allow_ips='',
        )
        cls.uvicorn = uvicorn.Server(config)
        cls.uvicorn.install_signal_handlers = lambda: None
        cls.serve_thread = threading.Thread(target=cls.uvicorn.run, daemon=True)
        cls.serve_thread.start()
        for _ in range(100):
            if cls.uvicorn.started:
                break
            __import__('time').sleep(0.05)
        cls.port = cls.uvicorn.servers[0].sockets[0].getsockname()[1]
        cls.base = 'http://127.0.0.1:%d' % cls.port
        cls.opener = urllib.request.build_opener(_NoRedirect)

    @classmethod
    def tearDownClass(cls):
        cls.uvicorn.should_exit = True
        cls.serve_thread.join(3)
        cls.loop.call_soon_threadsafe(cls.loop.stop)

    def setUp(self):
        self.logs = []
        staging.PROXY_TIMEOUT = 30.0
        staging.set_logger(lambda msg: self.logs.append(str(msg)))
        self._env(staging='0', token='', upstream='', base='')
        self.http_log.clear()
        self.ws_log.clear()

    def _env(self, staging='0', token='', upstream='', base=''):
        staging_mod = sys.modules['staging']
        staging_mod.apply_env({
            'SIM_STAGING': staging,
            'SIM_ACCESS_TOKEN': token,
            'SIM_STAGING_UPSTREAM': upstream,
            'SIM_BASE_PATH': base,
        })

    def fetch(self, path, headers=None, data=None, method=None, timeout=5):
        req = urllib.request.Request(self.base + path, data=data, headers=headers or {}, method=method)
        with self.opener.open(req, timeout=timeout) as resp:
            return resp.status, resp.headers, resp.read()

    def raw(self, path):
        """Send the path bytes unchanged. urllib would not be asked to resolve dot-segments."""
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        conn.request('GET', path)
        resp = conn.getresponse()
        body = resp.read()
        status = resp.status
        conn.close()
        return status, body

    def exchange(self, method, path, header_pairs, body=None, timeout=5):
        """One request. Repeated header names stay as separate lines."""
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=timeout)
        conn.putrequest(method, path)
        for name, value in header_pairs:
            conn.putheader(name, value)
        if body is not None:
            conn.putheader('Content-Type', 'application/json')
            conn.putheader('Content-Length', str(len(body)))
        conn.endheaders(body)
        resp = conn.getresponse()
        data = resp.read()
        status = resp.status
        conn.close()
        return status, data

    def ask(self, method, path, header_pairs, body=None, timeout=5):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=timeout)
        conn.putrequest(method, path)
        for name, value in header_pairs:
            conn.putheader(name, value)
        if body is not None:
            conn.putheader('Content-Type', 'application/json')
            conn.putheader('Content-Length', str(len(body)))
        conn.endheaders(body)
        resp = conn.getresponse()
        data = b'' if method == 'HEAD' else resp.read()
        status = resp.status
        headers = {k.lower(): v for k, v in resp.getheaders()}
        conn.close()
        return status, headers, data

    def chunked(self, path, payload, extra_headers=(), timeout=10):
        """POST a chunked body. Content-Length is sent only when a test asks for the lie."""
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=timeout)
        conn.putrequest('POST', path)
        conn.putheader('Transfer-Encoding', 'chunked')
        for name, value in extra_headers:
            conn.putheader(name, value)
        conn.endheaders()
        view = payload
        step = 8192
        i = 0
        try:
            while i < len(view):
                part = view[i:i + step]
                conn.send(b'%x\r\n' % len(part) + part + b'\r\n')
                i += step
            conn.send(b'0\r\n\r\n')
        except (ConnectionResetError, BrokenPipeError):
            pass
        resp = conn.getresponse()
        data = resp.read()
        status = resp.status
        conn.close()
        return status, data

    def _assert_static(self, body, *parts):
        text = body.decode()
        low = text.lower()
        self.assertIn('<html lang="en">', text)
        self.assertRegex(text, r'<title>[^<]+</title>')
        self.assertNotIn('<script', low)
        self.assertIn('<link rel="icon" href="data:,">', text)
        self.assertEqual(low.count('<link'), 1)
        self.assertNotIn('stylesheet', low)
        self.assertNotIn('@import', low)
        self.assertNotIn('@font-face', low)
        self.assertNotIn(' src=', low)
        self.assertNotIn('<img', low)
        self.assertIn("font-family:system-ui,-apple-system,'segoe ui',sans-serif", low)
        self.assertIn('background:#08090b', low)
        self.assertIn('text-align:center', low)
        self.assertIn('a:focus', low)
        self.assertIn('href="/"', text)
        for part in parts:
            self.assertIn(part, text)

    def _assert_private(self, body):
        self._assert_static(
            body, PRIVATE,
            'Looking for Circuit Lab? <a href="/">Go to the main site</a>.',
        )

    def _assert_down(self, body):
        self._assert_static(
            body, DOWN,
            'Try again in a few minutes, or <a href="/">use the main site</a>.',
        )

    def test_flags_off_do_not_change_headers(self):
        status, headers, body = self.fetch('/api/health')
        self.assertEqual(status, 200)
        self.assertNotIn('x-robots-tag', {k.lower() for k in headers.keys()})
        self.assertNotIn('set-cookie', {k.lower() for k in headers.keys()})
        self.assertNotIn(b'"staging"', body)
        page, ph, raw = self.fetch('/')
        self.assertEqual(page, 200)
        self.assertEqual(raw, (Path(__file__).resolve().parents[1] / 'index.html').read_bytes())
        self.assertNotIn('x-robots-tag', {k.lower() for k in ph.keys()})
        asset, ah, _ = self.fetch('/js/storage.js')
        self.assertEqual(asset, 200)
        self.assertNotIn('x-robots-tag', {k.lower() for k in ah.keys()})
        self.assertIn(server.MAX_BODY, (200 * 1024,))
        self.assertEqual(staging.MAX_BODY, server.MAX_BODY)
        self.assertEqual(staging.PROXY_TIMEOUT, 30.0)

    def test_noindex_only_when_staging(self):
        self._env(staging='1')
        status, headers, body = self.fetch('/api/health')
        self.assertEqual(status, 200)
        self.assertEqual(headers['X-Robots-Tag'], 'noindex, nofollow')
        self.assertIn(b'"staging":true', body.replace(b' ', b''))
        _, sh, _ = self.fetch('/js/storage.js')
        self.assertEqual(sh['X-Robots-Tag'], 'noindex, nofollow')
        code, rh, robots = self.fetch('/robots.txt')
        self.assertEqual(code, 200)
        self.assertEqual(robots.decode(), staging.ROBOTS)
        self.assertEqual(rh['X-Robots-Tag'], 'noindex, nofollow')
        self.assertEqual(staging.ROBOTS.strip(), 'User-agent: *\nDisallow: /')
        _, ih, html = self.fetch('/')
        self.assertIn(b'<meta name="cl-env" content="staging">', html)
        self.assertIn(b'data-cl-env="staging"', html)
        self.assertIn(b'href="/"', html)
        self.assertIn(b'Test version: projects here may be deleted. <a href="/">Use the main site</a> for real work.', html)
        self.assertEqual(ih['X-Robots-Tag'], 'noindex, nofollow')
        self._env(staging='0')
        _, off, _ = self.fetch('/api/health')
        self.assertNotIn('x-robots-tag', {k.lower() for k in off.keys()})

    def test_upstream_off_is_404_and_bad_values_are_rejected(self):
        for path in ('/staging', '/staging/', '/staging/api/health'):
            code, _, _ = self.fetch(path)
            self.assertEqual(code, 404, path)
        rejected = [
            'https://127.0.0.1:8766', 'http://localhost:8766', 'http://[::1]:8766',
            'http://127.0.0.1.evil.com:8766', 'http://user@127.0.0.1:8766',
            'http://127.0.0.1:8766/extra', 'http://127.0.0.1:8766?x=1',
            'http://127.0.0.1:8766/', 'http://127.0.0.1', 'http://127.0.0.1:',
            'http://127.0.0.2:8766', 'http://evil.example:8766',
            'ws://127.0.0.1:8766', 'http://0.0.0.0:8766', 'http://127.0.0.1:65536',
            'http://127.0.0.1:0', 'http://127.0.0.1:08766',
        ]
        for value in rejected:
            self.assertIsNone(staging.parse_upstream(value), value)
            self.assertTrue(any('SIM_STAGING_UPSTREAM must be http://127.0.0.1:<port>' in line for line in self.logs))
            self.logs.clear()
        self.assertIsNone(staging.parse_upstream(''))
        self.assertIsNone(staging.parse_upstream(None))
        self.assertEqual(staging.parse_upstream('http://127.0.0.1:8766'), 8766)
        self.assertFalse(any('SIM_STAGING_UPSTREAM must be' in line for line in self.logs))
        self._env(upstream='http://localhost:9')
        code, _, _ = self.fetch('/staging/api/health')
        self.assertEqual(code, 404)
        self.assertIsNone(staging.upstream_port())

    def test_prefix_stripped_and_forwarded_headers(self):
        self._env(upstream='http://127.0.0.1:%d' % self.http_port)
        code, headers, body = self.fetch('/staging/api/health?x=1', headers={
            'X-Lab-Test': 'kept', 'X-Forwarded-For': '1.2.3.4', 'X-Real-IP': '8.8.8.8',
            'Forwarded': 'for=9.9.9.9;proto=https', 'Cookie': 'cl_stage=abc',
        })
        self.assertEqual(code, 200)
        self.assertEqual(body, b'upstream-ok')
        self.assertEqual(headers['X-Upstream'], 'yes')
        self.assertEqual(len(self.http_log), 1)
        seen = self.http_log[0]
        self.assertEqual(seen['method'], 'GET')
        self.assertEqual(seen['target'], '/api/health?x=1')
        self._assert_peer_ip_only(seen, ('1.2.3.4', '8.8.8.8', '9.9.9.9'))
        self.assertEqual(seen['headers'].get('x-lab-test'), 'kept')
        self.assertEqual(seen['headers'].get('cookie'), 'cl_stage=abc')
        self.assertTrue(seen['headers'].get('host', '').startswith('127.0.0.1:'))
        self.assertTrue(any(line.startswith('staging_proxy status=200 ms=') for line in self.logs))
        self.assertFalse(any('?' in line or '1.2.3.4' in line or '8.8.8.8' in line or '9.9.9.9' in line or 'abc' in line for line in self.logs))
        slash, slh, _ = self.fetch('/staging?z=1')
        self.assertEqual(slash, 302)
        self.assertTrue(slh['Location'].endswith('/staging/?z=1') or slh['Location'] == '/staging/?z=1')

    def test_body_limit_reuses_live_constant(self):
        self._env(upstream='http://127.0.0.1:%d' % self.http_port)
        big = b'x' * (server.MAX_BODY + 1)
        code, _, body = self.fetch('/staging/api/compile', data=big, method='POST')
        self.assertEqual(code, 413)
        self.assertIn(b'request too large', body)
        self.assertEqual(self.http_log, [])
        code, _, body = self.fetch('/staging/api/projects/abc', data=big, method='PUT')
        self.assertEqual(code, 413)
        self.assertIn(b'request too large', body)
        self.assertEqual(self.http_log, [])

    def test_upstream_down_and_timeout(self):
        self._env(upstream='http://127.0.0.1:%d' % self.dead_port)
        code, _, body = self.fetch('/staging/')
        self.assertEqual(code, 502)
        self._assert_down(body)
        self.assertNotIn(b'Traceback', body)
        self.assertTrue(any(line.startswith('staging_proxy status=502 ms=') for line in self.logs))
        self.logs.clear()
        self._env(upstream='http://127.0.0.1:%d' % self.http_port)
        staging.PROXY_TIMEOUT = 0.4
        code, _, body = self.fetch('/staging/hang', timeout=5)
        self.assertEqual(code, 504)
        self._assert_down(body)
        self.assertNotIn(b'Traceback', body)
        self.assertTrue(any(line.startswith('staging_proxy status=504 ms=') for line in self.logs))

    def test_access_token_gate(self):
        self._env(staging='1', token=TOKEN)
        code, _, body = self.fetch('/api/health')
        self.assertEqual(code, 401)
        self._assert_private(body)
        self.assertTrue(any(line == 'stage_auth=denied' for line in self.logs))
        self.assertFalse(any(TOKEN in line for line in self.logs))
        self.logs.clear()
        code, _, body = self.fetch('/?t=wrong')
        self.assertEqual(code, 401)
        self._assert_private(body)
        code, headers, _ = self.fetch('/?t=%s&ex=blink' % TOKEN)
        self.assertEqual(code, 302)
        self.assertEqual(headers['Location'], '/staging/?ex=blink')
        self.assertNotIn(TOKEN, headers['Location'])
        cookie = headers['Set-Cookie']
        self.assertIn('cl_stage=', cookie)
        self.assertNotIn(TOKEN, cookie)
        low = cookie.lower()
        self.assertIn('httponly', low)
        self.assertIn('samesite=strict', low)
        self.assertIn('path=/staging/', low)
        self.assertNotIn('domain=', low)
        self.assertTrue(any(line == 'stage_auth=ok' for line in self.logs))
        self.assertFalse(any(TOKEN in line for line in self.logs))
        pair = cookie.split(';', 1)[0]
        ok, oh, health = self.fetch('/api/health', headers={'Cookie': pair})
        self.assertEqual(ok, 200)
        self.assertEqual(oh['X-Robots-Tag'], 'noindex, nofollow')
        self.assertIn(b'"staging":true', health.replace(b' ', b''))
        self._env(staging='0', token=TOKEN, base='')
        code, headers, _ = self.fetch('/?t=%s' % TOKEN)
        self.assertEqual(code, 302)
        self.assertEqual(headers['Location'], '/')
        off_cookie = headers['Set-Cookie'].lower()
        self.assertRegex(off_cookie, r'path=/(;|$)')
        self.assertNotIn('path=/staging', off_cookie)
        self.assertNotIn('domain=', off_cookie)

    def test_websocket_requires_cookie_and_proxy_echoes(self):
        self._env(token=TOKEN)
        async def denied():
            try:
                async with websockets.connect('ws://127.0.0.1:%d/api/run/abc' % self.port, open_timeout=3, proxy=None) as ws:
                    await ws.recv()
                return 101
            except InvalidStatus as exc:
                return exc.response.status_code
        self.assertEqual(asyncio.run(denied()), 401)

        self._env(upstream='http://127.0.0.1:%d' % self.ws_port)
        async def echo():
            url = 'ws://127.0.0.1:%d/staging/api/run/abc' % self.port
            async with websockets.connect(
                url, open_timeout=3, proxy=None,
                additional_headers={
                    'X-Forwarded-For': '9.9.9.9', 'X-Real-IP': '203.0.113.8',
                    'Forwarded': 'for=198.51.100.4', 'Cookie': 'cl_stage=abc',
                },
            ) as ws:
                await ws.send('hi')
                text = await ws.recv()
                await ws.send(b'\x00\x01')
                binary = await ws.recv()
                return text, binary
        text, binary = asyncio.run(echo())
        self.assertEqual(text, 'hi')
        self.assertEqual(binary, b'\x00\x01')
        self.assertEqual(self.ws_log[-1]['path'], '/api/run/abc')
        ws_headers = self.ws_log[-1]['headers']
        self.assertEqual(ws_headers.get('x-forwarded-for'), '127.0.0.1')
        self.assertNotIn('x-real-ip', ws_headers)
        self.assertNotIn('x-forwarded-host', ws_headers)
        self.assertNotIn('x-forwarded-proto', ws_headers)
        self.assertNotIn('x-client-ip', ws_headers)
        self.assertNotIn('forwarded', ws_headers)
        self.assertNotIn('9.9.9.9', ws_headers.get('x-forwarded-for', ''))
        self.assertIn('cl_stage=abc', self.ws_log[-1]['headers'].get('cookie', ''))

        async def bye():
            url = 'ws://127.0.0.1:%d/staging/api/run/bye' % self.port
            async with websockets.connect(url, open_timeout=3, proxy=None) as ws:
                self.assertEqual(await ws.recv(), 'bye')
                try:
                    await ws.recv()
                except ConnectionClosed as exc:
                    rcvd = getattr(exc, 'rcvd', None)
                    return getattr(rcvd, 'code', None)
            return None
        self.assertEqual(asyncio.run(bye()), 4002)
        joined = '\n'.join(self.logs)
        self.assertNotIn('9.9.9.9', joined)
        self.assertNotIn('203.0.113.8', joined)
        self.assertNotIn('198.51.100.4', joined)
        self.assertNotIn('?', joined)

    def test_pages_escape_and_link_home(self):
        self.assertEqual(staging._esc('<b>&'), '&lt;b&gt;&amp;')
        self.assertIn("isn't", staging.DOWN_HTML)
        self._assert_private(staging.PRIVATE_HTML.encode())
        self._assert_down(staging.DOWN_HTML.encode())
        readme = (Path(__file__).resolve().parents[1] / 'README.md').read_text()
        start = readme.index('docker run -d --name esp32lab-staging')
        block = readme[start:readme.index('esp32-lab', start)]
        self.assertIn('--cpus 0.5', block)
        self.assertIn('-p 127.0.0.1:8766:8765', block)
        self.assertIn('-e SIM_ACCESS_TOKEN', block)
        self.assertNotIn('SIM_ACCESS_TOKEN=', block)
        self.assertIn('SIM_COMPILE_QUEUE_MAX=0', block)
        self.assertIn('SIM_MAX_RUNS=1', block)
        self.assertIn('esp32lab-staging:/data/staging-projects', block)
        self.assertNotIn('--network', block)
        self.assertIn('backup-v64', readme)
        self.assertIn('unset `SIM_STAGING_UPSTREAM`', readme)

    def test_dot_segments_never_reach_live_or_upstream(self):
        self._env(upstream='http://127.0.0.1:%d' % self.http_port)
        _, _, live = self.fetch('/api/health')
        self.assertIn(b'"ok"', live)
        for path in (
            '/staging/../', '/staging/%2e%2e/', '/staging%2f..', '/staging/..%2fapi/projects',
            '/staging/../api/health', '/staging/./api', '/staging/%2e/',
        ):
            before = len(self.http_log)
            status, body = self.raw(path)
            self.assertEqual(status, 404, path)
            self.assertEqual(body, b'not found')
            self.assertNotEqual(body, live)
            self.assertEqual(len(self.http_log), before, path)
        code, _, body = self.fetch('/staging/api/health')
        self.assertEqual(code, 200)
        self.assertEqual(body, b'upstream-ok')
        self.assertEqual(len(self.http_log), 1)

    def test_missing_or_wrong_token_does_not_call_upstream(self):
        self._env(staging='1', token=TOKEN, upstream='http://127.0.0.1:%d' % self.http_port)
        for path in ('/staging/api/health', '/staging/api/projects', '/staging/?t=wrong', '/staging/api/health?t=nope'):
            code, _, body = self.fetch(path)
            self.assertEqual(code, 401, path)
            self._assert_private(body)
            self.assertNotIn(TOKEN.encode(), body)
            self.assertEqual(self.http_log, [], path)
        self.assertTrue(any(line == 'stage_auth=denied' for line in self.logs))
        self.assertFalse(any(TOKEN in line for line in self.logs))
        src = inspect.getsource(staging.token_eq)
        self.assertIn('hmac.compare_digest', src)
        self.assertNotIn('==', src)
        self.assertTrue(staging.token_eq(TOKEN, TOKEN))
        self.assertFalse(staging.token_eq('test124', TOKEN))
        self.assertFalse(staging.token_eq('nope', TOKEN))

    def test_forwarded_headers_do_not_change_identity_or_rate_limit(self):
        from starlette.requests import Request

        def make(cid, xff, fwd, client):
            headers = [
                (b'x-forwarded-for', xff.encode()),
                (b'x-real-ip', b'192.0.2.9'),
                (b'forwarded', fwd.encode()),
            ]
            if cid is not None:
                headers.insert(0, (b'x-client-id', cid.encode()))
            scope = {
                'type': 'http', 'asgi': {'version': '3.0'}, 'http_version': '1.1',
                'method': 'POST', 'scheme': 'http', 'path': '/api/compile',
                'raw_path': b'/api/compile', 'query_string': b'', 'headers': headers,
                'client': client, 'server': ('127.0.0.1', 80),
            }
            return Request(scope)

        spoofed = make('tab-a', '203.0.113.9', 'for=198.51.100.4;proto=https;host=evil.example', ('203.0.113.9', 443))
        other_ip = make('tab-a', '198.51.100.8', 'for=203.0.113.9', ('198.51.100.8', 9))
        other_tab = make('tab-b', '203.0.113.9', 'for=198.51.100.4;proto=https;host=evil.example', ('203.0.113.9', 443))
        no_id = make(None, '203.0.113.9', 'for=198.51.100.4', ('203.0.113.9', 443))
        self.assertEqual(server._client_id_from(spoofed), 'tab-a')
        self.assertEqual(server._client_id_from(other_ip), 'tab-a')
        self.assertEqual(server._client_id_from(other_tab), 'tab-b')
        self.assertEqual(server._client_id_from(no_id), '')
        ident = inspect.getsource(server._client_id_from).lower()
        self.assertNotIn('x-forwarded-for', ident)
        self.assertNotIn('x-real-ip', ident)
        self.assertNotIn('forwarded', ident)
        self.assertNotIn('request.client', ident)

        async def rate():
            q = server.CompileQueue()
            token = await q.enter(server._client_id_from(spoofed))
            self.assertIsInstance(token, dict)
            denied = await q.enter(server._client_id_from(other_ip))
            self.assertEqual(denied.status_code, 429)
            self.assertEqual(json.loads(denied.body)['reason'], 'rate')
            await q.leave(token)

        asyncio.run(rate())

    def test_upstream_request_drops_every_forwarded_client_header(self):
        items = [
            ('X-Forwarded-For', '203.0.113.1'),
            ('x-forwarded-for', '203.0.113.2'),
            ('X-Real-IP', '198.51.100.3'),
            ('x-real-ip', '198.51.100.4'),
            ('Forwarded', 'for=203.0.113.5'),
            ('FORWARDED', 'for=198.51.100.6'),
            ('X-Forwarded-Host', 'evil.example'),
            ('x-forwarded-proto', 'https'),
            ('X-Client-IP', '203.0.113.7'),
            ('X-Lab-Test', 'kept'),
            ('Host', 'evil.example'),
        ]
        names = [name.lower() for name, _value in staging._drop_hop(items)]
        for banned in ('x-forwarded-for', 'x-real-ip', 'x-forwarded-host', 'x-forwarded-proto', 'x-client-ip', 'forwarded', 'host'):
            self.assertNotIn(banned, names)
        self.assertEqual(names.count('x-lab-test'), 1)

        self._env(upstream='http://127.0.0.1:%d' % self.http_port)
        status, body = self.exchange('GET', '/staging/api/health', [
            ('X-Forwarded-For', '203.0.113.1'),
            ('x-forwarded-for', '203.0.113.2'),
            ('X-Real-IP', '198.51.100.3'),
            ('x-real-ip', '198.51.100.4'),
            ('Forwarded', 'for=203.0.113.5'),
            ('forwarded', 'for=198.51.100.6'),
            ('X-Forwarded-Host', 'evil.example'),
            ('X-Forwarded-Proto', 'https'),
            ('X-Client-IP', '203.0.113.7'),
            ('X-Lab-Test', 'kept'),
        ])
        self.assertEqual(status, 200)
        self.assertEqual(body, b'upstream-ok')
        seen = self.http_log[0]
        self._assert_peer_ip_only(seen, (
            '203.0.113.1', '203.0.113.2', '198.51.100.3', '198.51.100.4',
            '203.0.113.5', '198.51.100.6', 'evil.example', '203.0.113.7',
        ))
        self.assertEqual(seen['names'].count('x-lab-test'), 1)
        self.assertEqual(seen['headers'].get('x-lab-test'), 'kept')
        joined = '\n'.join(self.logs)
        for ip in ('203.0.113.1', '203.0.113.2', '198.51.100.3', '198.51.100.4', '203.0.113.5', '198.51.100.6'):
            self.assertNotIn(ip, joined)

    def test_server_never_trusts_forwarded_headers(self):
        self.assertFalse(self.uvicorn.config.proxy_headers)
        self.assertEqual(self.uvicorn.config.forwarded_allow_ips, '')
        src = Path(server.__file__).read_text()
        self.assertIn(
            "uvicorn.run(app, host=a.host, port=a.port, log_level='warning', proxy_headers=False, forwarded_allow_ips='')",
            src,
        )
        seen = {}
        orig = server._client_id_from

        def wrapped(request):
            seen['host'] = None if request.client is None else request.client.host
            return orig(request)

        server._client_id_from = wrapped
        try:
            code, _, _ = self.fetch('/api/compile/progress', headers={
                'X-Forwarded-For': '203.0.113.50',
                'X-Real-IP': '203.0.113.51',
                'Forwarded': 'for=198.51.100.20',
            })
        finally:
            server._client_id_from = orig
        self.assertEqual(code, 200)
        self.assertEqual(seen['host'], '127.0.0.1')

    def test_rotating_forwarded_for_through_staging_still_429(self):
        """A new X-Forwarded-For on each /staging/ compile does not open another rate-limit bucket."""
        @contextmanager
        def scratch():
            path = Path(tempfile.mkdtemp(prefix='esp32xff-'))
            try:
                yield path
            finally:
                shutil.rmtree(path, ignore_errors=True)

        started = threading.Event()
        release = threading.Event()
        inner = []
        result = {}
        saved_env = os.environ.get('SIM_COMPILE_QUEUE')
        saved = (
            server._compile_in, server._client_id_from,
            diskkeep.prepare_for_compile, diskkeep.forget_sketch_builds_since, diskkeep.request_build_dir,
        )
        os.environ['SIM_COMPILE_QUEUE'] = '1'
        diskkeep.prepare_for_compile = lambda **_k: None
        diskkeep.forget_sketch_builds_since = lambda *_a, **_k: None
        diskkeep.request_build_dir = scratch

        async def fake(*_args, **_kwargs):
            started.set()
            while not release.is_set():
                await asyncio.sleep(0.01)
            return {'ok': True, 'id': 'xff', 'log': 'ok'}

        def wrapped(request):
            inner.append({
                'host': None if request.client is None else request.client.host,
                'pairs': [(key.decode('latin1').lower(), value.decode('latin1')) for key, value in request.headers.raw],
            })
            return saved[1](request)

        server._compile_in = fake
        server._client_id_from = wrapped
        self._env(upstream='http://127.0.0.1:%d' % self.port)
        worker = None
        try:
            body_a = json.dumps({'sketch': 'void setup(){} void loop(){} // xff-a'}).encode()
            body_b = json.dumps({'sketch': 'void setup(){} void loop(){} // xff-b'}).encode()
            headers_a = [
                ('X-Client-Id', 'tab-xff'),
                ('X-Forwarded-For', '203.0.113.10'),
                ('X-Real-IP', '203.0.113.11'),
                ('Forwarded', 'for=203.0.113.12'),
                ('X-Forwarded-Host', 'spoof-a.example'),
                ('X-Forwarded-Proto', 'https'),
                ('X-Client-IP', '203.0.113.13'),
            ]
            headers_b = [
                ('X-Client-Id', 'tab-xff'),
                ('X-Forwarded-For', '198.51.100.20'),
                ('x-forwarded-for', '192.0.2.30'),
                ('X-Real-IP', '198.51.100.21'),
                ('x-real-ip', '192.0.2.31'),
                ('Forwarded', 'for=198.51.100.22'),
                ('forwarded', 'for=192.0.2.32'),
                ('X-Forwarded-Host', 'spoof-b.example'),
                ('x-forwarded-proto', 'http'),
                ('X-Client-IP', '198.51.100.23'),
            ]

            def first():
                try:
                    result['pair'] = self.exchange('POST', '/staging/api/compile', headers_a, body_a, timeout=15)
                except Exception as exc:
                    result['error'] = exc

            worker = threading.Thread(target=first)
            worker.start()
            self.assertTrue(started.wait(5), result)
            status, data = self.exchange('POST', '/staging/api/compile', headers_b, body_b, timeout=5)
            self.assertEqual(status, 429)
            self.assertEqual(json.loads(data)['reason'], 'rate')
            status_c, data_c = self.exchange('POST', '/staging/api/compile', [
                ('X-Client-Id', 'tab-xff'),
                ('X-Forwarded-For', '192.0.2.40'),
                ('X-Client-IP', '192.0.2.41'),
            ], json.dumps({'sketch': 'void setup(){} void loop(){} // xff-c'}).encode(), timeout=5)
            self.assertEqual(status_c, 429)
            self.assertEqual(json.loads(data_c)['reason'], 'rate')
            self.assertGreaterEqual(len(inner), 2)
            spoofed = (
                '203.0.113.10', '198.51.100.20', '192.0.2.30', '192.0.2.40',
                '203.0.113.11', '198.51.100.22', 'spoof-a.example', 'spoof-b.example',
            )
            for hit in inner:
                self.assertEqual(hit['host'], '127.0.0.1')
                names = [name for name, _value in hit['pairs']]
                values = ' '.join(value for _name, value in hit['pairs'])
                for banned in ('forwarded', 'x-real-ip', 'x-forwarded-host', 'x-forwarded-proto', 'x-client-ip'):
                    self.assertNotIn(banned, names)
                self.assertEqual([value for name, value in hit['pairs'] if name == 'x-forwarded-for'], ['127.0.0.1'])
                for ip in spoofed:
                    self.assertNotIn(ip, values)
            joined = '\n'.join(self.logs)
            for ip in spoofed:
                self.assertNotIn(ip, joined)
        finally:
            release.set()
            if worker is not None:
                worker.join(5)
            server._compile_in, server._client_id_from = saved[0], saved[1]
            diskkeep.prepare_for_compile = saved[2]
            diskkeep.forget_sketch_builds_since = saved[3]
            diskkeep.request_build_dir = saved[4]
            if saved_env is None:
                os.environ.pop('SIM_COMPILE_QUEUE', None)
            else:
                os.environ['SIM_COMPILE_QUEUE'] = saved_env
        self.assertNotIn('error', result)
        self.assertEqual(result['pair'][0], 200)

    def _assert_upstream_untouched(self, before, path):
        status, body = self.raw(path)
        self.assertEqual(status, 404, path)
        self.assertEqual(body, b'not found')
        self.assertEqual(len(self.http_log), before, path)
        joined = '\n'.join(self.logs)
        self.assertIn('reason=bad_path', joined)
        self.assertNotIn(path, joined)

    def test_backslash_paths_do_not_reach_upstream(self):
        self._env(upstream='http://127.0.0.1:%d' % self.http_port)
        for path in (
            '/staging/%5c../',
            '/staging/..%5c',
            '/staging/%5c%2e%2e%2f',
            '/staging/%5c../api/health',
            '/staging/api/%00health',
            '/staging/api/%0ahealth',
            '/staging/api/%7fhealth',
        ):
            self.logs.clear()
            self._assert_upstream_untouched(len(self.http_log), path)
        status, body = self.exchange('GET', '/staging/api/h%65alth', [])
        self.assertEqual(status, 200)
        self.assertEqual(body, b'upstream-ok')
        self.assertEqual(self.http_log[-1]['target'].split('?', 1)[0], '/api/health')

    def test_mixed_case_backslash_encodings_are_404(self):
        self._env(upstream='http://127.0.0.1:%d' % self.http_port)
        for path in (
            '/staging/%5C../',
            '/staging/..%5C',
            '/staging/%5C%2E%2E%2F',
            '/staging/%5C../api/health',
            '/staging/%5c%2E%2e%2f',
        ):
            self.logs.clear()
            self._assert_upstream_untouched(len(self.http_log), path)

    def test_double_encoded_dot_and_backslash_are_404(self):
        self._env(upstream='http://127.0.0.1:%d' % self.http_port)
        for path in (
            '/staging/%255c../',
            '/staging/%255C../',
            '/staging/%252e%252e/',
            '/staging/%252E%252E/',
            '/staging/%252e%252e/api/health',
            '/staging/%25255c../',
        ):
            self.logs.clear()
            self._assert_upstream_untouched(len(self.http_log), path)
        self.assertTrue(staging.climbs_out('/staging/%252e%252e/', b'/staging/%252e%252e/'))
        self.assertTrue(staging.climbs_out('/staging/%5c../', b'/staging/%25255c../'))
        self.assertFalse(staging.climbs_out('/staging/api/health', b'/staging/api/health'))
        self.assertEqual(staging._DECODE_CAP, 2)

    def test_head_and_options_require_auth_and_forward_the_method(self):
        self._env(staging='1', token=TOKEN, upstream='http://127.0.0.1:%d' % self.http_port)
        for method in ('HEAD', 'OPTIONS'):
            status, headers, body = self.ask(method, '/staging/api/health', [
                ('X-Trace', 'zz-header-head'),
            ])
            self.assertEqual(status, 401, method)
            self.assertEqual(headers.get('cache-control'), 'no-store')
            self.assertEqual(headers.get('content-security-policy'), "default-src 'none'; style-src 'unsafe-inline'")
            self.assertIn('text/html', headers.get('content-type', ''))
            if method != 'HEAD':
                self._assert_private(body)
                self.assertNotIn(b'/staging/api/health', body)
                self.assertNotIn(b'zz-header-head', body)
            self.assertEqual(self.http_log, [], method)
        cookie = 'cl_stage=' + staging.cookie_value(TOKEN)
        for method in ('HEAD', 'OPTIONS'):
            status, body = self.exchange(method, '/staging/api/health', [('Cookie', cookie)])
            self.assertEqual(status, 200, method)
            self.assertEqual(self.http_log[-1]['method'], method)
            self.assertEqual(self.http_log[-1]['target'].split('?', 1)[0], '/api/health')

    def test_chunked_body_over_limit_is_never_forwarded(self):
        self._env(upstream='http://127.0.0.1:%d' % self.http_port)
        small_status, small_body = self.chunked('/staging/api/compile', b'hello-chunk')
        self.assertEqual(small_status, 200)
        self.assertEqual(small_body, b'upstream-ok')
        self.assertEqual(self.http_log[-1]['method'], 'POST')
        self.assertEqual(self.http_log[-1]['body'], b'hello-chunk')
        self.http_log.clear()
        too_big = b'x' * (server.MAX_BODY + 1)
        status, body = self.chunked('/staging/api/compile', too_big, extra_headers=(('X-Trace', 'zz-chunk'),))
        self.assertEqual(status, 413, body)
        self.assertIn(b'request too large', body)
        self.assertNotIn(b'zz-chunk', body)
        self.assertEqual(self.http_log, [])

        class _Fake:
            headers = {'content-length': '1'}

            async def stream(self):
                yield b'y' * (server.MAX_BODY + 1)

        async def limited():
            return await staging._read_limited(_Fake())

        payload, err = asyncio.run(limited())
        self.assertIsNone(payload)
        self.assertEqual(err.status_code, 413)

    def test_staging_websocket_refuses_before_upstream_connect(self):
        self._env(staging='1', token=TOKEN, upstream='http://127.0.0.1:%d' % self.ws_port)
        before = len(self.ws_log)
        opened = []
        real = websockets.connect

        def guard(url, *args, **kwargs):
            opened.append(str(url))
            if ':%d' % self.ws_port in str(url):
                raise AssertionError('upstream websocket opened')
            return real(url, *args, **kwargs)

        websockets.connect = guard
        try:
            async def denied():
                try:
                    async with websockets.connect(
                        'ws://127.0.0.1:%d/staging/api/run/abc' % self.port,
                        open_timeout=3, proxy=None,
                        additional_headers={'X-Trace': 'zz-ws-header'},
                    ) as ws:
                        await ws.recv()
                    return 101, b''
                except InvalidStatus as exc:
                    body = getattr(exc.response, 'body', b'') or b''
                    return exc.response.status_code, body
            status, body = asyncio.run(denied())
        finally:
            websockets.connect = real
        self.assertEqual(status, 401)
        self.assertEqual(len(self.ws_log), before)
        self.assertFalse(any(':%d' % self.ws_port in item for item in opened))
        if body:
            self.assertNotIn(b'/staging/api/run/abc', body)
            self.assertNotIn(b'zz-ws-header', body)
            self.assertNotIn(('%d' % self.ws_port).encode(), body)

    def _assert_peer_ip_only(self, seen, spoofed):
        """The capture upstream got the connection peer, not any inbound client-IP header."""
        for name in ('x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'x-client-ip', 'forwarded'):
            self.assertNotIn(name, seen['names'])
            self.assertNotIn(name, seen['headers'])
        self.assertEqual(seen['names'].count('x-forwarded-for'), 1)
        self.assertEqual(seen['headers'].get('x-forwarded-for'), '127.0.0.1')
        blob = ' '.join(seen['headers'].values())
        for value in spoofed:
            self.assertNotIn(value, blob)

    def test_capture_upstream_drops_spoofed_client_headers(self):
        self._env(upstream='http://127.0.0.1:%d' % self.http_port)
        status, body = self.exchange('GET', '/staging/api/health', [
            ('X-Forwarded-For', '203.0.113.50'),
            ('Forwarded', 'for=203.0.113.51;proto=https'),
            ('X-Real-IP', '203.0.113.52'),
            ('X-Forwarded-Host', 'spoof.example'),
            ('X-Forwarded-Proto', 'https'),
            ('X-Client-IP', '203.0.113.53'),
        ])
        self.assertEqual(status, 200)
        self.assertEqual(body, b'upstream-ok')
        self.assertEqual(len(self.http_log), 1)
        self._assert_peer_ip_only(self.http_log[0], (
            '203.0.113.50', '203.0.113.51', '203.0.113.52', '203.0.113.53', 'spoof.example',
        ))

    def test_mixed_case_and_duplicate_client_headers_are_stripped(self):
        self._env(upstream='http://127.0.0.1:%d' % self.http_port)
        status, body = self.exchange('GET', '/staging/api/health', [
            ('X-Forwarded-For', '203.0.113.60'),
            ('x-forwarded-for', '203.0.113.61'),
            ('X-FORWARDED-HOST', 'AAA.example'),
            ('x-forwarded-host', 'bbb.example'),
            ('X-Forwarded-Proto', 'https'),
            ('x-forwarded-proto', 'http'),
            ('X-Real-IP', '198.51.100.62'),
            ('x-real-ip', '198.51.100.63'),
            ('X-Client-IP', '192.0.2.64'),
            ('x-client-ip', '192.0.2.65'),
            ('Forwarded', 'for=203.0.113.66'),
            ('FORWARDED', 'for=198.51.100.67'),
        ])
        self.assertEqual(status, 200)
        self.assertEqual(body, b'upstream-ok')
        self._assert_peer_ip_only(self.http_log[0], (
            '203.0.113.60', '203.0.113.61', 'AAA.example', 'bbb.example',
            '198.51.100.62', '198.51.100.63', '192.0.2.64', '192.0.2.65',
            '203.0.113.66', '198.51.100.67',
        ))

    def test_error_pages_hide_the_request_and_set_guard_headers(self):
        for page in (staging.PRIVATE_HTML, staging.DOWN_HTML):
            self.assertIn('body{min-height:100vh;box-sizing:border-box;margin:0', page)
            self.assertIn('display:flex', page)
            self.assertIn('white-space:nowrap', page)
            self.assertIn('padding:4px 6px', page)
            self.assertIn('min-height:30px', page)
            self.assertIn('a:focus-visible{', page)
            self.assertIn('a:hover{', page)
        self.assertEqual(staging.PAGE_CSP, "default-src 'none'; style-src 'unsafe-inline'")
        marker = 'zz-secret-path-9f3'
        header = 'zz-header-9f3'
        upstream = '127.0.0.1:%d' % self.http_port
        self._env(staging='1', token=TOKEN, upstream='http://127.0.0.1:%d' % self.http_port)
        status, headers, body = self.fetch(
            '/staging/%s?t=nope' % marker, headers={'X-Trace': header},
        )
        self.assertEqual(status, 401)
        self._assert_guard_page(headers, body, '/staging/%s' % marker, header, upstream)
        self._assert_private(body)

        self._env(upstream='http://127.0.0.1:%d' % self.dead_port)
        down_host = '127.0.0.1:%d' % self.dead_port
        status, headers, body = self.fetch(
            '/staging/%s' % marker, headers={'X-Trace': header},
        )
        self.assertEqual(status, 502)
        self._assert_guard_page(headers, body, '/staging/%s' % marker, header, down_host)
        self._assert_down(body)

        self._env(upstream='http://127.0.0.1:%d' % self.http_port)
        staging.PROXY_TIMEOUT = 0.4
        status, headers, body = self.fetch('/staging/hang', headers={'X-Trace': header}, timeout=5)
        self.assertEqual(status, 504)
        self._assert_guard_page(headers, body, '/staging/hang', header, upstream)
        self._assert_down(body)
        self.assertGreaterEqual(_contrast('e6e8eb', '08090b'), 4.5)
        self.assertGreaterEqual(_contrast('fff4d4', '4a2f00'), 4.5)
        self.assertGreaterEqual(_contrast('4a2f00', 'fff4d4'), 4.5)
        self.assertGreaterEqual(_contrast('fff4d4', '241500'), 4.5)

    def _assert_guard_page(self, headers, body, path, header, upstream):
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertEqual(headers['Content-Security-Policy'], "default-src 'none'; style-src 'unsafe-inline'")
        self.assertNotIn(path.encode(), body)
        self.assertNotIn(header.encode(), body)
        self.assertNotIn(upstream.encode(), body)
        self.assertNotIn(b'http://', body)
        self.assertNotIn(b'https://', body)


def _contrast(fg, bg):
    def lin(hex_color):
        n = int(hex_color, 16)
        parts = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]

        def f(u):
            return u / 12.92 if u <= 0.04045 else ((u + 0.055) / 1.055) ** 2.4

        r, g, b = [f(u) for u in parts]
        return 0.2126 * r + 0.7152 * g + 0.0722 * b

    lighter, darker = lin(fg), lin(bg)
    if darker > lighter:
        lighter, darker = darker, lighter
    return (lighter + 0.05) / (darker + 0.05)


if __name__ == '__main__':
    unittest.main()
