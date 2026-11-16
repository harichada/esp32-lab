"""COMPILE_HINTS_ENABLED defaults off and only then leaves the lab page untouched.

1, true, yes, or on adds <meta name="compilehints" content="1"> inside <head>.
Any other value, including unset, serves index.html bytes unchanged.
"""
import hashlib
import os
import sys
import unittest
from pathlib import Path

os.environ['SIM_PREWARM'] = '0'
os.environ['SIM_NETSTACK_WARM'] = '0'
os.environ.pop('COMPILE_HINTS_ENABLED', None)
os.environ.pop('STATUS_STRIP_ENABLED', None)
os.environ.pop('SCHEMATIC_MATCH_LAYOUT', None)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import server
from starlette.testclient import TestClient

WEB = Path(__file__).resolve().parents[1]
PAGE = (WEB / 'index.html').read_bytes()
META = b'<meta name="compilehints" content="1">'
SCH = b'<meta name="schmatch" content="0">'


class CompileHintsEnvTests(unittest.TestCase):
    def setUp(self):
        os.environ.pop('COMPILE_HINTS_ENABLED', None)
        os.environ.pop('STATUS_STRIP_ENABLED', None)
        os.environ.pop('SCHEMATIC_MATCH_LAYOUT', None)
        self.client = TestClient(server.app)

    def tearDown(self):
        os.environ.pop('COMPILE_HINTS_ENABLED', None)
        os.environ.pop('SCHEMATIC_MATCH_LAYOUT', None)

    def test_default_is_off_and_the_page_bytes_match(self):
        self.assertFalse(server.compile_hints_enabled({}))
        self.assertFalse(server.compile_hints_enabled({'COMPILE_HINTS_ENABLED': '0'}))
        self.assertFalse(server.compile_hints_enabled({'COMPILE_HINTS_ENABLED': ' 0 '}))
        self.assertFalse(server.compile_hints_enabled({'COMPILE_HINTS_ENABLED': ''}))
        self.assertFalse(server.compile_hints_enabled({'COMPILE_HINTS_ENABLED': 'no'}))
        self.assertFalse(server.compile_hints_enabled({'COMPILE_HINTS_ENABLED': 'false'}))
        self.assertFalse(server.compile_hints_enabled({'COMPILE_HINTS_ENABLED': 'maybe'}))
        for value in (None, '0', 'no', '', 'false'):
            if value is None:
                os.environ.pop('COMPILE_HINTS_ENABLED', None)
            else:
                os.environ['COMPILE_HINTS_ENABLED'] = value
            body, plain = server.lab_page()
            self.assertTrue(plain, value)
            self.assertEqual(body, PAGE, value)
            self.assertNotIn(META, body)
            for path in ('/', '/index.html'):
                resp = self.client.get(path)
                self.assertEqual(resp.status_code, 200, path)
                self.assertEqual(resp.content, PAGE, path)
                self.assertNotIn(META, resp.content)

    def test_on_values_inject_one_meta_tag(self):
        self.assertTrue(server.compile_hints_enabled({'COMPILE_HINTS_ENABLED': '1'}))
        self.assertTrue(server.compile_hints_enabled({'COMPILE_HINTS_ENABLED': ' 1 '}))
        self.assertTrue(server.compile_hints_enabled({'COMPILE_HINTS_ENABLED': 'yes'}))
        self.assertTrue(server.compile_hints_enabled({'COMPILE_HINTS_ENABLED': 'TRUE'}))
        self.assertTrue(server.compile_hints_enabled({'COMPILE_HINTS_ENABLED': 'on'}))
        os.environ['COMPILE_HINTS_ENABLED'] = '1'
        body, plain = server.lab_page()
        self.assertFalse(plain)
        self.assertEqual(body.count(META), 1)
        self.assertIn(b'<head>\n' + META, body)
        self.assertNotIn(SCH, body)
        self.assertIn(b'compilehints.js?v=4', body)
        for path in ('/', '/index.html'):
            resp = self.client.get(path)
            self.assertEqual(resp.status_code, 200, path)
            self.assertEqual(resp.content.count(META), 1, path)
            self.assertIn('no-cache', resp.headers.get('cache-control', ''))
            etag = '"' + hashlib.sha256(resp.content).hexdigest() + '"'
            self.assertEqual(resp.headers.get('etag'), etag, path)
        os.environ['COMPILE_HINTS_ENABLED'] = '0'
        again, plain = server.lab_page()
        self.assertTrue(plain)
        self.assertEqual(again, PAGE)
        self.assertEqual(self.client.get('/').content, PAGE)

    def test_both_switches_keep_the_schematic_meta_first(self):
        os.environ['SCHEMATIC_MATCH_LAYOUT'] = '0'
        os.environ['COMPILE_HINTS_ENABLED'] = '1'
        body, plain = server.lab_page()
        self.assertFalse(plain)
        self.assertEqual(body.count(SCH), 1)
        self.assertEqual(body.count(META), 1)
        self.assertIn(b'<head>\n' + SCH + b'\n' + META, body)


if __name__ == '__main__':
    unittest.main()
