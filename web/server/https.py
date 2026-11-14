"""HTTPS listener, ACME webroot, redirect, and HSTS.

Off unless the environment says otherwise, so a process with no flags keeps
serving plain HTTP. Uvicorn terminates TLS itself (stdlib ``ssl``). Certbot
stays on the host. No new runtime dependency.

ACME_WEBROOT     default empty. Certbot ``--webroot -w`` directory. Files are
                 read from ``<dir>/.well-known/acme-challenge/<token>``.
TLS_CERT_FILE    default empty. PEM certificate (fullchain). Both this and
                 TLS_KEY_FILE must be set and readable before port 8443 opens.
TLS_KEY_FILE     default empty. PEM private key.
TLS_PORT         default 8443. Port inside the container. Published as 443.
HTTPS_REDIRECT   default 0. ``1`` redirects plain HTTP to https://HTTPS_HOST.
HTTPS_HOST       default empty. The only redirect target. Never the Host header.
HSTS_SECONDS     default 0 (off). A positive value sends Strict-Transport-Security
                 on HTTPS responses only. No includeSubDomains, no preload.
                 Values above 63072000 (2 years) are rejected and HSTS stays off.
ALLOWED_HOSTS    default unset (accept every Host). Comma-separated hostnames.
"""
import math, os, re, socket, ssl, threading, time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote

TOKEN_RE = re.compile(r'[A-Za-z0-9_-]{1,128}')
ACME_PREFIX = '/.well-known/acme-challenge/'
ACME_MARK = 'acme-challenge'
MAX_CHALLENGE = 65536
HSTS_CAP = 63072000
TLS_PORT_DEFAULT = 8443
_HOST_RE = re.compile(
    r'(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)'
    r'(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$'
)
_IPV4_RE = re.compile(r'^(?:\d{1,3}\.){3}\d{1,3}$')
_MONTHS = {name: n for n, name in enumerate(
    ('Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'), 1)}

# Flags. apply_env() fills these. The listener flag is separate: it is true
# only after the TLS socket is accepting, so a bad cert never looks "on".
REDIRECT = False
HTTPS_HOST = ''
HSTS_SECONDS = 0
ALLOWED = None  # None = accept all. A frozenset means the allow list is on.
WEBROOT = ''
CERT_FILE = ''
KEY_FILE = ''
LISTENER_ON = False
ACTIVE_CERT = ''
_warned = set()
_lock = threading.Lock()
_cache = {'mono': 0.0, 'path': '', 'payload': None}


def _default_log(msg):
    print(msg, flush=True)


_log = _default_log


def set_logger(fn):
    global _log
    _log = fn


def _warn_once(key, msg):
    if key in _warned:
        return
    _warned.add(key)
    _log(msg)


def valid_https_host(value):
    """A single hostname or IPv4 address. No scheme, user, port, or path."""
    if not value or any(ord(c) < 33 or ord(c) == 127 for c in value):
        return False
    if any(c in value for c in '/\\@?#%'):
        return False
    if _IPV4_RE.fullmatch(value):
        return all(0 <= int(part) <= 255 for part in value.split('.'))
    return '..' not in value and _HOST_RE.fullmatch(value) is not None


def normalize_host(value):
    """Hostname from a Host header or an allow-list item, without the port."""
    text = (value or '').strip().lower().rstrip('.')
    if not text:
        return ''
    if text.startswith('['):
        end = text.find(']')
        return text[:end + 1] if end > 0 else ''
    if text.count(':') == 1:
        name, port = text.rsplit(':', 1)
        if port.isdigit():
            return name.rstrip('.')
    if ':' in text:
        return ''
    return text


def _parse_hsts(raw):
    text = ('' if raw is None else str(raw)).strip()
    if text in ('', '0'):
        return 0
    if not text.isdigit():
        _log('HSTS_SECONDS=%s is not a whole number; HSTS stays off' % text)
        return 0
    value = int(text)
    if value > HSTS_CAP:
        _log('HSTS_SECONDS=%s is above %d; HSTS stays off' % (text, HSTS_CAP))
        return 0
    return value


def _parse_allowed(env):
    if 'ALLOWED_HOSTS' not in env:
        return None
    raw = env.get('ALLOWED_HOSTS')
    if raw is None or str(raw).strip() == '':
        return None
    hosts = []
    for part in str(raw).split(','):
        name = normalize_host(part)
        if name:
            hosts.append(name)
    if not hosts:
        _log('ALLOWED_HOSTS is set but has no usable host; every Host is rejected')
    return frozenset(hosts)


