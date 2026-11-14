#!/usr/bin/env python3
"""The uptime workflow is valid YAML and matches the fallback contract.

    python3 -m unittest tests/uptime_workflow_test.py
"""
import ast
import re
import textwrap
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / '.github' / 'workflows' / 'uptime.yml'
INDEX = ROOT / 'web' / 'index.html'
OPS = ROOT / 'docs' / 'ops.md'

MARKER = 'ESP32 Circuit Lab — real-firmware ESP32 + electronics simulator'
TARGETS = [
    'https://esp32lab.duckdns.org/api/health',
    'https://esp32lab.duckdns.org/',
    'http://129.158.200.25/api/health',
    'http://129.158.200.25/',
]


def load_workflow():
    text = WORKFLOW.read_text(encoding='utf-8')
    # PyYAML 1.1 treats a bare `on` key as boolean true. Actions does not.
    doc = yaml.safe_load(text)
    if not isinstance(doc, dict):
        raise AssertionError('workflow did not parse to a mapping')
    return text, doc


def trigger_of(doc):
    if 'on' in doc:
        return doc['on']
    if True in doc:
        return doc[True]
    raise AssertionError('workflow has no on: trigger')


def embedded_script(text):
    match = re.search(r"python3 - << 'PY'\n(.*?)\n[ \t]*PY\s*\Z", text, re.S)
    if not match:
        raise AssertionError('embedded probe script not found')
    return textwrap.dedent(match.group(1))


class UptimeWorkflowTests(unittest.TestCase):
    def test_schedule_permissions_and_targets(self):
        text, doc = load_workflow()
        trigger = trigger_of(doc)
        self.assertIn('workflow_dispatch', trigger)
        schedule = trigger['schedule']
        self.assertIsInstance(schedule, list)
        self.assertEqual([item['cron'] for item in schedule], ['*/5 * * * *'])

        self.assertEqual(doc['permissions'], {
            'contents': 'read',
            'issues': 'write',
        })
        self.assertNotIn('permissions', doc['jobs']['check'])

        listed = doc['env']['UPTIME_TARGETS'].split()
        self.assertEqual(listed, TARGETS)
        for url in TARGETS:
            self.assertIn(url, text)

        self.assertNotIn('secrets.', text)

    def test_kill_switch_and_marker(self):
        text, doc = load_workflow()
        job = doc['jobs']['check']
        condition = job['if'].replace('"', "'")
        self.assertIn("vars.UPTIME_CHECK_ENABLED != '0'", condition)
        self.assertEqual(doc['env']['UPTIME_HOME_MARKER'], MARKER)
        self.assertIn(MARKER, INDEX.read_text(encoding='utf-8'))
        ops = OPS.read_text(encoding='utf-8')
        self.assertIn(MARKER, ops)
        self.assertIn('UPTIME_CHECK_ENABLED', ops)
        self.assertIn('UptimeRobot', ops)
        for url in TARGETS:
            self.assertIn(url, ops)

    def test_curl_contract_and_script_parses(self):
        text, _doc = load_workflow()
        script = embedded_script(text)
        ast.parse(script)
        self.assertIn("'--connect-timeout', '10'", script)
        self.assertIn("'--max-time', '20'", script)
        self.assertIn("'--retry', '2'", script)
        self.assertIn("'--request', 'GET'", script)
        self.assertIn('for url in urls:', script)
        self.assertNotIn('/api/compile', text)
        self.assertNotIn('--data', script)
        self.assertNotIn("'POST'", script)
        self.assertNotIn('--location', script)
        self.assertIn('Site down:', script)
        self.assertIn("'Recovered'", script)


if __name__ == '__main__':
    unittest.main()
