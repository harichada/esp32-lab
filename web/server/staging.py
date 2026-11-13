"""Staging flags and the /staging/ pass-through.

Off unless the environment says otherwise, so a live process keeps its current
responses. HTTP forwarding uses asyncio streams (stdlib). WebSocket forwarding
uses the ``websockets`` package already installed with uvicorn. No new dependency.

SIM_STAGING           default 0. 1 adds noindex, robots.txt, and the page flag.
SIM_ACCESS_TOKEN      default empty (off). Cookie cl_stage, constant-time compare.
SIM_STAGING_UPSTREAM  default empty (off). Only http://127.0.0.1:<port>.
SIM_BASE_PATH         cookie and redirect prefix. Defaults to /staging when SIM_STAGING=1.
"""
import asyncio, hashlib, hmac, html, os, re, time
from urllib.parse import parse_qs, unquote, urlencode

PROXY_TIMEOUT = 30.0
MAX_BODY = 200 * 1024
ROBOTS = 'User-agent: *\nDisallow: /\n'


def _esc(text):
    """Escape text for HTML. Apostrophes in sentences stay literal so the copy is exact."""
    return html.escape(str(text), quote=False).replace('"', '&quot;')


def _main_link(label):
    """Root-relative link. Through /staging/ this is the live site on the same host."""
    return '<a href="/">%s</a>' % _esc(label)


def _static_page(title, paragraphs):
    """Self-contained page: no scripts, no stylesheets, lang=en, escaped text."""
    body = ''.join('<p>%s</p>' % p for p in paragraphs)
    return (
        '<!doctype html>\n'
        '<html lang="en"><head><meta charset="utf-8"><title>%s</title></head>\n'
        '<body>%s</body></html>\n' % (_esc(title), body)
    )


PRIVATE_HTML = _static_page('Private test copy', [
    _esc('This is a private test copy of Circuit Lab.'),
    _esc('Looking for Circuit Lab? ') + _main_link('Go to the main site') + _esc('.'),
])
DOWN_HTML = _static_page('Test copy', [
    _esc("The test copy isn't running right now."),
    _esc('Try again in a few minutes, or ') + _main_link('use the main site') + _esc('.'),
])
_HOP = {
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection',
    'te', 'trailer', 'trailers', 'transfer-encoding', 'upgrade',
}
_WS_SKIP = _HOP | {
    'host', 'x-forwarded-for', 'forwarded', 'content-length',
    'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions',
    'sec-websocket-protocol', 'sec-websocket-accept',
}
_UPSTREAM_RE = re.compile(r'^http://127\.0\.0\.1:([1-9][0-9]{0,4})$')
_BASE_RE = re.compile(r'^/[A-Za-z0-9][A-Za-z0-9._/-]{0,80}$')

STAGING = False
ACCESS = ''
UPSTREAM_PORT = None
BASE_PATH = ''
COOKIE_PATH = '/'
_sim_authed = None


def _log(msg):
    print(msg, flush=True)


def set_logger(fn):
    global _log
    _log = fn


def configure(max_body, sim_authed=None):
    global MAX_BODY, _sim_authed
    MAX_BODY = int(max_body)
    _sim_authed = sim_authed


def staging_on():
    return STAGING


def access_on():
    return bool(ACCESS)


def upstream_port():
    return UPSTREAM_PORT


def parse_upstream(value):
    """Return the port, or None. Empty is off. Anything else is rejected and stays off."""
    raw = '' if value is None else str(value).strip()
    if raw == '':
        return None
    m = _UPSTREAM_RE.fullmatch(raw)
    port = int(m.group(1)) if m else 0
    if not m or not (1 <= port <= 65535):
        _log('staging_proxy error: SIM_STAGING_UPSTREAM must be http://127.0.0.1:<port>; pass-through off')
        return None
    return port


def _base_path(raw, staging):
    default = '/staging' if staging else ''
    text = (raw or '').strip()
    if not text:
        return default
    if not text.startswith('/'):
        text = '/' + text
    text = text.rstrip('/')
    if text in ('', '/'):
        return ''
    if '//' in text or '..' in text or not _BASE_RE.fullmatch(text):
        _log('staging base path rejected; using the default')
        return default
    return text