def apply_env(env=None):
    """Read the flags. Called at process start and by tests. Does not touch the listener."""
    global REDIRECT, HTTPS_HOST, HSTS_SECONDS, ALLOWED, WEBROOT, CERT_FILE, KEY_FILE
    env = os.environ if env is None else env
    REDIRECT = str(env.get('HTTPS_REDIRECT', '0')).strip() == '1'
    raw_host = str(env.get('HTTPS_HOST', '') or '').strip()
    if raw_host and not valid_https_host(raw_host):
        _log('HTTPS_HOST rejected (not a single hostname); redirect target cleared')
        HTTPS_HOST = ''
    else:
        HTTPS_HOST = raw_host
    HSTS_SECONDS = _parse_hsts(env.get('HSTS_SECONDS', '0'))
    ALLOWED = _parse_allowed(env)
    WEBROOT = str(env.get('ACME_WEBROOT', '') or '').strip()
    CERT_FILE = str(env.get('TLS_CERT_FILE', '') or '').strip()
    KEY_FILE = str(env.get('TLS_KEY_FILE', '') or '').strip()
    _warned.clear()
    with _lock:
        _cache['mono'] = 0.0
        _cache['path'] = ''
        _cache['payload'] = None


def tls_port_from_env(env=None):
    env = os.environ if env is None else env
    raw = str(env.get('TLS_PORT', '') or '').strip()
    if raw == '':
        return TLS_PORT_DEFAULT
    if raw.isdigit() and 0 <= int(raw) <= 65535:
        return int(raw)
    _log('TLS_PORT=%s is not a port; using %d' % (raw, TLS_PORT_DEFAULT))
    return TLS_PORT_DEFAULT


def _readable(path):
    try:
        return bool(path) and os.path.isfile(path) and os.access(path, os.R_OK)
    except OSError:
        return False


def tls_material():
    """``(cert, key)`` when both files load, else None. Never raises.

    Unset means HTTP only and is not an error. Set but missing, unreadable,
    or not a matching pair is logged and HTTP only continues.
    """
    cert, key = CERT_FILE, KEY_FILE
    if not cert and not key:
        return None
    if not cert or not key:
        _log('TLS disabled: set both TLS_CERT_FILE and TLS_KEY_FILE, or neither; serving HTTP only')
        return None
    bad = False
    for label, path in (('TLS_CERT_FILE', cert), ('TLS_KEY_FILE', key)):
        if not _readable(path):
            _log('TLS disabled: %s=%s is missing or unreadable; serving HTTP only' % (label, path))
            bad = True
    if bad:
        return None
    try:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(certfile=cert, keyfile=key)
    except Exception as exc:
        _log('TLS disabled: certificate and key did not load (%s); serving HTTP only' % exc)
        return None
    return cert, key


def set_listener(on, cert_path):
    """Record whether the TLS socket is up. Health reads this, not the env vars."""
    global LISTENER_ON, ACTIVE_CERT
    with _lock:
        LISTENER_ON = bool(on) and bool(cert_path)
        ACTIVE_CERT = cert_path if LISTENER_ON else ''
        _cache['mono'] = 0.0
        _cache['path'] = ''
        _cache['payload'] = None


def redirect_status(method):
    """301 keeps GET and HEAD. 308 keeps every other method, including POST."""
    if (method or '').upper() in ('GET', 'HEAD'):
        return 301
    return 308


def redirect_location(scope, host):
    """https://<configured host><path>?<query>. None when the path is not safe to echo.

    ``host`` is the configured HTTPS_HOST. The request Host header is not read.
    """
    if not valid_https_host(host):
        return None
    raw = scope.get('raw_path') or b''
    if isinstance(raw, str):
        path = raw
    elif raw:
        path = raw.decode('latin1')
    else:
        path = scope.get('path') or '/'
    path = path.split('?', 1)[0] or '/'
    if not path.startswith('/') or path.startswith('//') or '\\' in path:
        return None
    if any(ord(c) < 32 or ord(c) == 127 for c in path):
        return None
    query = scope.get('query_string') or b''
    if isinstance(query, str):
        query = query.encode('latin1', 'replace')
    try:
        qtext = query.decode('ascii')
    except UnicodeDecodeError:
        return None
    if any(ord(c) < 32 or ord(c) == 127 for c in qtext):
        return None
    loc = 'https://' + host + path
    if qtext:
        loc += '?' + qtext
    return loc


