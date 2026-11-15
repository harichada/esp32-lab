"""Performance flags on the lab server. All default off.

HTML and /api (including a 401) are never gzipped. A precompressed sibling is
served only for js/css/svg/wasm/json when COMPRESS_ENABLED=1 and the client
accepts gzip. CACHE_VERSIONED=1 makes ?v= assets immutable and leaves an
unversioned asset as no-cache. DEFER_SCRIPTS=1 adds defer in source order
and leaves storage.js blocking.
"""
import asyncio
import gzip
import os
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

os.environ['SIM_PREWARM'] = '0'
os.environ['SIM_NETSTACK_WARM'] = '0'
os.environ.pop('COMPRESS_ENABLED', None)
os.environ.pop('CACHE_VERSIONED', None)
os.environ.pop('DEFER_SCRIPTS', None)
os.environ.pop('SCHEMATIC_MATCH_LAYOUT', None)
os.environ.pop('SIM_TOKEN', None)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import precompress
import server

WEB = Path(__file__).resolve().parents[1]
PAGE = (WEB / 'index.html').read_bytes()


def raw_get(path, headers=None, query=b''):
    status = {}
    hdrs = []
    chunks = []
    scope = {
        'type': 'http', 'asgi': {'version': '3.0', 'spec_version': '2.5'}, 'http_version': '1.1',
        'method': 'GET', 'scheme': 'http', 'path': path,
        'raw_path': path.encode(), 'query_string': query,
        'headers': headers or [(b'host', b'test')],
        'client': ('127.0.0.1', 5000), 'server': ('test', 80), 'root_path': '',
    }

    seen = {'body': False}

    async def receive():
        if seen['body']:
            return {'type': 'http.disconnect'}
        seen['body'] = True
        return {'type': 'http.request', 'body': b'', 'more_body': False}

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


def gzip_accept():
    return [(b'host', b'test'), (b'accept-encoding', b'gzip')]


