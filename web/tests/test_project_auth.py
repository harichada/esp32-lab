"""Project ownership. These assertions fail on a server that still accepts an anonymous overwrite."""
import hashlib
import io
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

os.environ['SIM_TOKEN'] = ''
os.environ['SIM_PREWARM'] = '0'
os.environ['SIM_NETSTACK_WARM'] = '0'
os.environ.setdefault('SIM_PROJECTS_LEGACY_OPEN', '1')
os.environ.setdefault('SIM_PROJECT_SAVES_PER_MIN', '20')

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import server as srv  # noqa: E402

try:
    import projectstore
except ImportError:
    projectstore = None

from fastapi.testclient import TestClient  # noqa: E402

PROJ = {'name': 'Blink', 'parts': [{'id': 'ESP1', 'type': 'esp32', 'x': 0, 'y': 0}], 'wires': []}
VIEW = {'error': 'view_only', 'message': 'You can view this project but not change it. Make a copy, or just start editing, to get your own version.'}
ROOT = Path(__file__).resolve().parents[2]


class ProjectAuthTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(srv.app)
        cls.client.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.client.__exit__(None, None, None)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        srv.PROJ_DIR = Path(self.tmp.name)
        os.environ['SIM_PROJECTS_LEGACY_OPEN'] = '1'
        os.environ['SIM_PROJECT_SAVES_PER_MIN'] = '60'
        os.environ['SIM_IP_SAVES_PER_MIN'] = '600'
        os.environ['SIM_IP_CREATES_PER_MIN'] = '60'
        if projectstore:
            projectstore.NOW = projectstore._default_now
            projectstore.reset_limits()

    def tearDown(self):
        if projectstore:
            projectstore.NOW = projectstore._default_now
        self.tmp.cleanup()

    def _seed(self):
        """Create the way this server creates. Main still creates with PUT and no secret."""
        made = self.client.post('/api/projects', json=dict(PROJ))
        if made.status_code == 201 and isinstance(made.json(), dict) and made.json().get('secret'):
            body = made.json()
            return body['id'], body['secret']
        legacy = self.client.put('/api/projects/clientpicked', json=dict(PROJ))
        self.assertEqual(legacy.status_code, 200, legacy.text)
        return 'clientpicked', None

    def test_post_returns_201_with_id_and_secret(self):
        buf = io.StringIO()
        with redirect_stdout(buf), redirect_stderr(buf):
            made = self.client.post('/api/projects', json=dict(PROJ, id='clientpicked'))
        self.assertEqual(made.status_code, 201, made.text)
        body = made.json()
        self.assertEqual(set(body), {'id', 'secret'})
        self.assertNotEqual(body['id'], 'clientpicked')
        self.assertRegex(body['id'], r'^[A-Za-z0-9_-]{1,40}$')
        self.assertTrue(body['secret'])
        self.assertNotIn(body['secret'], buf.getvalue())
        stored = (srv.PROJ_DIR / f"{body['id']}.json").read_text()
        self.assertNotIn(body['secret'], stored)
        digest = (srv.PROJ_DIR / f"{body['id']}.secret").read_text().strip()
        self.assertEqual(digest, hashlib.sha256(body['secret'].encode()).hexdigest())
        got = self.client.get('/api/projects/' + body['id'])
        self.assertEqual(got.status_code, 200)
        self.assertNotIn('secret', got.json())
        self.assertNotIn(body['secret'], got.text)

    def test_anonymous_put_and_delete_are_forbidden(self):
        pid, _secret = self._seed()
        updated = self.client.put('/api/projects/' + pid, json=dict(PROJ, name='overwritten'))
        self.assertEqual(updated.status_code, 403, updated.text)
        self.assertEqual(updated.json(), VIEW)
        removed = self.client.delete('/api/projects/' + pid)
        self.assertEqual(removed.status_code, 403, removed.text)
        self.assertEqual(removed.json(), VIEW)
        self.assertTrue((srv.PROJ_DIR / f'{pid}.json').exists())

    def test_wrong_secret_is_forbidden(self):
        pid, secret = self._seed()
        self.assertTrue(secret)
        updated = self.client.put('/api/projects/' + pid, json=PROJ, headers={'X-Edit-Secret': secret + '-no'})
        self.assertEqual(updated.status_code, 403, updated.text)
        self.assertEqual(updated.json(), VIEW)
        removed = self.client.delete('/api/projects/' + pid, headers={'X-Edit-Secret': 'wrong'})
        self.assertEqual(removed.status_code, 403, removed.text)

    def test_right_secret_updates_without_returning_it(self):
        pid, secret = self._seed()
        self.assertTrue(secret)
        updated = self.client.put('/api/projects/' + pid, json=dict(PROJ, name='Kept'), headers={'X-Edit-Secret': secret})
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertNotIn('secret', updated.json())
        self.assertNotIn(secret, updated.text)
        got = self.client.get('/api/projects/' + pid)
        self.assertEqual(got.json().get('name'), 'Kept')
        removed = self.client.delete('/api/projects/' + pid, headers={'X-Edit-Secret': secret})
        self.assertEqual(removed.status_code, 200, removed.text)
        self.assertFalse((srv.PROJ_DIR / f'{pid}.json').exists())

    def test_secret_is_redacted_in_logs(self):
        pid, secret = self._seed()
        self.assertTrue(secret)
        buf = io.StringIO()
        with redirect_stdout(buf), redirect_stderr(buf):
            self.client.put('/api/projects/' + pid, json=PROJ, headers={'X-Edit-Secret': secret})
            self.client.post('/api/projects?edit=' + secret, json=PROJ)
        text = buf.getvalue()
        self.assertNotIn(secret, text)
        self.assertIn('[redacted]', text)

    def test_query_secret_is_not_logged(self):
        buf = io.StringIO()
        with redirect_stdout(buf), redirect_stderr(buf):
            made = self.client.post('/api/projects?x-edit-secret=queriedsecret', json=PROJ)
        self.assertEqual(made.status_code, 400, made.text)
        self.assertNotIn('queriedsecret', buf.getvalue())
        self.assertNotIn('queriedsecret', made.text)

    def test_legacy_project_is_claimable_only_while_flag_is_open(self):
        pid = 'legacyproj'
        (srv.PROJ_DIR / f'{pid}.json').write_text(json.dumps(PROJ))
        os.environ['SIM_PROJECTS_LEGACY_OPEN'] = '0'
        closed = self.client.put('/api/projects/' + pid, json=dict(PROJ, name='claim'))
        self.assertEqual(closed.status_code, 403, closed.text)
        self.assertEqual(closed.json(), VIEW)
        self.assertFalse((srv.PROJ_DIR / f'{pid}.secret').exists())
        os.environ['SIM_PROJECTS_LEGACY_OPEN'] = '1'
        claimed = self.client.put('/api/projects/' + pid, json=dict(PROJ, name='claim'))
        self.assertEqual(claimed.status_code, 200, claimed.text)
        secret = claimed.json().get('secret')
        self.assertTrue(secret)
        self.assertEqual(claimed.json()['id'], pid)
        again = self.client.put('/api/projects/' + pid, json=dict(PROJ, name='again'))
        self.assertEqual(again.status_code, 403, again.text)
        kept = self.client.put('/api/projects/' + pid, json=dict(PROJ, name='again'), headers={'X-Edit-Secret': secret})
        self.assertEqual(kept.status_code, 200, kept.text)
        self.assertNotIn('secret', kept.json())
        # The old client-chosen create route does not come back with the flag.
        fresh = self.client.put('/api/projects/brandnew', json=PROJ)
        self.assertEqual(fresh.status_code, 404, fresh.text)

    def test_list_does_not_enumerate(self):
        pid, _secret = self._seed()
        (srv.PROJ_DIR / 'someoneelse.json').write_text(json.dumps(dict(PROJ, name='Other person')))
        listed = self.client.get('/api/projects')
        self.assertEqual(listed.status_code, 200, listed.text)
        self.assertEqual(listed.json(), [])
        self.assertEqual(self.client.get('/api/projects/' + pid).status_code, 200)

    def test_eleventh_create_is_429(self):
        os.environ['SIM_IP_CREATES_PER_MIN'] = '10'
        os.environ['SIM_IP_SAVES_PER_MIN'] = '600'
        os.environ['SIM_PROJECT_SAVES_PER_MIN'] = '60'
        if projectstore:
            projectstore.reset_limits()
        buf = io.StringIO()
        codes = []
        last = None
        with redirect_stdout(buf), redirect_stderr(buf):
            for i in range(11):
                last = self.client.post('/api/projects', json=dict(PROJ, name='c%d' % i))
                codes.append(last.status_code)
        self.assertEqual(codes, [201] * 10 + [429], codes)
        self.assertTrue(last.headers.get('retry-after'))
        self.assertGreaterEqual(int(last.headers['retry-after']), 1)
        self.assertEqual(last.json().get('error'), 'rate_limit')
        self.assertIn('create rate limit', buf.getvalue().lower())
        self.assertNotIn('secret', last.json())

    def test_failed_secret_does_not_spend_project_budget(self):
        os.environ['SIM_PROJECT_SAVES_PER_MIN'] = '2'
        os.environ['SIM_IP_SAVES_PER_MIN'] = '100'
        if projectstore:
            projectstore.reset_limits()
        pid, secret = self._seed()
        self.assertTrue(secret)
        for _ in range(5):
            denied = self.client.put('/api/projects/' + pid, json=dict(PROJ, name='nope'), headers={'X-Edit-Secret': 'wrong'})
            self.assertEqual(denied.status_code, 403, denied.text)
            self.assertEqual(denied.json().get('error'), 'view_only')
        first = self.client.put('/api/projects/' + pid, json=dict(PROJ, name='one'), headers={'X-Edit-Secret': secret})
        second = self.client.put('/api/projects/' + pid, json=dict(PROJ, name='two'), headers={'X-Edit-Secret': secret})
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(second.status_code, 200, second.text)
        third = self.client.put('/api/projects/' + pid, json=dict(PROJ, name='three'), headers={'X-Edit-Secret': secret})
        self.assertEqual(third.status_code, 429, third.text)
        self.assertTrue(third.headers.get('retry-after'))

    def test_spoofed_forwarded_for_does_not_bypass_ip_limit(self):
        os.environ['SIM_IP_SAVES_PER_MIN'] = '2'
        os.environ['SIM_PROJECT_SAVES_PER_MIN'] = '100'
        if projectstore:
            projectstore.reset_limits()
        pid, secret = self._seed()
        headers = {'X-Edit-Secret': secret}
        buf = io.StringIO()
        with redirect_stdout(buf), redirect_stderr(buf):
            first = self.client.put('/api/projects/' + pid, json=dict(PROJ, name='a'), headers=headers)
            second = self.client.put('/api/projects/' + pid, json=dict(PROJ, name='b'), headers=headers)
            spoofed = dict(headers)
            spoofed['X-Forwarded-For'] = '203.0.113.5'
            spoofed['X-Real-IP'] = '203.0.113.5'
            third = self.client.put('/api/projects/' + pid, json=dict(PROJ, name='c'), headers=spoofed)
        self.assertEqual([first.status_code, second.status_code, third.status_code], [200, 200, 429])
        self.assertTrue(third.headers.get('retry-after'))
        text = buf.getvalue()
        self.assertNotIn('203.0.113.5', text)
        self.assertIn('ip=testclient', text)
        self.assertNotIn(secret, text)

    def test_ten_clients_on_one_ip_stay_under_the_save_limits(self):
        """Ten students, one address, each saving on the 10s backup cadence for a minute."""
        os.environ['SIM_PROJECT_SAVES_PER_MIN'] = '10'
        os.environ['SIM_IP_SAVES_PER_MIN'] = '120'
        os.environ['SIM_IP_CREATES_PER_MIN'] = '10'
        self.assertTrue(projectstore)
        projectstore.reset_limits()
        clock = {'t': 1000000.0}
        projectstore.NOW = lambda: clock['t']
        owned = []
        for i in range(10):
            made = self.client.post('/api/projects', json=dict(PROJ, name='student%d' % i))
            self.assertEqual(made.status_code, 201, made.text)
            owned.append((made.json()['id'], made.json()['secret']))
        codes = []
        for step in range(6):
            clock['t'] = 1000000.0 + step * 10
            for pid, secret in owned:
                saved = self.client.put(
                    '/api/projects/' + pid,
                    json=dict(PROJ, name='student t%d' % step),
                    headers={'X-Edit-Secret': secret},
                )
                codes.append(saved.status_code)
        self.assertEqual(codes, [200] * 60, codes)

    def test_view_only_edit_leaves_the_original_file_byte_identical(self):
        pid, secret = self._seed()
        self.assertTrue(secret)
        path = srv.PROJ_DIR / f'{pid}.json'
        side = srv.PROJ_DIR / f'{pid}.secret'
        before = path.read_bytes()
        side_before = side.read_bytes()
        got = self.client.get('/api/projects/' + pid)
        self.assertEqual(got.status_code, 200)
        forked = self.client.post('/api/projects', json=dict(PROJ, name='Learner copy', code='changed locally'))
        self.assertEqual(forked.status_code, 201, forked.text)
        self.assertNotEqual(forked.json()['id'], pid)
        denied = self.client.put('/api/projects/' + pid, json=dict(PROJ, name='tamper'))
        self.assertEqual(denied.status_code, 403, denied.text)
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(side.read_bytes(), side_before)

    def test_v64_get_does_not_expose_the_secret_hash(self):
        if shutil.which('git') is None:
            self.skipTest('git is unavailable, so the v64 server from 21340d3 cannot be loaded')
        pid, secret = self._seed()
        self.assertTrue(secret)
        digest = (srv.PROJ_DIR / f'{pid}.secret').read_text().strip()
        self.assertEqual(len(digest), 64)
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            for name in ('server.py', 'diskkeep.py'):
                shown = subprocess.run(
                    ['git', 'show', '21340d3:web/server/' + name],
                    cwd=str(ROOT), capture_output=True,
                )
                if shown.returncode != 0:
                    self.skipTest('git show 21340d3:web/server/%s failed, so the v64 server cannot be loaded' % name)
                (folder / name).write_bytes(shown.stdout)
            script = textwrap.dedent('''
                import os
                os.environ['SIM_TOKEN'] = ''
                os.environ['SIM_PREWARM'] = '0'
                os.environ['SIM_NETSTACK_WARM'] = '0'
                os.environ['SIM_PROJECT_DIR'] = os.environ['PROJ']
                import server
                from fastapi.testclient import TestClient
                client = TestClient(server.app)
                client.__enter__()
                try:
                    got = client.get('/api/projects/' + os.environ['PID'])
                    assert got.status_code == 200, got.text
                    body = got.text
                    digest = os.environ['DIGEST']
                    assert digest not in body
                    data = got.json()
                    assert 'secret' not in data
                    assert 'editSecret' not in data
                    assert 'editSecretHash' not in data
                    listed = client.get('/api/projects')
                    assert listed.status_code == 200, listed.text
                    assert digest not in listed.text
                finally:
                    client.__exit__(None, None, None)
                print('OK')
            ''')
            env = os.environ.copy()
            env['PROJ'] = str(srv.PROJ_DIR)
            env['PID'] = pid
            env['DIGEST'] = digest
            env['PYTHONPATH'] = str(folder)
            env['SIM_TOKEN'] = ''
            env['SIM_PREWARM'] = '0'
            env['SIM_NETSTACK_WARM'] = '0'
            proc = subprocess.run(
                [sys.executable, '-c', script],
                cwd=str(folder), env=env, capture_output=True, text=True,
            )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn('OK', proc.stdout)

    def test_v64_loader_round_trips_circuit_and_code(self):
        """v64 reads the JSON #28 writes and ignores the owner-secret sidecar."""
        if shutil.which('git') is None:
            self.skipTest('git is unavailable, so the v64 loader from 21340d3 cannot be loaded')
        circuit = {
            'name': 'Round trip',
            'parts': [
                {'id': 'ESP1', 'type': 'esp32', 'x': 10, 'y': 20},
                {'id': 'R1', 'type': 'resistor', 'x': 40, 'y': 20, 'props': {'r': 220}},
            ],
            'wires': [{'id': 'W1', 'a': 'ESP1.D13', 'b': 'R1.1', 'color': 'red'}],
            'code': 'void setup(){pinMode(13, OUTPUT);}\nvoid loop(){digitalWrite(13, HIGH);}',
        }
        made = self.client.post('/api/projects', json=circuit)
        self.assertEqual(made.status_code, 201, made.text)
        pid = made.json()['id']
        path = srv.PROJ_DIR / f'{pid}.json'
        side = srv.PROJ_DIR / f'{pid}.secret'
        digest = side.read_text().strip()
        self.assertEqual(len(digest), 64)
        stored = json.loads(path.read_text())
        stored['ownerHash'] = 'extra-field-v64-must-ignore'
        path.write_text(json.dumps(stored))
        before = path.read_bytes()
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            for name in ('server.py', 'diskkeep.py'):
                shown = subprocess.run(
                    ['git', 'show', '21340d3:web/server/' + name],
                    cwd=str(ROOT), capture_output=True,
                )
                if shown.returncode != 0:
                    self.skipTest('git show 21340d3:web/server/%s failed, so the v64 loader cannot be loaded' % name)
                (folder / name).write_bytes(shown.stdout)
            script = textwrap.dedent('''
                import json, os
                os.environ['SIM_TOKEN'] = ''
                os.environ['SIM_PREWARM'] = '0'
                os.environ['SIM_NETSTACK_WARM'] = '0'
                os.environ['SIM_PROJECT_DIR'] = os.environ['PROJ']
                import server
                from fastapi.testclient import TestClient
                client = TestClient(server.app)
                client.__enter__()
                try:
                    got = client.get('/api/projects/' + os.environ['PID'])
                    assert got.status_code == 200, got.text
                    data = got.json()
                    want = json.loads(os.environ['WANT'])
                    assert data.get('parts') == want['parts'], data.get('parts')
                    assert data.get('wires') == want['wires'], data.get('wires')
                    assert data.get('code') == want['code'], data.get('code')
                    assert os.environ['DIGEST'] not in got.text
                    assert 'secret' not in data
                finally:
                    client.__exit__(None, None, None)
                print('OK')
            ''')
            env = os.environ.copy()
            env['PROJ'] = str(srv.PROJ_DIR)
            env['PID'] = pid
            env['DIGEST'] = digest
            env['WANT'] = json.dumps({
                'parts': circuit['parts'],
                'wires': circuit['wires'],
                'code': circuit['code'],
            })
            env['PYTHONPATH'] = str(folder)
            env['SIM_TOKEN'] = ''
            env['SIM_PREWARM'] = '0'
            env['SIM_NETSTACK_WARM'] = '0'
            proc = subprocess.run(
                [sys.executable, '-c', script],
                cwd=str(folder), env=env, capture_output=True, text=True,
            )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn('OK', proc.stdout)
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(side.read_text().strip(), digest)

    def test_server_rejects_bad_names_ids_and_non_finite_values(self):
        bad_id = self.client.post('/api/projects', json={'name': 'x', 'parts': [{'id': '<img src=x onerror=alert(1)>', 'type': 'led'}], 'wires': []})
        self.assertEqual(bad_id.status_code, 400, bad_id.text)
        self.assertNotIn('<', bad_id.json().get('message', ''))
        self.assertIn('part id', bad_id.json().get('message', '').lower())
        bad_file = self.client.post('/api/projects', json={'name': 'x', 'parts': [{'id': 'LED1', 'type': 'led'}], 'files': {'<img src=x onerror=alert(1)>.h': 'int x;'}, 'wires': []})
        self.assertEqual(bad_file.status_code, 400, bad_file.text)
        self.assertIn('file name', bad_file.json().get('message', '').lower())
        self.assertNotIn('<', bad_file.json().get('message', ''))
        raw = b'{"name":"x","parts":[{"id":"LED1","type":"led","props":{"vf":NaN}}],"wires":[]}'
        bad_num = self.client.post('/api/projects', content=raw, headers={'content-type': 'application/json'})
        self.assertEqual(bad_num.status_code, 400, bad_num.text)
        self.assertIn('finite', bad_num.json().get('message', '').lower())
        bad_range = self.client.post('/api/projects', json={'name': 'x', 'parts': [{'id': 'POT1', 'type': 'potentiometer', 'props': {'pos': 5}}], 'wires': []})
        self.assertEqual(bad_range.status_code, 400, bad_range.text)
        self.assertIn('between 0 and 1', bad_range.json().get('message', ''))

    def test_wrong_secret_counts_toward_ip_save_limit(self):
        os.environ['SIM_IP_SAVES_PER_MIN'] = '2'
        os.environ['SIM_PROJECT_SAVES_PER_MIN'] = '10'
        if projectstore:
            projectstore.reset_limits()
        pid, secret = self._seed()
        self.assertTrue(secret)
        buf = io.StringIO()
        with redirect_stdout(buf), redirect_stderr(buf):
            first = self.client.put('/api/projects/' + pid, json=dict(PROJ, name='nope'), headers={'X-Edit-Secret': 'wrong'})
            second = self.client.put('/api/projects/' + pid, json=dict(PROJ, name='nope'), headers={'X-Edit-Secret': 'wrong'})
            blocked = self.client.put('/api/projects/' + pid, json=dict(PROJ, name='nope'), headers={'X-Edit-Secret': 'wrong'})
            good = self.client.put('/api/projects/' + pid, json=dict(PROJ, name='kept'), headers={'X-Edit-Secret': secret})
        self.assertEqual(first.status_code, 403, first.text)
        self.assertEqual(second.status_code, 403, second.text)
        self.assertEqual(first.json().get('error'), 'view_only')
        self.assertEqual(blocked.status_code, 429, blocked.text)
        self.assertEqual(blocked.json().get('error'), 'rate_limit')
        self.assertTrue(blocked.headers.get('retry-after'))
        self.assertEqual(good.status_code, 429, good.text)
        text = buf.getvalue()
        self.assertIn('reason=bad_secret_rate', text)
        self.assertNotIn(secret, text)
        self.assertNotIn('wrong', text)
        kept = self.client.get('/api/projects/' + pid)
        self.assertEqual(kept.status_code, 200, kept.text)
        self.assertEqual(kept.json().get('name'), 'Blink')

    def test_wrong_secret_on_one_address_leaves_another_address_budget(self):
        os.environ['SIM_IP_SAVES_PER_MIN'] = '2'
        os.environ['SIM_PROJECT_SAVES_PER_MIN'] = '10'
        if projectstore:
            projectstore.reset_limits()
        pid, secret = self._seed()
        self.assertTrue(secret)
        transport = self.client._transport
        original = transport.client
        buf = io.StringIO()
        try:
            transport.client = ('198.51.100.10', 50000)
            with redirect_stdout(buf), redirect_stderr(buf):
                first = self.client.put('/api/projects/' + pid, json=dict(PROJ, name='nope'), headers={'X-Edit-Secret': 'wrong'})
                second = self.client.put('/api/projects/' + pid, json=dict(PROJ, name='nope'), headers={'X-Edit-Secret': 'wrong'})
                blocked = self.client.put('/api/projects/' + pid, json=dict(PROJ, name='nope'), headers={'X-Edit-Secret': 'wrong'})
                transport.client = ('203.0.113.20', 50000)
                good = self.client.put('/api/projects/' + pid, json=dict(PROJ, name='from-b'), headers={'X-Edit-Secret': secret})
        finally:
            transport.client = original
        self.assertEqual(first.status_code, 403, first.text)
        self.assertEqual(second.status_code, 403, second.text)
        self.assertEqual(blocked.status_code, 429, blocked.text)
        self.assertIn('reason=bad_secret_rate', buf.getvalue())
        self.assertNotIn(secret, buf.getvalue())
        self.assertEqual(good.status_code, 200, good.text)
        kept = self.client.get('/api/projects/' + pid)
        self.assertEqual(kept.status_code, 200, kept.text)
        self.assertEqual(kept.json().get('name'), 'from-b')

    def test_rotating_forwarded_for_on_uvicorn_still_429s(self):
        """TestClient never installs uvicorn's proxy-header middleware.

        A real server.py process does. Rotating X-Forwarded-For from 127.0.0.1
        must still share one client address.
        """
        src = (Path(__file__).resolve().parents[1] / 'server' / 'server.py').read_text()
        self.assertIn('proxy_headers=False', src)
        self.assertIn("forwarded_allow_ips=''", src)
        try:
            import httpx
        except ImportError:
            self.skipTest('httpx is required to call the live server')
        sock = socket.socket()
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
        sock.close()
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        env = os.environ.copy()
        env.update({
            'SIM_TOKEN': '',
            'SIM_PREWARM': '0',
            'SIM_NETSTACK_WARM': '0',
            'SIM_PROJECT_DIR': tmp.name,
            'SIM_IP_CREATES_PER_MIN': '10',
            'SIM_IP_SAVES_PER_MIN': '10',
            'SIM_PROJECT_SAVES_PER_MIN': '100',
        })
        proc = subprocess.Popen(
            [sys.executable, 'server/server.py', '--host', '127.0.0.1', '--port', str(port)],
            cwd=str(Path(__file__).resolve().parents[1]),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        out = []

        def _read():
            for line in proc.stdout:
                out.append(line)

        threading.Thread(target=_read, daemon=True).start()
        self.addCleanup(self._stop_proc, proc)
        base = 'http://127.0.0.1:%d' % port
        deadline = time.time() + 40
        up = False
        while time.time() < deadline:
            if proc.poll() is not None:
                break
            try:
                httpx.get(base + '/', timeout=1)
                up = True
                break
            except Exception:
                time.sleep(0.25)
        self.assertTrue(up, 'server did not start\n' + ''.join(out)[-2000:])
        create_codes = []
        made = None
        with httpx.Client(timeout=5) as client:
            for i in range(11):
                res = client.post(
                    base + '/api/projects',
                    json=dict(PROJ, name='xff%d' % i),
                    headers={'X-Forwarded-For': '198.51.100.%d' % (i + 1)},
                )
                create_codes.append(res.status_code)
                if made is None and res.status_code == 201:
                    made = res.json()
            self.assertEqual(create_codes, [201] * 10 + [429], create_codes)
            self.assertTrue(made and made.get('id') and made.get('secret'))
            save_codes = []
            for i in range(11):
                res = client.put(
                    base + '/api/projects/' + made['id'],
                    json=dict(PROJ, name='save%d' % i),
                    headers={
                        'X-Edit-Secret': made['secret'],
                        'X-Forwarded-For': '203.0.113.%d' % (i + 1),
                    },
                )
                save_codes.append(res.status_code)
        self.assertEqual(save_codes, [200] * 10 + [429], save_codes)
        log = ''.join(out)
        self.assertNotIn('198.51.100.', log)
        self.assertNotIn('203.0.113.', log)
        self.assertNotIn(made['secret'], log)

    @staticmethod
    def _stop_proc(proc):
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        if proc.stdout:
            proc.stdout.close()


if __name__ == '__main__':
    unittest.main()
