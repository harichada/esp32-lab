"""POST /api/csp-report. Off unless CSP_REPORT_ENABLED=1.

The log line is JSON with the directive, the blocked URL and the document
path. Query strings, fragments, cookies and IP addresses are not logged.
"""
import asyncio
import json
import os
import sys
import unittest
from pathlib import Path

os.environ['SIM_PREWARM'] = '0'
os.environ['SIM_NETSTACK_WARM'] = '0'
os.environ.pop('SIM_TOKEN', None)
os.environ.pop('CSP_REPORT_ENABLED', None)
os.environ.pop('CSP_ENFORCE', None)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import server


def raw(method, path, body=b'', headers=None, client=('127.0.0.1', 5000)):
    status = {}
    hdrs = []
    chunks = []
    scope = {
        'type': 'http', 'asgi': {'version': '3.0', 'spec_version': '2.5'}, 'http_version': '1.1',
        'method': method, 'scheme': 'http', 'path': path,
        'raw_path': path.encode(), 'query_string': b'',
        'headers': headers or [(b'host', b'test')],
        'client': client, 'server': ('test', 80), 'root_path': '',
    }
    seen = {'body': False}

    async def receive():
        if seen['body']:
            return {'type': 'http.disconnect'}
        seen['body'] = True
        return {'type': 'http.request', 'body': body, 'more_body': False}

    async def send(message):
        if message['type'] == 'http.response.start':
            status['code'] = message['status']
            hdrs.extend(message['headers'])
        elif message['type'] == 'http.response.body':
            chunks.append(message.get('body') or b'')

    asyncio.run(server.app(scope, receive, send))
    decoded = {}
    for key, value in hdrs:
        decoded[key.decode().lower()] = value.decode()
    return status.get('code'), decoded, b''.join(chunks)


REPORT = {
    'csp-report': {
        'document-uri': 'https://lab.example/index.html?token=supersecretquery#fragsecret',
        'effective-directive': 'script-src',
        'violated-directive': 'script-src',
        'blocked-uri': 'https://evil.example/app.js?token=supersecretquery#fragsecret',
        'original-policy': 'policy-secret-do-not-log',
        'cookie': 'supersecretcookie',
    }
}


def _post(body, content_type='application/csp-report', client=('203.0.113.50', 9), content_length=None):
    raw_headers = [
        (b'host', b'test'),
        (b'content-type', content_type.encode()),
        (b'content-length', str(len(body) if content_length is None else content_length).encode()),
        (b'cookie', b'session=supersecretcookie'),
    ]
    return raw('POST', '/api/csp-report', body, raw_headers, client)


