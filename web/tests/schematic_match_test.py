"""SCHEMATIC_MATCH_LAYOUT is a site-wide switch on the lab page itself.

Default (unset or 1) serves index.html unchanged. 0 adds one meta tag to
/ and /index.html. No extra request.
"""
import os
import sys
import unittest
from pathlib import Path

os.environ['SIM_PREWARM'] = '0'
os.environ['SIM_NETSTACK_WARM'] = '0'
os.environ.pop('SCHEMATIC_MATCH_LAYOUT', None)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import server
from starlette.testclient import TestClient

WEB = Path(__file__).resolve().parents[1]
PAGE = (WEB / 'index.html').read_bytes()
META = b'<meta name="schmatch" content="0">'


class SchematicMatchEnvTests(unittest.TestCase):
    def setUp(self):
        os.environ.pop('SCHEMATIC_MATCH_LAYOUT', None)
        self.client = TestClient(server.app)

    def tearDown(self):
        os.environ.pop('SCHEMATIC_MATCH_LAYOUT', None)

    def test_default_and_one_serve_the_file_unchanged(self):
        self.assertTrue(server.schematic_match_enabled({}))
        self.assertTrue(server.schematic_match_enabled({'SCHEMATIC_MATCH_LAYOUT': '1'}))
        self.assertTrue(server.schematic_match_enabled({'SCHEMATIC_MATCH_LAYOUT': ' 1 '}))
        self.assertTrue(server.schematic_match_enabled({'SCHEMATIC_MATCH_LAYOUT': 'yes'}))
        self.assertFalse(server.schematic_match_enabled({'SCHEMATIC_MATCH_LAYOUT': '0'}))
        self.assertFalse(server.schematic_match_enabled({'SCHEMATIC_MATCH_LAYOUT': ' 0 '}))
        for value in (None, '1', 'yes', ''):
            if value is None:
                os.environ.pop('SCHEMATIC_MATCH_LAYOUT', None)
            else:
                os.environ['SCHEMATIC_MATCH_LAYOUT'] = value
            body, plain = server.lab_page()
            self.assertTrue(plain)
            self.assertEqual(body, PAGE)
            self.assertNotIn(META, body)
            for path in ('/', '/index.html'):
                resp = self.client.get(path)
                self.assertEqual(resp.status_code, 200, path)
                self.assertEqual(resp.content, PAGE, path)
                self.assertNotIn(META, resp.content)

    def test_zero_is_in_the_page_for_everyone(self):
        os.environ['SCHEMATIC_MATCH_LAYOUT'] = '0'
        body, plain = server.lab_page()
        self.assertFalse(plain)
        self.assertEqual(body.count(META), 1)
        self.assertIn(b'<head>\n' + META, body)
        self.assertIn(b'schematic.js?v=', body)
        self.assertIn(b'Circuit Lab', body)
        for path in ('/', '/index.html'):
            resp = self.client.get(path)
            self.assertEqual(resp.status_code, 200, path)
            self.assertEqual(resp.content.count(META), 1, path)
            self.assertIn('no-cache', resp.headers.get('cache-control', ''))
        os.environ['SCHEMATIC_MATCH_LAYOUT'] = '1'
        again, plain = server.lab_page()
        self.assertTrue(plain)
        self.assertEqual(again, PAGE)
        self.assertEqual(self.client.get('/').content, PAGE)
        asset = self.client.get('/js/schematic.js')
        self.assertEqual(asset.status_code, 200)
        self.assertEqual(asset.content, (WEB / 'js' / 'schematic.js').read_bytes())
        self.assertNotIn(b'<head>', asset.content)


if __name__ == '__main__':
    unittest.main()