def apply_env(env=None):
    """Read the flags. Called at process start and by tests."""
    global STAGING, ACCESS, UPSTREAM_PORT, BASE_PATH, COOKIE_PATH
    env = os.environ if env is None else env
    STAGING = env.get('SIM_STAGING', '0') == '1'
    ACCESS = env.get('SIM_ACCESS_TOKEN', '') or ''
    UPSTREAM_PORT = parse_upstream(env.get('SIM_STAGING_UPSTREAM', ''))
    BASE_PATH = _base_path(env.get('SIM_BASE_PATH', ''), STAGING)
    COOKIE_PATH = (BASE_PATH + '/') if BASE_PATH else '/'


def token_eq(got, expected):
    """Constant-time compare. Length mismatches never raise and never match."""
    try:
        gb = got.encode('utf-8')
        eb = expected.encode('utf-8')
    except Exception:
        return False
    if len(gb) != len(eb):
        hmac.compare_digest(eb, eb)
        return False
    return hmac.compare_digest(gb, eb)


def cookie_value(token):
    """HMAC so the cookie is not the raw token. The token itself is never logged."""
    return hmac.new(b'cl-stage-v1', token.encode('utf-8'), hashlib.sha256).hexdigest()


def seal(resp):
    if STAGING:
        resp.headers['X-Robots-Tag'] = 'noindex, nofollow'
    return resp


def _public_path(path):
    path = path or '/'
    base = BASE_PATH
    if not base:
        return path
    if path == base or path.startswith(base + '/'):
        return path
    if path == '/':
        return base + '/'
    return base + path


def _redirect_target(request):
    path = _public_path(request.url.path or '/')
    pairs = [(k, v) for k, v in request.query_params.multi_items() if k != 't']
    if not pairs:
        return path
    return path + '?' + urlencode(pairs)


def access_gate(request):
    """None if the request may proceed. Otherwise a 401 or a redirect that drops ?t=."""
    if not ACCESS:
        return None
    from starlette.responses import HTMLResponse, RedirectResponse
    presented = request.query_params.get('t') if 't' in request.query_params else None
    cookie = request.cookies.get('cl_stage', '')
    if presented is not None and token_eq(presented, ACCESS):
        _log('stage_auth=ok')
        if request.method in ('GET', 'HEAD'):
            resp = RedirectResponse(_redirect_target(request), status_code=302)
            resp.set_cookie(
                'cl_stage', cookie_value(ACCESS),
                max_age=86400 * 7, httponly=True, samesite='strict', path=COOKIE_PATH,
            )
            return seal(resp)
        return None
    if presented is None and cookie and token_eq(cookie, cookie_value(ACCESS)):
        _log('stage_auth=ok')
        return None
    _log('stage_auth=denied')
    return seal(HTMLResponse(PRIVATE_HTML, status_code=401))


def _down(status):
    from starlette.responses import HTMLResponse
    return seal(HTMLResponse(DOWN_HTML, status_code=status))


def _too_large():
    from starlette.responses import PlainTextResponse
    return seal(PlainTextResponse('request too large', status_code=413))


def _not_found():
    from starlette.responses import PlainTextResponse
    return seal(PlainTextResponse('not found', status_code=404))


def _staging_kind(path):
    if path == '/staging':
        return 'slash'
    if path == '/staging/' or path.startswith('/staging/'):
        return 'forward'
    return ''


def strip_prefix(path):
    if path in ('/staging', '/staging/'):
        return '/'
    if path.startswith('/staging/'):
        rest = path[len('/staging'):]
        return rest if rest.startswith('/') else '/' + rest
    return path


def _drop_hop(items):
    """Drop hop-by-hop headers. Never forward X-Forwarded-For or Forwarded."""
    connection = set()
    for name, value in items:
        if name.lower() == 'connection':
            for part in value.split(','):
                connection.add(part.strip().lower())
    out = []
    for name, value in items:
        low = name.lower()
        if low in _HOP or low in connection or low in ('x-forwarded-for', 'forwarded', 'host'):
            continue
        out.append((name, value))
    return out


def _dot_segment(path):
    for part in str(path).split('/'):
        if part in ('.', '..'):
            return True
    return False


def climbs_out(path, raw=b''):
    """A /staging path whose dot-segments would leave the prefix. Those stay 404."""
    texts = [path or '']
    if isinstance(raw, bytes):
        try:
            raw = raw.decode('latin1')
        except Exception:
            raw = ''
    if raw:
        texts.append(raw)
        texts.append(unquote(raw))
    return any(_dot_segment(text) for text in texts)