def _raw_path(scope):
    raw = scope.get('raw_path') or b''
    if isinstance(raw, bytes):
        return raw.decode('latin1')
    return str(raw or '')


def _decoded_path(scope):
    text = _raw_path(scope).split('?', 1)[0]
    current = text
    for _ in range(2):
        nxt = unquote(current)
        if nxt == current:
            break
        current = nxt
    return current


def _hostile_path(text):
    if text is None:
        return False
    if '\\' in text or '\x00' in text or '\r' in text or '\n' in text:
        return True
    return any(part in ('.', '..') for part in text.split('/'))


def acme_attempt(scope):
    """True when the request is aimed at the challenge prefix, including encoded forms."""
    path = scope.get('path') or ''
    raw = _raw_path(scope)
    decoded = _decoded_path(scope)
    blob = '\n'.join((path, raw, decoded)).lower()
    return ACME_MARK in blob or path.startswith(ACME_PREFIX) or path.rstrip('/') == '/.well-known/acme-challenge'


def acme_token(scope):
    """The challenge token, or '' when this is a challenge URL we will not serve."""
    if not acme_attempt(scope):
        return None
    path = scope.get('path') or ''
    decoded = _decoded_path(scope)
    if _hostile_path(path) or _hostile_path(decoded) or _hostile_path(_raw_path(scope)):
        return ''
    if not path.startswith(ACME_PREFIX):
        return ''
    token = path[len(ACME_PREFIX):]
    if not TOKEN_RE.fullmatch(token):
        return ''
    if decoded.split('/')[-1] != token:
        return ''
    return token


def load_challenge(webroot, token):
    """Bytes of one challenge file, or None. The token is the only path segment used."""
    if not webroot or TOKEN_RE.fullmatch(token or '') is None:
        return None
    try:
        root = Path(webroot).resolve(strict=True)
    except OSError:
        return None
    if not root.is_dir():
        return None
    challenge = root / '.well-known' / 'acme-challenge'
    try:
        challenge_r = challenge.resolve(strict=True)
        challenge_r.relative_to(root)
    except (OSError, ValueError):
        return None
    if not challenge_r.is_dir():
        return None
    candidate = challenge_r / token
    try:
        # A symlink may point at another name in this directory. It may not leave it.
        if candidate.is_symlink() or candidate.exists():
            target = candidate.resolve(strict=True)
        else:
            return None
    except OSError:
        return None
    if target.parent != challenge_r or target.name != token or not target.is_file():
        return None
    try:
        data = target.read_bytes()
    except OSError:
        return None
    if len(data) > MAX_CHALLENGE:
        return None
    return data


def _host_header(scope):
    for name, value in scope.get('headers') or []:
        if name.lower() == b'host':
            try:
                return value.decode('latin1')
            except AttributeError:
                return str(value)
    return ''


def host_allowed(scope):
    if ALLOWED is None:
        return True
    return normalize_host(_host_header(scope)) in ALLOWED


def _is_health(scope):
    return (scope.get('path') or '') == '/api/health'


def _ws_upgrade(scope):
    if scope.get('type') == 'websocket':
        return True
    for name, value in scope.get('headers') or []:
        if name.lower() == b'upgrade' and b'websocket' in value.lower():
            return True
    return False


def _tls_scheme(scheme):
    return scheme in ('https', 'wss')


def security_headers(scheme):
    """HSTS and upgrade-insecure-requests. HTTPS responses only."""
    if not _tls_scheme(scheme):
        return []
    headers = []
    if HSTS_SECONDS > 0:
        headers.append((b'strict-transport-security', ('max-age=%d' % HSTS_SECONDS).encode('ascii')))
    headers.append((b'content-security-policy', b'upgrade-insecure-requests'))
    return headers


def _merge_response_headers(headers, scheme):
    """Drop any HSTS we did not decide to send. Add the HTTPS-only headers."""
    cleaned = [list(item) for item in headers if item[0].lower() != b'strict-transport-security']
    if not _tls_scheme(scheme):
        return cleaned
    for name, value in security_headers(scheme):
        if name == b'content-security-policy':
            cleaned = _add_upgrade(cleaned)
        else:
            cleaned.append([name, value])
    return cleaned


def _add_upgrade(headers):
    directive = b'upgrade-insecure-requests'
    found = False
    for item in headers:
        if item[0].lower() != b'content-security-policy':
            continue
        found = True
        if directive not in item[1]:
            item[1] = item[1] + b'; ' + directive
    if not found:
        headers.append([b'content-security-policy', directive])
    return headers