class PerfServerTests(unittest.TestCase):
    def setUp(self):
        os.environ.pop('COMPRESS_ENABLED', None)
        os.environ.pop('CACHE_VERSIONED', None)
        os.environ.pop('DEFER_SCRIPTS', None)
        os.environ.pop('SCHEMATIC_MATCH_LAYOUT', None)
        os.environ.pop('CSP_REPORT_ENABLED', None)
        os.environ.pop('CSP_ENFORCE', None)
        os.environ.pop('JSSKETCH_WORKER', None)
        server.TOKEN = ''
        self.tmp = []

    def tearDown(self):
        server.TOKEN = ''
        os.environ.pop('COMPRESS_ENABLED', None)
        os.environ.pop('CACHE_VERSIONED', None)
        os.environ.pop('DEFER_SCRIPTS', None)
        os.environ.pop('CSP_REPORT_ENABLED', None)
        os.environ.pop('CSP_ENFORCE', None)
        os.environ.pop('JSSKETCH_WORKER', None)
        os.environ.pop('CACHE_VERSIONED', None)
        for path in self.tmp:
            path.unlink(missing_ok=True)

    def _probe(self, name, body):
        path = WEB / 'js' / name
        path.write_bytes(body)
        self.tmp.append(path)
        gz_path = Path(str(path) + '.gz')
        gz_path.write_bytes(gzip.compress(body, compresslevel=9, mtime=0))
        self.tmp.append(gz_path)
        return path, gz_path

    def test_flags_default_off_and_page_bytes_match_the_file(self):
        self.assertFalse(server.compress_enabled({}))
        self.assertFalse(server.cache_versioned_enabled({}))
        self.assertFalse(server.defer_scripts_enabled({}))
        self.assertFalse(server.defer_scripts_enabled({}, {'defer': '0'}))
        self.assertTrue(server.defer_scripts_enabled({}, {'defer': '1'}))
        self.assertTrue(server.defer_scripts_enabled({'DEFER_SCRIPTS': '1'}))
        body, plain = server.lab_page()
        self.assertTrue(plain)
        self.assertEqual(body, PAGE)
        self.assertIsNone(re.search(br'<script[^>]*\sdefer[\s>]', body))
        code, headers, payload = raw_get('/')
        self.assertEqual(code, 200)
        self.assertEqual(payload, PAGE)
        self.assertEqual(headers.get('cache-control'), 'no-cache, must-revalidate')
        self.assertNotIn('content-encoding', headers)

    def test_defer_keeps_storage_blocking_and_source_order(self):
        os.environ['DEFER_SCRIPTS'] = '1'
        body, plain = server.lab_page()
        self.assertFalse(plain)
        text = body.decode('utf-8')
        self.assertNotRegex(text, r'storage\.js\?v=\d+" defer')
        self.assertRegex(text, r'<script src="js/app\.js\?v=86" defer></script>')
        self.assertRegex(text, r'<script src="js/mobile\.js\?v=80" defer></script>')
        self.assertNotRegex(text, r'boot-theme\.js\?v=\d+" defer')
        self.assertNotRegex(text, r'boot-view\.js\?v=\d+" defer')
        self.assertNotRegex(text, r'force2d\.js\?v=\d+" defer')
        self.assertNotRegex(text, r'<script[^>]*\sasync[\s>]')
        srcs = re.findall(r'<script\s[^>]*src="([^"]+)"', text)
        self.assertTrue(srcs[0].startswith('js/storage.js'))
        self.assertLess(srcs.index(next(s for s in srcs if 'solver.js' in s)), srcs.index(next(s for s in srcs if '/app.js' in s or s.startswith('js/app.js'))))
        self.assertLess(srcs.index(next(s for s in srcs if s.startswith('js/app.js'))), srcs.index(next(s for s in srcs if s.startswith('js/mobile.js'))))
        os.environ.pop('DEFER_SCRIPTS', None)
        via_query, plain_q = server.lab_page(query={'defer': '1'})
        self.assertFalse(plain_q)
        self.assertIn(b'<script src="js/solver.js?v=40" defer></script>', via_query)
        off, plain_off = server.lab_page(query={'defer': '0'})
        self.assertTrue(plain_off)
        self.assertEqual(off, PAGE)

    def test_html_and_api_and_auth_are_not_compressed(self):
        os.environ['COMPRESS_ENABLED'] = '1'
        decoy = WEB / 'index.html.gz'
        decoy.write_bytes(gzip.compress(b'<html>secret</html>', mtime=0))
        self.tmp.append(decoy)
        for path in ('/', '/index.html'):
            code, headers, payload = raw_get(path, gzip_accept())
            self.assertEqual(code, 200, path)
            self.assertNotIn('content-encoding', headers, path)
            self.assertFalse(payload.startswith(b'\x1f\x8b'), path)
            self.assertIn(b'<html', payload, path)
        code, headers, payload = raw_get('/api/health', gzip_accept())
        self.assertEqual(code, 200)
        self.assertNotIn('content-encoding', headers)
        self.assertTrue(payload.startswith(b'{'))
        self.assertNotIn('immutable', headers.get('cache-control', ''))
        server.TOKEN = 's3cret'
        code, headers, payload = raw_get('/api/health', gzip_accept())
        self.assertEqual(code, 401)
        self.assertNotIn('content-encoding', headers)
        self.assertEqual(payload, b'unauthorized')
        self.assertFalse(payload.startswith(b'\x1f\x8b'))
        self.assertNotIn('immutable', headers.get('cache-control', ''))

    def test_precompressed_static_only_and_unversioned_is_not_immutable(self):
        body = b'/* probe */\n' * 80
        self._probe('_gzprobe.js', body)
        svg = b'<svg xmlns="http://www.w3.org/2000/svg">' + b'<g/>' * 40 + b'</svg>'
        svg_path = WEB / '_gzprobe.svg'
        svg_path.write_bytes(svg)
        self.tmp.append(svg_path)
        self.tmp.append(Path(str(svg_path) + '.gz'))
        Path(str(svg_path) + '.gz').write_bytes(gzip.compress(svg, compresslevel=9, mtime=0))
        os.environ['COMPRESS_ENABLED'] = '0'
        code, headers, payload = raw_get('/js/_gzprobe.js', gzip_accept())
        self.assertEqual(code, 200)
        self.assertEqual(payload, body)
        self.assertNotIn('content-encoding', headers)
        self.assertNotIn('immutable', headers.get('cache-control', ''))
        os.environ['COMPRESS_ENABLED'] = '1'
        os.environ['CACHE_VERSIONED'] = '1'
        code, headers, payload = raw_get('/js/_gzprobe.js', gzip_accept())
        self.assertEqual(code, 200)
        self.assertEqual(headers.get('content-encoding'), 'gzip')
        self.assertIn('accept-encoding', headers.get('vary', '').lower())
        self.assertEqual(gzip.decompress(payload), body)
        self.assertEqual(headers.get('cache-control'), 'no-cache')
        self.assertNotIn('immutable', headers.get('cache-control', ''))
        code, headers, payload = raw_get('/js/_gzprobe.js', gzip_accept(), query=b'v=1')
        self.assertEqual(headers.get('content-encoding'), 'gzip')
        self.assertEqual(headers.get('cache-control'), 'public, max-age=31536000, immutable')
        self.assertEqual(gzip.decompress(payload), body)
        code, headers, payload = raw_get('/js/_gzprobe.js', [(b'host', b'test'), (b'accept-encoding', b'identity')])
        self.assertNotIn('content-encoding', headers)
        self.assertEqual(payload, body)
        self.assertIn('accept-encoding', headers.get('vary', '').lower())
        code, headers, payload = raw_get('/_gzprobe.svg', gzip_accept(), query=b'v=2')
        self.assertEqual(headers.get('content-encoding'), 'gzip')
        self.assertEqual(gzip.decompress(payload), svg)
        self.assertIn('immutable', headers.get('cache-control', ''))
        code, headers, _payload = raw_get('/_gzprobe.svg', [(b'host', b'test')])
        self.assertEqual(headers.get('cache-control'), 'no-cache')
        self.assertNotIn('immutable', headers.get('cache-control', ''))
        os.environ['CACHE_VERSIONED'] = '0'
        code, headers, _payload = raw_get('/js/view3d.js', [(b'host', b'test')], query=b'v=56')
        self.assertEqual(headers.get('cache-control'), 'no-cache, must-revalidate')
        os.environ['CACHE_VERSIONED'] = '1'
        code, headers, _payload = raw_get('/', gzip_accept())
        self.assertEqual(headers.get('cache-control'), 'no-cache')
        self.assertNotIn('must-revalidate', headers.get('cache-control', ''))
        self.assertNotIn('content-encoding', headers)

    def test_precompress_script_skips_html(self):
        root = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        (root / 'index.html').write_text('<html></html>', encoding='utf-8')
        (root / 'api').mkdir()
        (root / 'api' / 'health.json').write_text('{"ok":true}', encoding='utf-8')
        js = root / 'app.js'
        js.write_bytes(b'var x = 1;\n' * 40)
        (root / 'tests').mkdir()
        (root / 'tests' / 'skip.js').write_bytes(b'var y = 1;\n' * 40)
        n = precompress.write_gz(root)
        self.assertEqual(n, 1)
        self.assertTrue(Path(str(js) + '.gz').is_file())
        self.assertFalse((root / 'index.html.gz').exists())
        self.assertFalse((root / 'api' / 'health.json.gz').exists())
        self.assertFalse((root / 'tests' / 'skip.js.gz').exists())
        self.assertEqual(gzip.decompress(Path(str(js) + '.gz').read_bytes()), js.read_bytes())

    def test_html_revalidates_with_304_and_api_does_not(self):
        code, headers, payload = raw_get('/')
        self.assertEqual(code, 200)
        self.assertIn('no-cache', headers.get('cache-control', ''))
        etag = headers.get('etag')
        modified = headers.get('last-modified')
        self.assertTrue(etag and etag.startswith('"'))
        self.assertTrue(modified)
        code, headers, payload = raw_get('/', [(b'host', b'test'), (b'if-none-match', etag.encode())])
        self.assertEqual(code, 304)
        self.assertEqual(payload, b'')
        self.assertEqual(headers.get('etag'), etag)
        self.assertIn('no-cache', headers.get('cache-control', ''))
        code, headers, payload = raw_get('/', [(b'host', b'test'), (b'if-modified-since', modified.encode())])
        self.assertEqual(code, 304)
        self.assertEqual(payload, b'')
        code, headers, payload = raw_get('/', [(b'host', b'test'), (b'if-none-match', b'"nope"'), (b'if-modified-since', modified.encode())])
        self.assertEqual(code, 200)
        self.assertTrue(payload.startswith(b'<!doctype html>'))
        os.environ['CACHE_VERSIONED'] = '1'
        code, headers, _payload = raw_get('/')
        self.assertEqual(headers.get('cache-control'), 'no-cache')
        os.environ.pop('CACHE_VERSIONED', None)
        code, headers, payload = raw_get('/api/health', [(b'host', b'test'), (b'if-none-match', b'*'), (b'if-modified-since', b'Tue, 15 Nov 1994 12:45:26 GMT')])
        self.assertEqual(code, 200)
        self.assertNotEqual(code, 304)
        self.assertIn(b'"ok"', payload)


if __name__ == '__main__':
    unittest.main()
