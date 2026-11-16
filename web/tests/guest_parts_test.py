"""Guest starter-part limit.

The check is the server's. A guest naming only starter parts is allowed, a
guest naming anything else is HTTP 403, a signed-in session is allowed, and
AUTH_ENABLED=0 (or GUEST_PARTS_LIMIT=0) does not check. A compile with no
parts list is code-only and is allowed. A run with no parts list is not.
"""
import os
import sys
import unittest
from pathlib import Path

os.environ['SIM_PREWARM'] = '0'
os.environ['SIM_NETSTACK_WARM'] = '0'
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))

import auth
import guestparts
import server
from starlette.testclient import TestClient

STARTER = ['esp32', 'breadboard', 'led', 'resistor']
LOCKED = ['esp32', 'breadboard', 'led', 'resistor', 'servo']


class GuestPartsDecisionTests(unittest.TestCase):
    def test_flag_defaults(self):
        self.assertFalse(guestparts.enabled({}))
        self.assertFalse(guestparts.enabled({'AUTH_ENABLED': '0', 'GUEST_PARTS_LIMIT': '1'}))
        self.assertTrue(guestparts.enabled({'AUTH_ENABLED': '1'}))
        self.assertTrue(guestparts.enabled({'AUTH_ENABLED': '1', 'GUEST_PARTS_LIMIT': 'yes'}))
        self.assertFalse(guestparts.enabled({'AUTH_ENABLED': '1', 'GUEST_PARTS_LIMIT': '0'}))
        self.assertFalse(guestparts.enabled({'AUTH_ENABLED': '1', 'GUEST_PARTS_LIMIT': 'off'}))
        custom = guestparts.allow_list({'GUEST_PARTS': 'led, esp32, led, not a type'})
        self.assertEqual(custom, ('led', 'esp32'))
        self.assertEqual(guestparts.allow_list({}), guestparts.DEFAULT_PARTS)

    def test_code_only_compile_is_allowed_and_a_run_must_name_parts(self):
        env = {'AUTH_ENABLED': '1'}
        self.assertFalse(guestparts.blocks(None, signed_in=False, env=env))
        self.assertTrue(guestparts.blocks(None, signed_in=False, env=env, require_named=True))
        self.assertFalse(guestparts.blocks(None, signed_in=True, env=env, require_named=True))
        self.assertFalse(guestparts.blocks(STARTER, signed_in=False, env=env))
        self.assertTrue(guestparts.blocks(LOCKED, signed_in=False, env=env))
        self.assertFalse(guestparts.blocks(LOCKED, signed_in=True, env=env))
        self.assertFalse(guestparts.blocks(LOCKED, signed_in=False, env={'AUTH_ENABLED': '0'}))
        self.assertFalse(guestparts.blocks(LOCKED, signed_in=False, env={'AUTH_ENABLED': '1', 'GUEST_PARTS_LIMIT': '0'}))

    def test_mapping_is_the_catalog_ids(self):
        self.assertEqual(
            guestparts.DEFAULT_PARTS,
            ('esp32', 'breadboard', 'led', 'resistor', 'pushbutton', 'potentiometer', 'buzzer',
             'ground', 'vcc33', 'vcc5', 'label'),
        )


