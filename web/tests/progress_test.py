"""Compile progress is per client. These cases pass a global log around on main."""
import asyncio
import json
import os
import unittest

os.environ.setdefault('SIM_PREWARM', '0')
os.environ.setdefault('SIM_NETSTACK_WARM', '0')
os.environ.setdefault('SIM_COMPILE_QUEUE', '0')

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import server
from starlette.requests import Request

SECRET = 'SECRET_PROGRESS_A'


def _request(client_id='', compile_id='', query=b''):
    headers = []
    if client_id:
        headers.append((b'x-client-id', client_id.encode()))
    if compile_id:
        headers.append((b'x-compile-id', compile_id.encode()))
    scope = {
        'type': 'http', 'asgi': {'version': '3.0'}, 'http_version': '1.1', 'method': 'GET',
        'scheme': 'http', 'path': '/api/compile/progress', 'raw_path': b'/api/compile/progress',
        'query_string': query, 'headers': headers,
        'client': ('127.0.0.1', 1), 'server': ('127.0.0.1', 80),
    }
    return Request(scope)


def _sketch(tag):
    return {'sketch': 'void setup(){}\nvoid loop(){}\n// ' + tag, 'files': {}}


async def _asgi_get(path, headers=None):
    """Call the ASGI app so the status line is the one a browser would see."""
    messages = []
    sent = {'body': False}

    async def receive():
        if not sent['body']:
            sent['body'] = True
            return {'type': 'http.request', 'body': b'', 'more_body': False}
        while not any(message['type'] == 'http.response.body' for message in messages):
            await asyncio.sleep(0)
        return {'type': 'http.disconnect'}

    async def send(message):
        messages.append(message)

    scope = {
        'type': 'http', 'asgi': {'version': '3.0'}, 'http_version': '1.1', 'method': 'GET',
        'scheme': 'http', 'path': path, 'raw_path': path.encode(), 'query_string': b'',
        'headers': headers or [], 'client': ('127.0.0.1', 1), 'server': ('127.0.0.1', 80),
    }
    await server.app(scope, receive, send)
    start = next(message for message in messages if message['type'] == 'http.response.start')
    raw = b''.join(message.get('body', b'') for message in messages if message['type'] == 'http.response.body')
    return start['status'], json.loads(raw.decode() or '{}')


class _OpenLock:
    def locked(self):
        return False

    async def __aenter__(self):
        return None

    async def __aexit__(self, *_exc):
        return False


