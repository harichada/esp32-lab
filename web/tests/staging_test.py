"""Staging flags and the /staging/ pass-through. Flags default off."""
import asyncio, os, sys, threading, unittest, urllib.request
from pathlib import Path

os.environ['SIM_PREWARM'] = '0'
os.environ['SIM_NETSTACK_WARM'] = '0'
os.environ['SIM_STAGING'] = '0'
os.environ['SIM_ACCESS_TOKEN'] = ''
os.environ['SIM_STAGING_UPSTREAM'] = ''
os.environ['SIM_BASE_PATH'] = ''
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
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
            for line in lines[1:]:
                if b':' in line:
                    k, v = line.split(b':', 1)
                    headers[k.decode('latin1').lower()] = v.decode('latin1').strip()
            n = int(headers.get('content-length') or '0')
            body = rest
            while len(body) < n:
                chunk = await reader.read(n - len(body))
                if not chunk:
                    break
                body += chunk
            record.append({'method': method, 'target': target, 'headers': headers, 'body': body})
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

        config = uvicorn.Config(server.app, host='127.0.0.1', port=0, log_level='error', access_log=False)
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
        self.assertEqual(ih['X-Robots-Tag'], 'noindex, nofollow')
        self._env(staging='0')
        _, off, _ = self.fetch('/api/health')
        self.assertNotIn('x-robots-tag', {k.lower() for k in off.keys()})

    def test_upstream_off_is_404_and_bad_values_are_rejected(self):
        for path in ('/staging', '/staging/', '/staging/api/health'):
            code, _, _ = self.fetch(path)
            self.assertEqual(code, 404, path)
        rejected = [
            'https://127.0.0.1:8766', 'http://localhost:8766', 'http://127.0.0.2:8766',
            'http://evil.example:8766', 'http://127.0.0.1:8766/extra', 'http://127.0.0.1',
            'ws://127.0.0.1:8766', 'http://0.0.0.0:8766', 'http://127.0.0.1:65536',
            'http://127.0.0.1:08766',
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
        code, headers, body = self.fetch('/staging/api/health?x=1', headers={'X-Lab-Test': 'kept', 'X-Forwarded-For': '1.2.3.4', 'Cookie': 'cl_stage=abc'})
        self.assertEqual(code, 200)
        self.assertEqual(body, b'upstream-ok')
        self.assertEqual(headers['X-Upstream'], 'yes')
        self.assertEqual(len(self.http_log), 1)
        seen = self.http_log[0]
        self.assertEqual(seen['method'], 'GET')
        self.assertEqual(seen['target'], '/api/health?x=1')
        self.assertNotIn('x-forwarded-for', seen['headers'])
        self.assertEqual(seen['headers'].get('x-lab-test'), 'kept')
        self.assertEqual(seen['headers'].get('cookie'), 'cl_stage=abc')
        self.assertTrue(seen['headers'].get('host', '').startswith('127.0.0.1:'))
        self.assertTrue(any(line.startswith('staging_proxy status=200 ms=') for line in self.logs))
        self.assertFalse(any('?' in line or '1.2.3.4' in line or 'abc' in line for line in self.logs))
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
        self.assertIn(DOWN.encode(), body)
        self.assertNotIn(b'Traceback', body)
        self.assertTrue(any(line.startswith('staging_proxy status=502 ms=') for line in self.logs))
        self.logs.clear()
        self._env(upstream='http://127.0.0.1:%d' % self.http_port)
        staging.PROXY_TIMEOUT = 0.4
        code, _, body = self.fetch('/staging/hang', timeout=5)
        self.assertEqual(code, 504)
        self.assertIn(DOWN.encode(), body)
        self.assertNotIn(b'Traceback', body)
        self.assertTrue(any(line.startswith('staging_proxy status=504 ms=') for line in self.logs))

    def test_access_token_gate(self):
        self._env(staging='1', token=TOKEN)
        code, _, body = self.fetch('/api/health')
        self.assertEqual(code, 401)
        self.assertIn(PRIVATE.encode(), body)
        self.assertTrue(any(line == 'stage_auth=denied' for line in self.logs))
        self.assertFalse(any(TOKEN in line for line in self.logs))
        self.logs.clear()
        code, _, body = self.fetch('/?t=wrong')
        self.assertEqual(code, 401)
        self.assertIn(PRIVATE.encode(), body)
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
                additional_headers={'X-Forwarded-For': '9.9.9.9', 'Cookie': 'cl_stage=abc'},
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
        self.assertNotIn('x-forwarded-for', self.ws_log[-1]['headers'])
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
        self.assertNotIn('?', joined)


if __name__ == '__main__':
    unittest.main()