class GuestPartsHttpTests(unittest.TestCase):
    def setUp(self):
        self._auth = auth.ENABLED
        self._saved = {}
        for key in ('AUTH_ENABLED', 'GUEST_PARTS_LIMIT', 'GUEST_PARTS'):
            self._saved[key] = os.environ.get(key)
        self.client = TestClient(server.app)
        self._inner = server._compile_request
        self.calls = []

        async def fake(req, **kwargs):
            self.calls.append(req)
            return {'ok': True, 'id': 'abc', 'log': 'ok'}

        server._compile_request = fake

    def tearDown(self):
        server._compile_request = self._inner
        auth.ENABLED = self._auth
        for key, value in self._saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def _auth_on(self, limit='1'):
        auth.ENABLED = True
        os.environ['AUTH_ENABLED'] = '1'
        os.environ['GUEST_PARTS_LIMIT'] = limit

    def _post(self, parts):
        body = {'sketch': 'void setup(){}', 'files': {}, 'defines': []}
        if parts is not None:
            body['parts'] = parts
        return self.client.post('/api/compile', json=body)

    def test_guest_starter_is_allowed_and_locked_is_403(self):
        self._auth_on()
        ok = self._post(STARTER)
        self.assertEqual(ok.status_code, 200, ok.text)
        self.assertEqual(len(self.calls), 1)
        denied = self._post(LOCKED)
        self.assertEqual(denied.status_code, 403)
        body = denied.json()
        self.assertEqual(body['error'], 'guest_parts')
        self.assertEqual(body['message'], 'Sign in free to use this part')
        self.assertFalse(body['ok'])
        self.assertEqual(len(self.calls), 1)

    def test_code_only_compile_is_allowed_for_a_guest(self):
        self._auth_on()
        res = self._post(None)
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(len(self.calls), 1)

    def test_signed_in_may_use_a_locked_part(self):
        self._auth_on()
        original = guestparts.is_signed_in
        guestparts.is_signed_in = lambda cookies, env=None: True
        try:
            res = self._post(LOCKED)
        finally:
            guestparts.is_signed_in = original
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(len(self.calls), 1)

    def test_flag_off_allows_a_locked_part(self):
        auth.ENABLED = False
        os.environ['AUTH_ENABLED'] = '0'
        res = self._post(LOCKED)
        self.assertEqual(res.status_code, 200, res.text)
        auth.ENABLED = True
        os.environ['AUTH_ENABLED'] = '1'
        os.environ['GUEST_PARTS_LIMIT'] = '0'
        again = self._post(LOCKED)
        self.assertEqual(again.status_code, 200, again.text)
        self.assertEqual(len(self.calls), 2)

    def test_guest_run_without_parts_and_with_a_locked_part_is_refused(self):
        self._auth_on()
        with self.client.websocket_connect('/api/run/abcdef0123456789') as ws:
            msg = ws.receive_json()
        self.assertEqual(msg['error'], 'guest_parts')
        self.assertEqual(msg['message'], 'Sign in free to use this part')
        with self.client.websocket_connect('/api/run/abcdef0123456789?parts=servo') as ws:
            msg = ws.receive_json()
        self.assertEqual(msg['error'], 'guest_parts')

    def test_guest_run_of_blink_parts_is_not_the_parts_error(self):
        self._auth_on()
        # The build id is unknown, so the socket continues to the existing
        # "expired" error. It must not be the guest-parts refusal.
        with self.client.websocket_connect('/api/run/abcdef0123456789?parts=esp32,breadboard,led,resistor') as ws:
            msg = ws.receive_json()
        self.assertNotEqual(msg.get('error'), 'guest_parts')

    def test_project_save_of_a_locked_part_does_not_write(self):
        self._auth_on()
        pid = 'guestlock1'
        path = server.PROJ_DIR / (pid + '.json')
        if path.exists():
            path.unlink()
        res = self.client.put('/api/projects/' + pid, json={
            'name': 'Locked', 'parts': [{'id': 's', 'type': 'servo'}], 'wires': [],
        })
        self.assertEqual(res.status_code, 403)
        self.assertEqual(res.json()['error'], 'guest_parts')
        self.assertFalse(path.exists())
        ok = self.client.put('/api/projects/' + pid, json={
            'name': 'Blink', 'parts': [{'id': 'e', 'type': 'esp32'}, {'id': 'l', 'type': 'led'}], 'wires': [],
        })
        self.assertEqual(ok.status_code, 200, ok.text)
        self.assertTrue(path.exists())
        path.unlink()

    def test_page_lists_the_starter_set_only_while_the_limit_is_on(self):
        page = (Path(__file__).resolve().parents[1] / 'index.html').read_bytes()
        auth.ENABLED = False
        body, plain = server.lab_page()
        self.assertTrue(plain)
        self.assertEqual(body, page)
        self.assertNotIn(b'name="guestparts"', body)
        auth.ENABLED = True
        os.environ['AUTH_ENABLED'] = '1'
        os.environ.pop('GUEST_PARTS_LIMIT', None)
        body, plain = server.lab_page()
        self.assertFalse(plain)
        self.assertIn(b'<meta name="guestparts" content="esp32,breadboard,led,resistor,pushbutton,potentiometer,buzzer,ground,vcc33,vcc5,label">', body)
        self.assertIn(b'js/guestparts.js?v=3', body)
        os.environ['GUEST_PARTS_LIMIT'] = '0'
        body, plain = server.lab_page()
        self.assertNotIn(b'name="guestparts"', body)
        self.assertIn(b'name="cl-auth"', body)


if __name__ == '__main__':
    unittest.main()
