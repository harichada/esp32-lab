#!/usr/bin/env python3
"""The uptime workflow is valid YAML and matches the fallback contract.

Needs PyYAML (`pip install pyyaml`). `web/setup.sh` installs it with the server packages.
The alert tests run the embedded script against a local HTTP server and a fake `gh`.

    python3 -m unittest tests/uptime_workflow_test.py
"""
import ast
import json
import os
import re
import stat
import subprocess
import textwrap
import threading
import unittest
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
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
            'actions': 'read',
            'issues': 'write',
        })
        self.assertNotIn('contents', doc['permissions'])
        self.assertNotIn('permissions', doc['jobs']['check'])
        self.assertEqual(int(doc['env']['UPTIME_FAILURE_WINDOW_MIN']), 20)

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
        self.assertIn('GH_TOKEN', script)
        self.assertIn('run_started_at', script)
        self.assertIn('UPTIME_FAILURE_WINDOW_MIN', script)
        self.assertIn('action=unknown', script)
        self.assertNotIn('fetch_runs_public', script)
        self.assertNotIn('urllib.request', script)
        self.assertNotIn('api.github.com', text)


class _ProbeHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.split('?', 1)[0].rstrip('/') == '/api/health':
            body = b'{"ok": false}'
        else:
            body = MARKER.encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        return


FAKE_GH = r"""
import json
import os
import sys

log = os.environ['GH_LOG']
args = sys.argv[1:]
with open(log, 'a', encoding='utf-8') as fh:
    fh.write(json.dumps({
        'args': args,
        'has_token': bool(os.environ.get('GH_TOKEN')),
    }) + '\n')
if args[:1] == ['api']:
    if not os.environ.get('GH_TOKEN'):
        sys.stderr.write('GH_TOKEN missing\n')
        sys.exit(1)
    if os.environ.get('GH_API_MODE') == 'fail':
        sys.stderr.write('HTTP 500 lookup exploded\n')
        sys.exit(1)
    sys.stdout.write(os.environ.get('GH_RUNS_JSON', ''))
    sys.exit(0)
if args[:2] == ['issue', 'list']:
    sys.stdout.write('[]')
    sys.exit(0)
if args[:2] == ['label', 'create']:
    sys.exit(0)
if args[:2] == ['issue', 'create']:
    sys.stdout.write('https://example.test/issues/1\n')
    sys.exit(0)
sys.stderr.write('unexpected gh %s\n' % ' '.join(args))
sys.exit(1)
"""


def _stamp(minutes_ago):
    when = datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)
    return when.strftime('%Y-%m-%dT%H:%M:%SZ')


def _runs_json(minutes_ago, conclusion='failure'):
    return json.dumps({
        'workflow_runs': [{
            'id': 42,
            'event': 'schedule',
            'status': 'completed',
            'conclusion': conclusion,
            'run_started_at': _stamp(minutes_ago),
            'html_url': 'https://example.test/runs/42',
        }],
    })


class UptimeAlertTests(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), _ProbeHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        host, port = self.server.server_address
        self.health = 'http://%s:%s/api/health' % (host, port)
        self.home = 'http://%s:%s/' % (host, port)
        self.work = Path(os.environ.get('TMPDIR', '/tmp')) / ('uptime-' + self.id().replace('.', '-'))
        self.work.mkdir(parents=True, exist_ok=True)
        self.bin = self.work / 'bin'
        self.bin.mkdir()
        gh = self.bin / 'gh'
        gh.write_text('#!/usr/bin/env python3\n' + FAKE_GH, encoding='utf-8')
        gh.chmod(gh.stat().st_mode | stat.S_IEXEC)
        self.log = self.work / 'gh.log'
        self.log.write_text('', encoding='utf-8')
        self.script = self.work / 'probe.py'
        self.script.write_text(embedded_script(WORKFLOW.read_text(encoding='utf-8')), encoding='utf-8')

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def _run(self, extra):
        env = os.environ.copy()
        env['PATH'] = str(self.bin) + os.pathsep + env.get('PATH', '')
        env.update({
            'UPTIME_TARGETS': self.health + '\n' + self.home + '\n',
            'UPTIME_HOME_MARKER': MARKER,
            'UPTIME_FAILURE_WINDOW_MIN': '20',
            'GH_TOKEN': 'job-token',
            'GH_REPO': 'example/esp32-lab',
            'GH_PROMPT_DISABLED': '1',
            'GH_PAGER': 'cat',
            'RUN_ID': '99',
            'RUN_URL': 'https://example.test/runs/99',
            'GH_LOG': str(self.log),
        })
        env.update(extra)
        proc = subprocess.run(
            ['python3', str(self.script)],
            capture_output=True, text=True, env=env, timeout=60,
        )
        calls = []
        if self.log.exists():
            calls = [json.loads(line) for line in self.log.read_text(encoding='utf-8').splitlines() if line]
        return proc, calls

    def _created(self, calls):
        return [call for call in calls if call['args'][:2] == ['issue', 'create']]

    def test_old_failure_plus_blip_opens_nothing(self):
        proc, calls = self._run({'GH_RUNS_JSON': _runs_json(180), 'GH_API_MODE': 'ok'})
        self.assertNotEqual(proc.returncode, 0, proc.stderr)
        self.assertIn('state=failure action=hold', proc.stdout)
        self.assertIn('outside the 20 minute window', proc.stdout)
        self.assertNotIn('action=open', proc.stdout)
        self.assertNotIn('action=unknown', proc.stdout)
        self.assertEqual(self._created(calls), [])
        self.assertTrue(any(call['args'][:1] == ['api'] and call['has_token'] for call in calls))

    def test_recent_failure_plus_failure_opens_one_issue(self):
        proc, calls = self._run({'GH_RUNS_JSON': _runs_json(5), 'GH_API_MODE': 'ok'})
        self.assertNotEqual(proc.returncode, 0, proc.stderr)
        self.assertIn('state=failure action=open', proc.stdout)
        created = self._created(calls)
        self.assertEqual(len(created), 1)
        self.assertIn('Site down: %s' % self.health, created[0]['args'])

    def test_failed_history_lookup_is_unknown(self):
        proc, calls = self._run({'GH_API_MODE': 'fail'})
        self.assertNotEqual(proc.returncode, 0, proc.stdout)
        self.assertIn('::error::workflow runs lookup failed; history is unknown', proc.stderr)
        self.assertIn('HTTP 500 lookup exploded', proc.stderr)
        self.assertIn('state=failure action=unknown', proc.stdout)
        self.assertNotIn('action=hold', proc.stdout)
        self.assertNotIn('conclusion=success', proc.stdout)
        self.assertEqual(self._created(calls), [])
        api = [call for call in calls if call['args'][:1] == ['api']]
        self.assertEqual(len(api), 1)
        self.assertTrue(api[0]['has_token'])


if __name__ == '__main__':
    unittest.main()