async def _read_limited(request):
    cl = request.headers.get('content-length')
    if cl is not None:
        try:
            n = int(cl)
        except ValueError:
            from starlette.responses import PlainTextResponse
            return None, seal(PlainTextResponse('bad content-length', status_code=400))
        if n > MAX_BODY:
            return None, _too_large()
    chunks = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_BODY:
            return None, _too_large()
        chunks.append(chunk)
    return b''.join(chunks), None


def _ms(t0):
    return int(round((time.perf_counter() - t0) * 1000))


async def maybe_proxy(request):
    """Proxy /staging/*, redirect /staging, or 404 when the upstream flag is off.

    Returns None when the path is not a staging path.
    """
    kind = _staging_kind(request.url.path)
    if not kind:
        return None
    if climbs_out(request.url.path, request.scope.get('raw_path') or b''):
        return _not_found()
    if UPSTREAM_PORT is None:
        return _not_found()
    if kind == 'slash':
        from starlette.responses import RedirectResponse
        dest = '/staging/'
        if request.url.query:
            dest += '?' + request.url.query
        t0 = time.perf_counter()
        _log('staging_proxy status=302 ms=%d' % _ms(t0))
        return seal(RedirectResponse(dest, status_code=302))
    body, err = await _read_limited(request)
    if err is not None:
        return err
    t0 = time.perf_counter()
    try:
        status, headers, payload = await asyncio.wait_for(
            _forward(request.method, strip_prefix(request.url.path), request.url.query, request.headers.raw, body),
            PROXY_TIMEOUT,
        )
    except asyncio.TimeoutError:
        _log('staging_proxy status=504 ms=%d' % _ms(t0))
        return _down(504)
    except Exception:
        _log('staging_proxy status=502 ms=%d' % _ms(t0))
        return _down(502)
    _log('staging_proxy status=%s ms=%d' % (status, _ms(t0)))
    return seal(_response(status, headers, payload))


async def _forward(method, path, query, raw_headers, body):
    target = path or '/'
    if query:
        target += '?' + query
    items = [(k.decode('latin1'), v.decode('latin1')) for k, v in raw_headers]
    kept = []
    for name, value in _drop_hop(items):
        if name.lower() == 'content-length':
            continue
        kept.append((name, value))
    head = [('%s %s HTTP/1.1' % (method, target)).encode('latin1')]
    head.append(('Host: 127.0.0.1:%d' % UPSTREAM_PORT).encode('ascii'))
    for name, value in kept:
        head.append(('%s: %s' % (name, value)).encode('latin1'))
    if body:
        head.append(('Content-Length: %d' % len(body)).encode('ascii'))
    head.append(b'Connection: close')
    blob = b'\r\n'.join(head) + b'\r\n\r\n' + (body or b'')
    reader, writer = await asyncio.open_connection('127.0.0.1', UPSTREAM_PORT)
    try:
        writer.write(blob)
        await writer.drain()
        status, headers, rest = await _read_head(reader)
        payload = await _read_body(reader, headers, rest)
        return status, headers, payload
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass


async def _read_head(reader):
    buf = bytearray()
    while b'\r\n\r\n' not in buf:
        chunk = await reader.read(4096)
        if not chunk:
            break
        buf += chunk
        if len(buf) > 65536:
            raise OSError('upstream headers')
    raw = bytes(buf)
    head, _, rest = raw.partition(b'\r\n\r\n')
    lines = head.split(b'\r\n')
    if not lines or not lines[0]:
        raise OSError('upstream status')
    parts = lines[0].decode('latin1').split(' ', 2)
    if len(parts) < 2 or not parts[1].isdigit():
        raise OSError('upstream status')
    headers = []
    for line in lines[1:]:
        if b':' not in line:
            continue
        name, value = line.split(b':', 1)
        headers.append((name.decode('latin1').strip(), value.decode('latin1').strip()))
    return int(parts[1]), headers, rest


async def _read_body(reader, headers, rest):
    h = {name.lower(): value for name, value in headers}
    if 'chunked' in h.get('transfer-encoding', ''):
        return _decode_chunks(await _rest_all(reader, rest))
    if 'content-length' in h:
        need = int(h['content-length'])
        buf = bytearray(rest)
        while len(buf) < need:
            chunk = await reader.read(min(65536, need - len(buf)))
            if not chunk:
                break
            buf += chunk
        return bytes(buf[:need])
    buf = bytearray(rest)
    while True:
        chunk = await reader.read(65536)
        if not chunk:
            break
        buf += chunk
    return bytes(buf)