class ProgressIsolationTests(unittest.TestCase):
    def setUp(self):
        self._env = dict(os.environ)
        os.environ['SIM_COMPILE_QUEUE'] = '0'
        os.environ['SIM_PREWARM'] = '0'
        os.environ['SIM_NETSTACK_WARM'] = '0'
        self._hold = server._compile_holding_lock
        self._lock = server._compile_lock
        self._ttl = getattr(server, '_PROGRESS_TTL_S', None)
        server._compile_lock = _OpenLock()

    def tearDown(self):
        server._compile_holding_lock = self._hold
        server._compile_lock = self._lock
        server._install_queue()
        if self._ttl is not None:
            server._PROGRESS_TTL_S = self._ttl
        elif hasattr(server, '_PROGRESS_TTL_S'):
            # A main checkout has no ttl until a test assigns one.
            try:
                del server._PROGRESS_TTL_S
            except AttributeError:
                pass
        if hasattr(server, '_progress_records'):
            server._progress_records.clear()
            server._progress_by_client.clear()
        if hasattr(server, 'PROGRESS'):
            server.PROGRESS.update(active=False, log='', t0=0.0, stage='', stages='', compiler='')
        os.environ.clear()
        os.environ.update(self._env)

    def _run(self, coro):
        return asyncio.run(coro)

    async def _start(self, jobs, write):
        started = {tag: asyncio.Event() for _cid, tag in jobs}
        release = asyncio.Event()

        async def fake(_owner, plan, rebuild_netstack=False):
            tag = plan['sketch'].rsplit('// ', 1)[-1].strip()
            server._begin_progress()
            write(tag)
            started[tag].set()
            await release.wait()
            return {'ok': True, 'id': tag, 'cached': False, 'log': 'done-' + tag}

        server._compile_holding_lock = fake
        tasks = [
            asyncio.create_task(server._compile_request(_sketch(tag), client_id=cid))
            for cid, tag in jobs
        ]
        for tag in started:
            await asyncio.wait_for(started[tag].wait(), 2)
        return release, tasks

    async def _finish(self, release, tasks):
        release.set()
        await asyncio.gather(*tasks)

    def test_client_b_cannot_see_client_a_log(self):
        async def scenario():
            def write(_tag):
                server._stage(SECRET)
                server._compiler_log(SECRET + '\n')

            release, tasks = await self._start([('client-a', 'alpha')], write)
            try:
                owner = await server.compile_progress(_request('client-a'))
                other = await server.compile_progress(_request('client-b'))
                self.assertIn(SECRET, owner['log'])
                self.assertNotIn(SECRET, other['log'])
                self.assertNotIn(SECRET, other['stage'])
                self.assertNotIn(SECRET, json.dumps({k: v for k, v in other.items() if k != 'elapsed'}))
                hit = _sketch('hit-alpha')
                plan = server._compile_plan(hit)
                plan['img'].parent.mkdir(parents=True, exist_ok=True)
                plan['img'].write_bytes(b'cached')
                cached = await server._compile_request(hit, client_id='client-b')
                if isinstance(cached, dict):
                    self.assertNotIn(SECRET, cached.get('log', ''))
                again = await server.compile_progress(_request('client-b'))
                self.assertNotIn(SECRET, again['log'])
                self.assertNotIn(SECRET, again['stage'])
                still = await server.compile_progress(_request('client-a'))
                self.assertIn(SECRET, still['log'])
                self.assertNotEqual(still['stage'], again['stage'])
            finally:
                await self._finish(release, tasks)

        self._run(scenario())

    def test_anonymous_and_unknown_id_are_empty(self):
        async def scenario():
            def write(_tag):
                server._stage(SECRET)
                server._compiler_log(SECRET + '\n')

            release, tasks = await self._start([('client-a', 'anon')], write)
            try:
                anon = await server.compile_progress(_request())
                self.assertEqual(anon['active'], False)
                self.assertEqual(anon['elapsed'], 0)
                self.assertEqual(anon['log'], '')
                self.assertEqual(anon['stage'], '')
                self.assertNotIn('wait', anon)
                self.assertNotIn(SECRET, json.dumps(anon))
                ghost = await server.compile_progress(_request('client-a', 'not-a-real-compile'))
                self.assertEqual(ghost['log'], '')
                self.assertEqual(ghost['stage'], '')
                self.assertNotIn(SECRET, json.dumps(ghost))
                query = await server.compile_progress(_request(query=b'id=not-a-real-compile'))
                self.assertEqual(query['log'], '')
                self.assertNotIn(SECRET, json.dumps(query))
                owner = await server.compile_progress(_request('client-a'))
                self.assertIn(SECRET, owner['log'])
            finally:
                await self._finish(release, tasks)

        self._run(scenario())

    def test_missing_id_is_http_200(self):
        async def scenario():
            def write(_tag):
                server._stage(SECRET)
                server._compiler_log(SECRET + '\n')

            release, tasks = await self._start([('client-a', 'status')], write)
            try:
                status, body = await _asgi_get('/api/compile/progress')
                self.assertEqual(status, 200)
                self.assertEqual(body['log'], '')
                self.assertEqual(body['stage'], '')
                self.assertNotIn(SECRET, json.dumps(body))
                status_b, body_b = await _asgi_get('/api/compile/progress', [(b'x-client-id', b'client-b')])
                self.assertEqual(status_b, 200)
                self.assertNotIn(SECRET, json.dumps(body_b))
                status_a, body_a = await _asgi_get('/api/compile/progress', [(b'x-client-id', b'client-a')])
                self.assertEqual(status_a, 200)
                self.assertIn(SECRET, body_a['log'])
            finally:
                await self._finish(release, tasks)

        self._run(scenario())

    def test_two_concurrent_builds_keep_separate_stages(self):
        async def scenario():
            def write(tag):
                server._stage('stage-' + tag)
                server._compiler_log('LOG-' + tag + '\n')

            release, tasks = await self._start(
                [('client-a', 'buildA'), ('client-b', 'buildB')], write)
            try:
                first = await server.compile_progress(_request('client-a'))
                second = await server.compile_progress(_request('client-b'))
                self.assertIn('stage-buildA', first['log'])
                self.assertIn('LOG-buildA', first['log'])
                self.assertEqual(first['stage'], 'stage-buildA')
                self.assertIn('stage-buildB', second['log'])
                self.assertIn('LOG-buildB', second['log'])
                self.assertEqual(second['stage'], 'stage-buildB')
                self.assertNotIn('buildA', second['log'])
                self.assertNotIn('buildB', first['log'])
                self.assertNotEqual(first['stage'], second['stage'])
            finally:
                await self._finish(release, tasks)

        self._run(scenario())

    def test_compile_id_is_server_made_and_hidden_from_other_clients(self):
        async def scenario():
            async def fake(_owner, plan, rebuild_netstack=False):
                server._stage(SECRET)
                server._compiler_log(SECRET + '\n')
                return {'ok': True, 'id': 'fresh', 'cached': False, 'log': 'done'}

            server._compile_holding_lock = fake

            class Response:
                def __init__(self):
                    self.headers = {}

            response = Response()
            body = await server._compile_request(
                _sketch('fresh-id'), client_id='client-a', compile_id='client-picked-id',
                response=response)
            self.assertIsInstance(body, dict)
            pid = body['compile_id']
            self.assertGreaterEqual(len(pid), 22)
            self.assertNotEqual(pid, 'client-picked-id')
            self.assertEqual(body['progressId'], pid)
            self.assertEqual(response.headers['X-Compile-Id'], pid)
            self.assertNotIn('client-picked-id', server._progress_records)
            self.assertIs(body['net_blocked_notice'], False)
            owner = await server.compile_progress(_request('client-a', pid))
            by_query = await server.compile_progress(_request('client-a', query=b'id=' + pid.encode()))
            other = await server.compile_progress(_request('client-b', pid))
            guessed = await server.compile_progress(_request('client-b', 'z' * 22))
            missing = await server.compile_progress(_request('client-b', 'not-a-real-compile'))
            self.assertEqual(other['active'], missing['active'])
            self.assertEqual(other['elapsed'], missing['elapsed'])
            self.assertEqual(other['log'], missing['log'])
            self.assertEqual(other['stage'], missing['stage'])
            self.assertEqual(guessed['log'], missing['log'])
            self.assertEqual(guessed['active'], False)
            self.assertEqual(other['log'], '')
            self.assertNotIn(SECRET, json.dumps(other))
            self.assertNotIn(SECRET, json.dumps(guessed))
            self.assertIn(SECRET, owner['log'])
            self.assertIn(SECRET, by_query['log'])
            still = await server.compile_progress(_request('client-a'))
            self.assertIn(SECRET, still['log'])

        self._run(scenario())

    def test_progress_is_capped_and_expires(self):
        async def scenario():
            blob = 'STARTMARKER' + ('S' * 30000) + 'ENDMARKER'

            def write(_tag):
                server._stage(blob)
                server._compiler_log(blob)

            release, tasks = await self._start([('client-cap', 'cap')], write)
            try:
                view = await server.compile_progress(_request('client-cap'))
                self.assertLessEqual(len(view['log']), 20000)
                self.assertLessEqual(len(view['stage']), 20000)
                self.assertNotIn('STARTMARKER', view['log'])
                self.assertIn('ENDMARKER', view['log'])
            finally:
                await self._finish(release, tasks)
            kept = await server.compile_progress(_request('client-cap'))
            self.assertIn('ENDMARKER', kept['log'])
            server._PROGRESS_TTL_S = 0
            expired = await server.compile_progress(_request('client-cap'))
            self.assertEqual(expired['log'], '')
            self.assertEqual(expired['stage'], '')
            self.assertNotIn('ENDMARKER', json.dumps(expired))

        self._run(scenario())