class CspReportTests(unittest.TestCase):
    def setUp(self):
        os.environ.pop('CSP_REPORT_ENABLED', None)
        os.environ.pop('CSP_ENFORCE', None)
        os.environ.pop('CSP_REPORT_PER_IP', None)
        os.environ.pop('CSP_REPORT_GLOBAL', None)
        server.TOKEN = ''
        server.reset_csp_reports()

    def tearDown(self):
        os.environ.pop('CSP_REPORT_ENABLED', None)
        os.environ.pop('CSP_ENFORCE', None)
        os.environ.pop('CSP_REPORT_PER_IP', None)
        os.environ.pop('CSP_REPORT_GLOBAL', None)
        server.reset_csp_reports()

    def test_flag_off_is_404(self):
        self.assertFalse(server.csp_report_enabled({}))
        code, _headers, _body = _post(json.dumps(REPORT).encode())
        self.assertEqual(code, 404)

    def test_strips_urls_and_logs_one_line_without_secrets(self):
        os.environ['CSP_REPORT_ENABLED'] = '1'
        body = json.dumps(REPORT).encode()
        with self.assertLogs('esp32lab.csp', level='INFO') as caught:
            code, _headers, payload = _post(body)
        self.assertEqual(code, 204)
        self.assertEqual(payload, b'')
        self.assertEqual(len(caught.output), 1)
        text = caught.output[0].split(':', 2)[2]
        logged = json.loads(text)
        self.assertEqual(logged, {
            'kind': 'csp-report',
            'directive': 'script-src',
            'blocked': 'https://evil.example/app.js',
            'document': '/index.html',
        })
        self.assertNotIn('supersecret', text)
        self.assertNotIn('203.0.113.50', text)
        self.assertNotIn('cookie', text.lower())
        self.assertNotIn('policy-secret', text)
        self.assertNotIn('?', logged['blocked'])
        self.assertNotIn('#', logged['blocked'])
        self.assertNotIn('?', logged['document'])

    def test_reports_json_and_charset_and_rejects_other_types(self):
        os.environ['CSP_REPORT_ENABLED'] = '1'
        batch = json.dumps([{
            'type': 'csp-violation',
            'url': 'https://lab.example/lab?x=1#y',
            'body': {
                'documentURL': 'https://lab.example/lab?x=1#y',
                'effectiveDirective': 'script-src-elem',
                'blockedURL': 'inline',
            },
        }]).encode()
        with self.assertLogs('esp32lab.csp', level='INFO') as caught:
            code, _headers, _payload = _post(batch, 'application/reports+json; charset=utf-8')
        self.assertEqual(code, 204)
        logged = json.loads(caught.output[0].split(':', 2)[2])
        self.assertEqual(logged['directive'], 'script-src-elem')
        self.assertEqual(logged['blocked'], 'inline')
        self.assertEqual(logged['document'], '/lab')
        code, _headers, _payload = _post(b'{}', 'application/json')
        self.assertEqual(code, 415)
        code, _headers, _payload = _post(b'{}', 'text/plain')
        self.assertEqual(code, 415)

    def test_body_cap_is_8kb(self):
        os.environ['CSP_REPORT_ENABLED'] = '1'
        skeleton = json.dumps({'csp-report': {'effective-directive': 'style-src', 'blocked-uri': 'inline', 'document-uri': 'https://lab.example/', 'pad': ''}}).encode()
        need = 8192 - len(skeleton)
        exact = skeleton.replace(b'"pad": ""', b'"pad": "' + (b'p' * need) + b'"', 1)
        self.assertEqual(len(exact), 8192)
        with self.assertLogs('esp32lab.csp', level='INFO'):
            code, _headers, _payload = _post(exact)
        self.assertEqual(code, 204)
        with self.assertNoLogs('esp32lab.csp', level='INFO'):
            code, _headers, _payload = _post(exact + b' ')
        self.assertEqual(code, 413)
        code, _headers, _payload = _post(b'{}', content_length=8193)
        self.assertEqual(code, 413)

    def test_per_ip_and_global_caps_return_429(self):
        os.environ['CSP_REPORT_ENABLED'] = '1'
        os.environ['CSP_REPORT_PER_IP'] = '1'
        os.environ['CSP_REPORT_GLOBAL'] = '10'
        body = json.dumps(REPORT).encode()
        with self.assertLogs('esp32lab.csp', level='INFO'):
            code, _headers, _payload = _post(body, client=('203.0.113.10', 1))
        self.assertEqual(code, 204)
        with self.assertNoLogs('esp32lab.csp', level='INFO'):
            code, _headers, _payload = _post(body, client=('203.0.113.10', 1))
        self.assertEqual(code, 429)
        with self.assertLogs('esp32lab.csp', level='INFO'):
            code, _headers, _payload = _post(body, client=('203.0.113.11', 1))
        self.assertEqual(code, 204)
        server.reset_csp_reports()
        os.environ['CSP_REPORT_PER_IP'] = '10'
        os.environ['CSP_REPORT_GLOBAL'] = '2'
        with self.assertLogs('esp32lab.csp', level='INFO'):
            self.assertEqual(_post(body, client=('198.51.100.1', 1))[0], 204)
            self.assertEqual(_post(body, client=('198.51.100.2', 1))[0], 204)
        with self.assertNoLogs('esp32lab.csp', level='INFO'):
            self.assertEqual(_post(body, client=('198.51.100.3', 1))[0], 429)

    def test_page_sends_report_only_until_enforce(self):
        code, headers, _payload = raw('GET', '/')
        self.assertEqual(code, 200)
        self.assertNotIn('content-security-policy', headers)
        self.assertNotIn('content-security-policy-report-only', headers)
        self.assertNotIn('reporting-endpoints', headers)
        os.environ['CSP_REPORT_ENABLED'] = '1'
        code, headers, _payload = raw('GET', '/')
        policy = headers.get('content-security-policy-report-only', '')
        self.assertIn('report-uri /api/csp-report', policy)
        self.assertIn('report-to csp', policy)
        self.assertNotIn('unsafe-eval', policy)
        script = policy.split('style-src', 1)[0]
        self.assertNotIn('unsafe-inline', script)
        self.assertNotIn('content-security-policy', {k: v for k, v in headers.items() if k != 'content-security-policy-report-only'})
        self.assertEqual(headers.get('reporting-endpoints'), 'csp="/api/csp-report"')
        self.assertIn('/api/csp-report', headers.get('report-to', ''))
        os.environ['CSP_ENFORCE'] = '1'
        _code, headers, _payload = raw('GET', '/')
        self.assertIn('report-uri /api/csp-report', headers.get('content-security-policy', ''))
        self.assertNotIn('content-security-policy-report-only', headers)

    def test_malformed_json_is_400(self):
        os.environ['CSP_REPORT_ENABLED'] = '1'
        with self.assertNoLogs('esp32lab.csp', level='INFO'):
            code, _headers, _payload = _post(b'{')
        self.assertEqual(code, 400)


if __name__ == '__main__':
    unittest.main()