def parse_not_after(text):
    """OpenSSL ``notAfter`` (``Nov 14 00:00:00 2026 GMT``) as an aware UTC datetime."""
    parts = (text or '').split()
    if len(parts) < 4 or parts[0] not in _MONTHS:
        return None
    try:
        hour, minute, second = (int(piece) for piece in parts[2].split(':'))
        when = datetime(int(parts[3]), _MONTHS[parts[0]], int(parts[1]), hour, minute, second, tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None
    return when


def days_left(not_after, now):
    return math.floor((not_after - now).total_seconds() / 86400)


def _load_expiry(path):
    info = ssl._ssl._test_decode_cert(path)
    when = parse_not_after(info.get('notAfter') or '')
    if when is None:
        return None, None
    now = datetime.now(timezone.utc)
    return when.strftime('%Y-%m-%dT%H:%M:%SZ'), days_left(when, now)


def tls_status(now=None):
    """Health ``tls`` object. The certificate file is re-read at most every 60 seconds.

    ``enabled`` follows the live listener, not the mere presence of the env vars.
    ``ok`` on ``/api/health`` is computed by the caller and does not use this.
    """
    clock = time.monotonic() if now is None else now
    with _lock:
        if not LISTENER_ON or not ACTIVE_CERT:
            return {'enabled': False, 'cert_not_after': None, 'days_left': None}
        path = ACTIVE_CERT
        cached = _cache['payload']
        if cached is not None and _cache['path'] == path and clock - _cache['mono'] < 60:
            return {'enabled': True, 'cert_not_after': cached[0], 'days_left': cached[1]}
        try:
            iso, left = _load_expiry(path)
        except Exception as exc:
            _log('TLS certificate re-read failed (%s); health tls dates cleared' % exc)
            iso, left = None, None
        _cache['mono'] = clock
        _cache['path'] = path
        _cache['payload'] = (iso, left)
        return {'enabled': True, 'cert_not_after': iso, 'days_left': left}


def _pairs(items):
    return [[name, value] for name, value in items]


async def _http_reply(send, status, body, extra, scheme):
    if isinstance(body, str):
        body = body.encode('utf-8')
    headers = [
        [b'content-type', b'text/plain; charset=utf-8'],
        [b'content-length', str(len(body)).encode('ascii')],
    ]
    headers.extend(_pairs(extra))
    headers = _merge_response_headers(headers, scheme)
    await send({'type': 'http.response.start', 'status': status, 'headers': headers})
    await send({'type': 'http.response.body', 'body': body})


async def _ws_reply(send, status, body, scheme):
    if isinstance(body, str):
        body = body.encode('utf-8')
    headers = [
        [b'content-type', b'text/plain; charset=utf-8'],
        [b'content-length', str(len(body)).encode('ascii')],
    ]
    headers = _merge_response_headers(headers, scheme)
    await send({'type': 'websocket.http.response.start', 'status': status, 'headers': headers})
    await send({'type': 'websocket.http.response.body', 'body': body})


async def _drain(receive):
    """Read the request body so a redirect does not stall the client. False if it went away."""
    while True:
        message = await receive()
        if message.get('type') == 'http.disconnect':
            return False
        if message.get('type') == 'http.request' and not message.get('more_body', False):
            return True


class HttpsMiddleware:
    """Outermost ASGI middleware. HTTP-only until the flags say otherwise."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        kind = scope.get('type')
        if kind not in ('http', 'websocket'):
            await self.app(scope, receive, send)
            return
        scheme = scope.get('scheme') or ''
        if not host_allowed(scope):
            if kind == 'websocket':
                await _ws_reply(send, 400, 'unknown host', scheme)
            else:
                await _http_reply(send, 400, 'unknown host', (), scheme)
            return
        if kind == 'websocket':
            # Uvicorn reports the socket scheme as ws or wss. Anything but wss
            # is plain HTTP, and a 301 would not stop the upgrade.
            if REDIRECT and scheme != 'wss':
                await _ws_reply(
                    send, 403,
                    'WebSocket over plain HTTP is refused while HTTPS redirect is on. Use wss://.',
                    scheme,
                )
                return
            await self.app(scope, receive, send)
            return
        if acme_attempt(scope):
            await self._acme(scope, receive, send, scheme)
            return
        if scheme == 'http' and REDIRECT and not _is_health(scope):
            if _ws_upgrade(scope):
                await _http_reply(
                    send, 403,
                    'WebSocket over plain HTTP is refused while HTTPS redirect is on. Use wss://.',
                    (), scheme,
                )
                return
            if not HTTPS_HOST:
                _warn_once('redirect-host', 'HTTPS_REDIRECT is on but HTTPS_HOST is empty; redirect stays off')
            else:
                location = redirect_location(scope, HTTPS_HOST)
                if not await _drain(receive):
                    return
                if location is None:
                    await _http_reply(send, 400, 'bad request', (), scheme)
                    return
                await _http_reply(
                    send, redirect_status(scope.get('method')), '',
                    ((b'location', location.encode('latin1')),), scheme,
                )
                return
        async def send_wrap(message):
            if message.get('type') == 'http.response.start':
                message = dict(message)
                message['headers'] = _merge_response_headers(message.get('headers') or [], scheme)
            await send(message)
        await self.app(scope, receive, send_wrap)

    async def _acme(self, scope, receive, send, scheme):
        method = (scope.get('method') or 'GET').upper()
        token = acme_token(scope)
        if not await _drain(receive):
            return
        if method not in ('GET', 'HEAD'):
            await _http_reply(send, 405, 'method not allowed', ((b'allow', b'GET, HEAD'),), scheme)
            return
        data = load_challenge(WEBROOT, token) if token else None
        if data is None:
            await _http_reply(send, 404, 'not found', (), scheme)
            return
        # Exact media type. Challenge bodies are ASCII; no charset parameter.
        headers = [
            [b'content-type', b'text/plain'],
            [b'content-length', str(len(data)).encode('ascii')],
            [b'cache-control', b'no-store'],
        ]
        headers = _merge_response_headers(headers, scheme)
        await send({'type': 'http.response.start', 'status': 200, 'headers': headers})
        await send({'type': 'http.response.body', 'body': b'' if method == 'HEAD' else data})


def _quiet_server(config):
    """A uvicorn server that does not install signal handlers.

    Two listeners would otherwise replace each other's SIGTERM handler, and
    the one that lost would keep running after ``docker stop``.
    """
    import uvicorn
    server = uvicorn.Server(config)
    server.install_signal_handlers = lambda: None

    def _capture():
        import contextlib
        @contextlib.contextmanager
        def _cm():
            yield
        return _cm()

    server.capture_signals = _capture
    return server


def _uvicorn_config(app, host, port, *, certfile=None, keyfile=None, lifespan='on',
                    log_level='warning', access_log=True):
    import uvicorn
    # proxy_headers stays False on both listeners. The scheme is the socket,
    # never X-Forwarded-Proto. Staging tests look for this exact argument pair.
    return uvicorn.Config(
        app, host=host, port=port, log_level=log_level, access_log=access_log,
        proxy_headers=False, forwarded_allow_ips='',
        ssl_certfile=certfile, ssl_keyfile=keyfile, lifespan=lifespan,
    )


def _bind(host, port):
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((host, port))
        sock.setblocking(False)
    except Exception:
        sock.close()
        raise
    return sock


async def serve_listeners(app, host, http_port, *, tls_port=None, signals=False,
                          log_level='warning', access_log=True, ready=None):
    """Serve HTTP, and HTTPS on ``tls_port`` when the cert and key load.

    A missing cert, a bad key, or a busy TLS port is logged. HTTP keeps running.
    """
    import asyncio
    set_listener(False, '')
    http = _quiet_server(_uvicorn_config(
        app, host, http_port, lifespan='on', log_level=log_level, access_log=access_log,
    ))
    material = tls_material()
    tls = None
    tls_sock = None
    if material and tls_port is not None:
        try:
            tls_sock = _bind(host, tls_port)
        except OSError as exc:
            _log('TLS disabled: cannot bind %s:%s (%s); serving HTTP only' % (host, tls_port, exc))
            tls_sock = None
        if tls_sock is not None:
            cert, key = material
            tls_config = _uvicorn_config(
                app, host, tls_sock.getsockname()[1], certfile=cert, keyfile=key, lifespan='off',
                log_level=log_level, access_log=access_log,
            )
            try:
                tls_config.load()
            except Exception as exc:
                _log('TLS disabled: listener setup failed (%s); serving HTTP only' % exc)
                tls_sock.close()
                tls_sock = None
            else:
                tls = _quiet_server(tls_config)
    if WEBROOT and not os.path.isdir(WEBROOT):
        _warn_once('webroot', 'ACME_WEBROOT=%s is not a directory; challenge URLs will 404' % WEBROOT)

    if signals and threading.current_thread() is threading.main_thread():
        import signal
        def _stop(signum, _frame):
            if http.should_exit:
                http.force_exit = True
                if tls is not None:
                    tls.force_exit = True
            else:
                http.should_exit = True
                if tls is not None:
                    tls.should_exit = True
        for sig in (signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, _stop)

    async def _run_tls():
        try:
            await tls.serve(sockets=[tls_sock])
        except SystemExit as exc:
            _log('TLS listener exited (%s); serving HTTP only' % exc)
            set_listener(False, '')
        except Exception as exc:
            _log('TLS listener failed (%s); serving HTTP only' % exc)
            set_listener(False, '')

    http_task = asyncio.create_task(http.serve())
    tls_task = asyncio.create_task(_run_tls()) if tls is not None else None
    try:
        started = await _wait_started(http, http_task)
        if not started:
            set_listener(False, '')
            if tls is not None:
                tls.should_exit = True
            if tls_task is not None:
                await tls_task
            await http_task
            if ready is not None:
                ready(http, None)
            return
        tls_up = None
        if tls is not None:
            if await _wait_started(tls, tls_task):
                set_listener(True, material[0])
                bound = tls.servers[0].sockets[0].getsockname()
                _log('TLS listening on %s:%s' % (host, bound[1]))
                tls_up = tls
            else:
                set_listener(False, '')
                tls.should_exit = True
                _log('TLS disabled: listener did not stay up; serving HTTP only')
                tls_up = None
        if ready is not None:
            ready(http, tls_up)
        await http_task
        if tls is not None and not tls.should_exit:
            tls.should_exit = True
        if tls_task is not None:
            await tls_task
    finally:
        if tls is not None:
            tls.should_exit = True
        if tls_task is not None and not tls_task.done():
            try:
                await tls_task
            except Exception:
                pass
        set_listener(False, '')


async def _wait_started(server, task, timeout=8):
    import asyncio
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if getattr(server, 'started', False):
            return True
        if task.done():
            return False
        await asyncio.sleep(0.02)
    return bool(getattr(server, 'started', False))


def serve_forever(app, host, port):
    """Process entry. Reads the environment, then serves until SIGTERM."""
    import asyncio
    apply_env()
    if not CERT_FILE and not KEY_FILE:
        _log('TLS not configured (TLS_CERT_FILE and TLS_KEY_FILE unset); serving HTTP only')
    asyncio.run(serve_listeners(
        app, host, port, tls_port=tls_port_from_env(), signals=True, ready=None,
    ))


class Background:
    """One HTTP listener and, when the cert loads, one HTTPS listener. For tests."""

    def __init__(self, app, host='127.0.0.1', http_port=0, tls_port=0):
        self.app = app
        self.host = host
        self._http_port = http_port
        self._tls_port = tls_port
        self.http_port = None
        self.tls_port = None
        self.http = None
        self.tls = None
        self.error = None
        self.ready = threading.Event()
        self.thread = None

    def start(self, timeout=15):
        import asyncio
        def _thread():
            try:
                asyncio.run(self._main())
            except BaseException as exc:
                self.error = exc
                self.ready.set()
        self.thread = threading.Thread(target=_thread, name='https-listeners', daemon=True)
        self.thread.start()
        if not self.ready.wait(timeout):
            self.stop()
            raise RuntimeError('listener did not start')
        if self.error and self.http_port is None:
            self.stop()
            raise RuntimeError(self.error)
        return self

    async def _main(self):
        try:
            await serve_listeners(
                self.app, self.host, self._http_port, tls_port=self._tls_port,
                signals=False, log_level='error', access_log=False, ready=self._mark,
            )
        except BaseException as exc:
            self.error = exc
            raise
        finally:
            self.ready.set()

    def _mark(self, http, tls):
        self.http = http
        self.tls = tls
        try:
            self.http_port = http.servers[0].sockets[0].getsockname()[1]
        except Exception:
            self.http_port = None
        if tls is not None and getattr(tls, 'started', False):
            try:
                self.tls_port = tls.servers[0].sockets[0].getsockname()[1]
            except Exception:
                self.tls_port = None
        self.ready.set()

    def stop(self):
        if self.http is not None:
            self.http.should_exit = True
        if self.tls is not None:
            self.tls.should_exit = True
        if self.thread is not None:
            self.thread.join(5)

    def __enter__(self):
        return self.start()

    def __exit__(self, *_exc):
        self.stop()
