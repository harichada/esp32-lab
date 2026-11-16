"""STATUS_STRIP_ENABLED defaults off and only then leaves the lab page untouched.

1, true, yes, or on adds <meta name="statusstrip" content="1"> inside <head>.
Any other value, including unset, serves index.html bytes unchanged.
"""
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

WEB = Path(__file__).resolve().parents[1]
PAGE = (WEB / 'index.html').read_bytes()
META = b'<meta name="statusstrip" content="1">'
HINTS = b'<meta name="compilehints" content="1">'
SCH = b'<meta name="schmatch" content="0">'


class StatusStripEnvTests(unittest.TestCase):
    def setUp(self):
        os.environ.pop('COMPILE_HINTS_ENABLED', None)
        os.environ.pop('STATUS_STRIP_ENABLED', None)
        os.environ.pop('SCHEMATIC_MATCH_LAYOUT', None)

    def test_default_is_the_file(self):
        self.assertFalse(server.status_strip_enabled())
        body, plain = server.lab_page()
        self.assertTrue(plain)
        self.assertEqual(body, PAGE)
        self.assertNotIn(META, body)

    def test_off_values_leave_the_file(self):
        for value in ('', '0', 'false', 'no', 'off', '2', 'yes please'):
            os.environ['STATUS_STRIP_ENABLED'] = value
            body, plain = server.lab_page()
            self.assertTrue(plain, value)
            self.assertEqual(body, PAGE)

    def test_on_values_inject_one_meta(self):
        for value in ('1', 'true', 'TRUE', 'yes', 'on'):
            os.environ['STATUS_STRIP_ENABLED'] = value
            body, plain = server.lab_page()
            self.assertFalse(plain, value)
            self.assertEqual(body.count(META), 1)
            self.assertIn(b'<head>\n' + META, body)
            self.assertNotIn(HINTS, body)

    def test_strip_with_the_other_switches(self):
        os.environ['SCHEMATIC_MATCH_LAYOUT'] = '0'
        os.environ['COMPILE_HINTS_ENABLED'] = '1'
        os.environ['STATUS_STRIP_ENABLED'] = '1'
        body, plain = server.lab_page()
        self.assertFalse(plain)
        self.assertIn(b'<head>\n' + SCH + b'\n' + HINTS + b'\n' + META, body)
        self.assertEqual(body.count(META), 1)

    def test_page_keeps_app_at_93_and_loads_the_strip_only_when_on(self):
        html = PAGE.decode('utf-8')
        self.assertIn('js/app.js?v=105', html)
        self.assertNotIn('js/statusstrip.js', html)
        self.assertNotIn('js/compilehints.js', html)
        self.assertNotIn('js/app.js?v=84', html)
        for banned in ('86', '87', '88', '89', '90', '91', '92'):
            self.assertNotIn('js/app.js?v=%s' % banned, html)
        os.environ['STATUS_STRIP_ENABLED'] = '1'
        body, plain = server.lab_page()
        self.assertFalse(plain)
        self.assertIn(b'js/statusstrip.js?v=7', body)
        self.assertNotIn(b'js/compilehints.js', body)
        self.assertNotIn('js/projects.js?v=48', html)
        self.assertNotIn('js/schematic.js?v=71', html)


if __name__ == '__main__':
    unittest.main()
