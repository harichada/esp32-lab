"""UI2 defaults off. 1, true, yes, or on adds one meta tag. Anything else leaves index.html unchanged."""
import os
import sys
import unittest
from pathlib import Path

os.environ['SIM_PREWARM'] = '0'
os.environ['SIM_NETSTACK_WARM'] = '0'
os.environ.pop('UI2', None)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import server

WEB = Path(__file__).resolve().parents[1]
PAGE = (WEB / 'index.html').read_bytes()
META = b'<meta name="ui2" content="1">'


class Ui2FlagTests(unittest.TestCase):
    def tearDown(self):
        os.environ.pop('UI2', None)

    def test_default_is_the_file(self):
        self.assertFalse(server.ui2_enabled())
        body, plain = server.lab_page()
        self.assertTrue(plain)
        self.assertEqual(body, PAGE)
        self.assertNotIn(META, body)

    def test_off_values_leave_the_file(self):
        for value in ('', '0', 'false', 'no', 'off', '2'):
            os.environ['UI2'] = value
            body, plain = server.lab_page()
            self.assertTrue(plain, value)
            self.assertEqual(body, PAGE)
            self.assertNotIn(META, body)

    def test_on_values_inject_one_meta(self):
        for value in ('1', 'true', 'TRUE', 'yes', 'on'):
            os.environ['UI2'] = value
            body, plain = server.lab_page()
            self.assertFalse(plain, value)
            self.assertEqual(body.count(META), 1)
            self.assertIn(b'<head>\n' + META, body)


if __name__ == '__main__':
    unittest.main()