async def _rest_all(reader, rest):
    buf = bytearray(rest)
    while True:
        chunk = await reader.read(65536)
        if not chunk:
            break
        buf += chunk
    return bytes(buf)


def _decode_chunks(buf):
    out = bytearray()
    i = 0
    while True:
        nl = buf.find(b'\r\n', i)
        if nl < 0:
            break
        size = int(buf[i:nl].split(b';', 1)[0], 16)
        i = nl + 2
        if size == 0:
            break
        out += buf[i:i + size]
        i += size + 2
    return bytes(out)


def _response(status, headers, payload):
    from starlette.responses import Response
    kept = _drop_hop(headers)
    ctype = None
    extra = []
    for name, value in kept:
        # The live server sets these itself. Copying them makes a second Date and Server.
        if name.lower() in ('content-length', 'date', 'server'):
            continue
        if name.lower() == 'content-type':
            ctype = value
            continue
        extra.append((name, value))
    resp = Response(content=payload, status_code=status, media_type=None)
    if ctype:
        resp.headers['content-type'] = ctype
    for name, value in extra:
        resp.headers.append(name, value)
    return resp


async def decorate(request, resp):
    """noindex on every response, and the first-paint flag on the lab page."""
    resp.headers['X-Robots-Tag'] = 'noindex, nofollow'
    if request.url.path in ('/', '/index.html'):
        resp = await _inject(resp)
        resp.headers['X-Robots-Tag'] = 'noindex, nofollow'
    return resp


async def _inject(resp):
    from starlette.responses import HTMLResponse
    chunks = []
    async for chunk in resp.body_iterator:
        chunks.append(chunk)
    html = b''.join(chunks).decode('utf-8')
    needle = '<html lang="en" data-theme="dark">'
    if 'data-cl-env="staging"' not in html and needle in html:
        html = html.replace(needle, '<html lang="en" data-theme="dark" data-cl-env="staging">', 1)
    if 'name="cl-env"' not in html and '<head>' in html:
        html = html.replace('<head>', '<head>\n<meta name="cl-env" content="staging">', 1)
    headers = {k: v for k, v in resp.headers.items() if k.lower() != 'content-length'}
    return HTMLResponse(html, status_code=resp.status_code, headers=headers)


def _scope_cookies(scope):
    out = {}
    for name, value in scope.get('headers') or []:
        if name.lower() != b'cookie':
            continue
        for part in value.decode('latin1').split(';'):
            if '=' not in part:
                continue
            k, v = part.split('=', 1)
            out[k.strip()] = v.strip()
    return out


def _scope_query(scope):
    return {k: v for k, v in parse_qs(scope.get('query_string', b'').decode('latin1'), keep_blank_values=True).items()}


def ws_allowed(scope):
    if not ACCESS:
        return True
    q = _scope_query(scope)
    presented = q['t'][0] if 't' in q else None
    cookie = _scope_cookies(scope).get('cl_stage', '')
    if presented is not None and token_eq(presented, ACCESS):
        _log('stage_auth=ok')
        return True
    if presented is None and cookie and token_eq(cookie, cookie_value(ACCESS)):
        _log('stage_auth=ok')
        return True
    _log('stage_auth=denied')
    return False


def _sim_ok(scope):
    if _sim_authed is None:
        return True
    q = {k: (v[0] if v else '') for k, v in _scope_query(scope).items()}
    try:
        return bool(_sim_authed(q, _scope_cookies(scope)))
    except Exception:
        return False


async def _ws_http(send, status, body, content_type=b'text/html; charset=utf-8'):
    headers = [
        [b'content-type', content_type],
        [b'content-length', str(len(body)).encode('ascii')],
        [b'cache-control', b'no-store'],
    ]
    if STAGING:
        headers.append([b'x-robots-tag', b'noindex, nofollow'])
    await send({'type': 'websocket.http.response.start', 'status': status, 'headers': headers})
    await send({'type': 'websocket.http.response.body', 'body': body})


