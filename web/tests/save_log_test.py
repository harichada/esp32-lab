"""One stdout line per project save. The body, secrets, and headers stay out of it.

    python3 -m unittest tests/save_log_test.py
"""
import asyncio, io, json, os, re, socket, subprocess, sys, tempfile, time, unittest, urllib.request
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import server
from starlette.requests import Request

CANARY = 'CANARY9f3c1a7eSECRET'
HOST = '198.51.100.23'
LINE = re.compile(
    r'^(?P<ts>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) project_save '
    r'id=(?P<id>[A-Za-z0-9_?-]{0,64}) ip=(?P<ip>\S*) status=(?P<status>\d{3}) op=(?P<op>create|update)$'
)


def _request(pid, body, headers=None, host=HOST):
    raw = body if isinstance(body, bytes) else json.dumps(body).encode()
    sent = False

    async def receive():
        nonlocal sent
        if sent:
            return {'type': 'http.disconnect'}
        sent = True
        return {'type': 'http.request', 'body': raw, 'more_body': False}

    scope = {
        'type': 'http', 'asgi': {'version': '3.0'}, 'http_version': '1.1', 'method': 'PUT',
        'scheme': 'http', 'path': '/api/projects/' + str(pid), 'raw_path': b'/api/projects/',
        'query_string': b'', 'headers': list(headers or []),
        'client': (host, 4242), 'server': ('127.0.0.1', 80),
    }
    return Request(scope, receive)


class SaveLogTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self._dir = server.PROJ_DIR
        self._max = server.PROJ_MAX
        server.PROJ_DIR = Path(self.tmp.name)

    def tearDown(self):
        server.PROJ_DIR = self._dir
        server.PROJ_MAX = self._max
        self.tmp.cleanup()

    def _put(self, pid, body, headers=None, host=HOST):
        buf = io.StringIO()
        with redirect_stdout(buf):
            resp = asyncio.run(server.proj_put(pid, _request(pid, body, headers, host)))
        text = buf.getvalue()
        status = 200 if isinstance(resp, dict) else resp.status_code
        return status, text.splitlines(), text, resp

    def _line(self, text_lines):
        self.assertEqual(len(text_lines), 1, text_lines)
        match = LINE.match(text_lines[0])
        self.assertIsNotNone(match, text_lines[0])
        return match.groupdict()

    def test_create_and_update_each_emit_one_line(self):
        body = {'name': 'blink', 'parts': []}
        status, lines, _, resp = self._put('proj-1', body)
        self.assertEqual(status, 200)
        self.assertEqual(resp, {'ok': True, 'id': 'proj-1'})
        got = self._line(lines)
        self.assertEqual(got['id'], 'proj-1')
        self.assertEqual(got['ip'], HOST)
        self.assertEqual(got['status'], '200')
        self.assertEqual(got['op'], 'create')
        self.assertTrue((server.PROJ_DIR / 'proj-1.json').is_file())

        status, lines, _, resp = self._put('proj-1', {'name': 'blink-2', 'parts': [{'id': 'R1'}]})
        self.assertEqual(status, 200)
        self.assertEqual(resp, {'ok': True, 'id': 'proj-1'})
        got = self._line(lines)
        self.assertEqual(got['id'], 'proj-1')
        self.assertEqual(got['ip'], HOST)
        self.assertEqual(got['status'], '200')
        self.assertEqual(got['op'], 'update')

    def test_failing_save_logs_4xx(self):
        status, lines, text, resp = self._put('bad/id', {'parts': [], 'secret': CANARY})
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(resp.body.decode())['error'], 'bad id')
        got = self._line(lines)
        self.assertEqual(got['id'], 'bad?id')
        self.assertEqual(got['ip'], HOST)
        self.assertEqual(got['status'], '400')
        self.assertEqual(got['op'], 'create')
        self.assertNotIn(CANARY, text)

        huge = b'{"secret":"' + CANARY.encode() + b'","parts":[]}' + (b'x' * (server.MAX_BODY + 1))
        status, lines, text, resp = self._put('proj-1', huge)
        self.assertEqual(status, 413)
        self.assertEqual(json.loads(resp.body.decode())['error'], 'too large')
        got = self._line(lines)
        self.assertEqual(got['id'], 'proj-1')
        self.assertEqual(got['status'], '413')
        self.assertEqual(got['op'], 'create')
        self.assertNotIn(CANARY, text)
        self.assertFalse((server.PROJ_DIR / 'proj-1.json').exists())

        self._put('proj-1', {'parts': []})
        status, lines, text, _ = self._put('proj-1', huge)
        self.assertEqual(status, 413)
        got = self._line(lines)
        self.assertEqual(got['status'], '413')
        self.assertEqual(got['op'], 'update')
        self.assertNotIn(CANARY, text)

    def test_body_secrets_and_headers_never_appear(self):
        headers = [
            (b'x-canary-header', CANARY.encode()),
            (b'x-edit-secret', CANARY.encode()),
            (b'authorization', b'Bearer ' + CANARY.encode()),
            (b'cookie', b'simtok=' + CANARY.encode()),
            (b'x-forwarded-for', b'203.0.113.50'),
            (b'x-real-ip', b'203.0.113.51'),
            (b'forwarded', b'for=203.0.113.52'),
        ]
        body = {
            'name': CANARY,
            'parts': [{'id': 'R1', 'secret': CANARY}],
            'wires': [CANARY],
            'secret': CANARY,
            'token': CANARY,
            'edit_key': CANARY,
            'editKey': CANARY,
            'circuit': CANARY,
            'code': 'void setup(){/*' + CANARY + '*/}',
            'sketch': CANARY,
        }
        status, lines, text, _ = self._put('kept-1', body, headers=headers)
        self.assertEqual(status, 200)
        got = self._line(lines)
        self.assertEqual(got['id'], 'kept-1')
        self.assertEqual(got['ip'], HOST)
        self.assertEqual(got['status'], '200')
        self.assertEqual(got['op'], 'create')
        stored = (server.PROJ_DIR / 'kept-1.json').read_text()
        self.assertIn(CANARY, stored)
        for hidden in (CANARY, 'x-canary-header', 'x-edit-secret', 'authorization', 'Bearer',
                       'simtok', '203.0.113.50', '203.0.113.51', '203.0.113.52', 'forwarded'):
            self.assertNotIn(hidden, text)

    def test_id_controls_cannot_forge_a_second_line(self):
        pid = 'ab\nEVIL\r\x00\x1b\t\u2028\u2029 status=200 op=update\nFORGED'
        status, lines, text, _ = self._put(pid, {'parts': [], 'secret': CANARY})
        self.assertEqual(status, 400)
        self.assertEqual(text.count('\n'), 1)
        got = self._line(lines)
        self.assertEqual(got['id'], 'ab?EVIL???????status?200?op?update?FORGED')
        self.assertEqual(got['status'], '400')
        self.assertEqual(got['op'], 'create')
        self.assertEqual(got['ip'], HOST)
        self.assertNotIn('status=200', text)
        self.assertNotIn(CANARY, text)
        self.assertNotIn('\n', lines[0])

        long_id = ('C' * 64) + '\nFORGED-LINE status=200 op=update'
        status, lines, text, _ = self._put(long_id, {'parts': []})
        self.assertEqual(status, 400)
        self.assertEqual(text.count('\n'), 1)
        got = self._line(lines)
        self.assertEqual(got['id'], 'C' * 64)
        self.assertEqual(got['status'], '400')
        self.assertNotIn('FORGED', text)

    def test_project_limit_and_write_error_log_5xx(self):
        server.PROJ_MAX = 0
        status, lines, _, resp = self._put('full-1', {'parts': []})
        self.assertEqual(status, 507)
        self.assertEqual(json.loads(resp.body.decode())['error'], 'project limit')
        got = self._line(lines)
        self.assertEqual(got['status'], '507')
        self.assertEqual(got['op'], 'create')
        self.assertEqual(got['id'], 'full-1')
        server.PROJ_MAX = self._max

        blocked = Path(self.tmp.name) / 'blocked'
        blocked.write_text('not a directory')
        server.PROJ_DIR = blocked
        buf = io.StringIO()
        with redirect_stdout(buf):
            with self.assertRaises(FileExistsError):
                asyncio.run(server.proj_put('full-2', _request('full-2', {'parts': []})))
        text = buf.getvalue()
        got = self._line(text.splitlines())
        self.assertEqual(got['id'], 'full-2')
        self.assertEqual(got['status'], '500')
        self.assertEqual(got['op'], 'create')
        self.assertEqual(text.count('\n'), 1)


