"""Project ownership. These assertions fail on a server that still accepts an anonymous overwrite."""
import hashlib
import io
import json
import os
import sys
import tempfile
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
VIEW = {'error': 'view_only', 'message': 'This copy is view-only. Make a copy to edit it.'}


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
        if projectstore:
            projectstore.reset_limits()

    def tearDown(self):
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

    def test_save_rate_limit(self):
        os.environ['SIM_PROJECT_SAVES_PER_MIN'] = '2'
        if projectstore:
            projectstore.reset_limits()
        buf = io.StringIO()
        codes = []
        last = None
        with redirect_stdout(buf), redirect_stderr(buf):
            for i in range(3):
                last = self.client.post('/api/projects', json=dict(PROJ, name='n%d' % i))
                codes.append(last.status_code)
        self.assertEqual(codes, [201, 201, 429], [c for c in codes])
        self.assertTrue(last.headers.get('retry-after'))
        self.assertGreaterEqual(int(last.headers['retry-after']), 1)
        self.assertEqual(last.json().get('error'), 'rate_limit')
        self.assertIn('rate limit', buf.getvalue().lower())

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


if __name__ == '__main__':
    unittest.main()