class StagingMiddleware:
    """WebSocket gate. HTTP stays on the existing middleware so an unset flag changes nothing."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get('type') != 'websocket':
            await self.app(scope, receive, send)
            return
        path = scope.get('path') or ''
        if path == '/staging' or path.startswith('/staging/'):
            if climbs_out(path, scope.get('raw_path') or b''):
                await _ws_http(send, 404, b'not found', b'text/plain; charset=utf-8')
                return
            await _proxy_ws(scope, receive, send)
            return
        if ACCESS and not ws_allowed(scope):
            await _ws_http(send, 401, PRIVATE_HTML.encode('utf-8'))
            return
        await self.app(scope, receive, send)


async def _proxy_ws(scope, receive, send):
    if UPSTREAM_PORT is None:
        await _ws_http(send, 404, b'not found', b'text/plain; charset=utf-8')
        return
    if not _sim_ok(scope):
        await _ws_http(send, 401, b'unauthorized', b'text/plain; charset=utf-8')
        return
    if ACCESS and not ws_allowed(scope):
        await _ws_http(send, 401, PRIVATE_HTML.encode('utf-8'))
        return
    t0 = time.perf_counter()
    try:
        message = await receive()
    except Exception:
        _log('staging_proxy status=502 ms=%d' % _ms(t0))
        return
    if message.get('type') != 'websocket.connect':
        return
    qs = scope.get('query_string') or b''
    path = strip_prefix(scope.get('path') or '/')
    url = 'ws://127.0.0.1:%d%s' % (UPSTREAM_PORT, path)
    if qs:
        url += '?' + qs.decode('latin1')
    headers = []
    for name, value in scope.get('headers') or []:
        low = name.decode('latin1').lower()
        if low in _WS_SKIP:
            continue
        headers.append((low, value.decode('latin1')))
    try:
        import websockets
    except ImportError:
        _log('staging_proxy status=502 ms=%d' % _ms(t0))
        await _ws_http(send, 502, DOWN_HTML.encode('utf-8'))
        return
    kwargs = dict(additional_headers=headers, open_timeout=PROXY_TIMEOUT, max_size=None, ping_interval=None, compression=None)
    try:
        connector = websockets.connect(url, proxy=None, **kwargs)
    except TypeError:
        connector = websockets.connect(url, **kwargs)
    try:
        remote = await asyncio.wait_for(connector.__aenter__(), PROXY_TIMEOUT)
    except asyncio.TimeoutError:
        _log('staging_proxy status=504 ms=%d' % _ms(t0))
        await _ws_http(send, 504, DOWN_HTML.encode('utf-8'))
        return
    except Exception:
        _log('staging_proxy status=502 ms=%d' % _ms(t0))
        await _ws_http(send, 502, DOWN_HTML.encode('utf-8'))
        return
    _log('staging_proxy status=101 ms=%d' % _ms(t0))
    await send({'type': 'websocket.accept'})

    async def client_to_remote():
        try:
            while True:
                msg = await receive()
                kind = msg.get('type')
                if kind == 'websocket.disconnect':
                    code = int(msg.get('code') or 1000)
                    try:
                        await remote.close(code=code)
                    except Exception:
                        pass
                    return
                if kind != 'websocket.receive':
                    continue
                if msg.get('text') is not None:
                    await remote.send(msg['text'])
                elif msg.get('bytes') is not None:
                    await remote.send(msg['bytes'])
        except Exception:
            try:
                await remote.close()
            except Exception:
                pass

    async def remote_to_client():
        code = 1000
        try:
            async for message in remote:
                if isinstance(message, str):
                    await send({'type': 'websocket.send', 'text': message})
                else:
                    await send({'type': 'websocket.send', 'bytes': bytes(message)})
            code = int(getattr(remote, 'close_code', None) or 1000)
        except Exception as exc:
            rcvd = getattr(exc, 'rcvd', None)
            raw = getattr(rcvd, 'code', None)
            if raw is None:
                raw = getattr(exc, 'code', None)
            if raw is None:
                raw = getattr(remote, 'close_code', None)
            try:
                code = int(raw or 1000)
            except Exception:
                code = 1000
        if code < 1000 or code > 4999:
            code = 1000
        try:
            await send({'type': 'websocket.close', 'code': code, 'reason': ''})
        except Exception:
            pass

    tasks = [asyncio.ensure_future(client_to_remote()), asyncio.ensure_future(remote_to_client())]
    try:
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        for task in done:
            try:
                task.result()
            except Exception:
                pass
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        try:
            await connector.__aexit__(None, None, None)
        except Exception:
            pass