class RealServerProxyTests(unittest.TestCase):
    def test_put_logs_the_peer_not_x_forwarded_for(self):
        spoof = '203.0.113.99'
        web = Path(__file__).resolve().parents[1]
        proj = tempfile.TemporaryDirectory(prefix='savelog-peer-')
        sock = socket.socket()
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
        sock.close()
        env = os.environ.copy()
        env['SIM_PREWARM'] = '0'
        env['SIM_NETSTACK_WARM'] = '0'
        env['SIM_TOKEN'] = ''
        env['SIM_PROJECT_DIR'] = proj.name
        env['FORWARDED_ALLOW_IPS'] = '*'
        proc = subprocess.Popen(
            [sys.executable, 'server.py', '--host', '127.0.0.1', '--port', str(port)],
            cwd=str(web / 'server'), env=env,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        out = err = ''
        try:
            deadline = time.time() + 30
            up = False
            while time.time() < deadline:
                if proc.poll() is not None:
                    break
                try:
                    urllib.request.urlopen(f'http://127.0.0.1:{port}/api/projects', timeout=1)
                    up = True
                    break
                except Exception:
                    time.sleep(0.1)
            self.assertTrue(up, 'server did not start')
            body = json.dumps({'parts': []}).encode()
            req = urllib.request.Request(
                f'http://127.0.0.1:{port}/api/projects/peer-1',
                data=body, method='PUT',
                headers={'Content-Type': 'application/json', 'X-Forwarded-For': spoof},
            )
            with urllib.request.urlopen(req, timeout=5) as resp:
                self.assertEqual(resp.status, 200)
        finally:
            if proc.poll() is None:
                proc.terminate()
            try:
                out, err = proc.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                out, err = proc.communicate()
            proj.cleanup()
        lines = [ln for ln in out.splitlines() if 'project_save' in ln]
        self.assertEqual(len(lines), 1, out)
        got = LINE.match(lines[0])
        self.assertIsNotNone(got, lines[0])
        self.assertEqual(got.group('id'), 'peer-1')
        self.assertEqual(got.group('ip'), '127.0.0.1')
        self.assertEqual(got.group('status'), '200')
        self.assertEqual(got.group('op'), 'create')
        self.assertNotIn(spoof, out)
        self.assertNotIn(spoof, err)


if __name__ == '__main__':
    unittest.main()
