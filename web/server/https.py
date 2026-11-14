"""HTTPS listener, ACME webroot, redirect, and HSTS.

Off unless the environment says otherwise, so a process with no flags keeps
serving plain HTTP. Uvicorn terminates TLS itself (stdlib ``ssl``). Certbot
stays on the host. No new runtime dependency.

ACME_WEBROOT     default empty. Certbot ``--webroot -w`` directory. Files are
                 read from ``<dir>/.well-known/acme-challenge/<token>``.
                 Token ``^[A-Za-z0-9_-]{20,128}$``. No directory listing. Read-only.
TLS_CERT_FILE    default empty. PEM certificate (fullchain). Both this and
                 TLS_KEY_FILE must be set and readable before port 8443 opens.
TLS_KEY_FILE     default empty. PEM private key. Live mount: read-only bind,
                 owned by root, mode 600. A bad key logs once and HTTP stays up.
TLS_PORT         default 8443. Port inside the container. Published as 443.
HTTPS_REDIRECT   default 0. ``1`` redirects assets and API calls to
                 https://HTTPS_HOST. A top-level HTML GET gets a same-page
                 handoff instead. The move POST is capped at 2 MB.
HTTPS_HOST       default empty. The only redirect target. Never the Host header.
HSTS_SECONDS     default 0 (off). A positive value sends Strict-Transport-Security
                 on HTTPS responses only. No includeSubDomains, no preload.
                 Values above 63072000 (2 years) are rejected and HSTS stays off.
ALLOWED_HOSTS    default unset (accept every Host). Comma-separated hostnames.
"""
import base64, json, math, os, re, secrets, socket, ssl, stat, threading, time, zlib
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

TOKEN_RE = re.compile(r'^[A-Za-z0-9_-]{20,128}$')
ACME_PREFIX = '/.well-known/acme-challenge/'
ACME_MARK = 'acme-challenge'
MAX_CHALLENGE = 65536
HSTS_CAP = 63072000
TLS_PORT_DEFAULT = 8443
WARN_DAYS = 14
MIGRATE_CAP = 2 * 1024 * 1024
PROJECT_CAP = 1024 * 1024
FRAGMENT_BUDGET = int(1.5 * 1024 * 1024)
# First script on every move page. It copies the fragment into memory and
# replaces the history entry before any later script or subresource runs.
_CLEAR_HASH = (
    "(function(){var h='';try{h=location.hash||'';}catch(e){h='';}"
    "if(h.charAt(0)==='#')h=h.slice(1);window.__clMove=h;"
    "try{history.replaceState(null,'',location.pathname+location.search);}catch(e){}})();"
)
_MOVE_CSP = (
    "default-src 'none'; script-src 'none'; style-src 'none'; img-src 'none'; "
    "font-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; "
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
)
_REDIRECT_BASE = ''
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
    global _REDIRECT_BASE
    _REDIRECT_BASE = ''
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


def set_redirect_base(value):
    """Loopback origin for tests. Production leaves this empty and uses https://HTTPS_HOST."""
    global _REDIRECT_BASE
    if not _loopback_origin(value):
        raise ValueError('redirect base must be a loopback origin')
    _REDIRECT_BASE = value.rstrip('/')


def _loopback_origin(value):
    try:
        parsed = urlparse(value)
    except ValueError:
        return False
    if parsed.scheme not in ('http', 'https') or parsed.username or parsed.password:
        return False
    if parsed.path not in ('', '/') or parsed.query or parsed.fragment:
        return False
    if parsed.hostname not in ('localhost', '127.0.0.1'):
        return False
    if parsed.port is not None and not (1 <= parsed.port <= 65535):
        return False
    return True


def public_origin():
    """Where a redirected browser is sent. The Host header is not consulted."""
    if _REDIRECT_BASE:
        return _REDIRECT_BASE
    if not valid_https_host(HTTPS_HOST):
        return ''
    return 'https://' + HTTPS_HOST


def key_posture(path):
    """How the private key is mounted.

    The live container bind-mounts ``/etc/letsencrypt`` read-only. The key
    file (``live/.../privkey.pem``, a symlink into ``archive/``) is owned by
    root and mode 600. This reports that shape. It does not log and does not raise.
    """
    info = {
        'path': path or '', 'exists': False, 'readable': False, 'regular': False,
        'mode': '', 'uid': None, 'root_owned': False, 'ro_mount': False,
    }
    if not path:
        return info
    try:
        st = os.stat(path)
    except OSError:
        return info
    info['exists'] = True
    info['regular'] = stat.S_ISREG(st.st_mode)
    info['mode'] = '%03o' % (st.st_mode & 0o777)
    info['uid'] = st.st_uid
    info['root_owned'] = st.st_uid == 0
    info['readable'] = os.access(path, os.R_OK)
    info['ro_mount'] = _ro_mount(path)
    return info


def _ro_mount(path):
    try:
        real = os.path.realpath(path)
    except OSError:
        return False
    best = ''
    ro = False
    try:
        lines = open('/proc/self/mountinfo', encoding='utf-8', errors='replace')
    except OSError:
        return False
    with lines:
        for line in lines:
            parts = line.split()
            if len(parts) < 6:
                continue
            point = parts[4].replace('\\040', ' ')
            if real == point or real.startswith(point.rstrip('/') + '/'):
                if len(point) >= len(best):
                    best = point
                    ro = 'ro' in parts[5].split(',')
    return ro


def _key_warning(reason, path):
    posture = key_posture(path)
    _log(
        'tls key warning reason=%s path=%s mode=%s uid=%s root_owned=%s ro_mount=%s serving=http'
        % (reason, path or '', posture['mode'] or '-', posture['uid'] if posture['uid'] is not None else '-',
           'true' if posture['root_owned'] else 'false', 'true' if posture['ro_mount'] else 'false')
    )


def tls_material():
    """``(cert, key)`` when both files load, else None. Never raises.

    Unset means HTTP only and is not an error. A missing, unreadable, mode
    other than 600, or invalid key logs one structured warning and HTTP continues.
    """
    cert, key = CERT_FILE, KEY_FILE
    if not cert and not key:
        return None
    if not key:
        _key_warning('missing', key)
        return None
    if not os.path.exists(key):
        _key_warning('missing', key)
        return None
    posture = key_posture(key)
    if not posture['regular']:
        _key_warning('not-a-file', key)
        return None
    if not posture['readable']:
        _key_warning('unreadable', key)
        return None
    if posture['mode'] != '600':
        _key_warning('mode', key)
        return None
    if not cert or not _readable(cert):
        _key_warning('cert-unreadable', key)
        return None
    try:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(certfile=cert, keyfile=key)
    except Exception:
        _key_warning('invalid', key)
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
    # One file, read-only, and only when its real name is the token. A symlink,
    # a directory, or a file outside this folder is not served, and the folder
    # itself is never listed.
    if candidate.is_symlink():
        return None
    flags = os.O_RDONLY | getattr(os, 'O_CLOEXEC', 0) | getattr(os, 'O_NOFOLLOW', 0)
    try:
        fd = os.open(str(candidate), flags)
    except OSError:
        return None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_CHALLENGE:
            return None
        try:
            real = Path(os.path.realpath(candidate)).resolve()
            real.relative_to(challenge_r)
        except (OSError, ValueError):
            return None
        if real.name != token or real.parent != challenge_r:
            return None
        data = os.read(fd, MAX_CHALLENGE + 1)
    finally:
        os.close(fd)
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


def _merge_response_headers(headers, scheme, upgrade=True):
    """Drop any HSTS we did not decide to send. Add the HTTPS-only headers.

    ``upgrade`` is off for the project-move pages. Those pages navigate back to
    the plain-HTTP origin on purpose, and upgrade-insecure-requests would send
    that navigation to the wrong origin.
    """
    cleaned = [list(item) for item in headers if item[0].lower() != b'strict-transport-security']
    if not _tls_scheme(scheme):
        return cleaned
    for name, value in security_headers(scheme):
        if name == b'content-security-policy':
            if upgrade:
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


def _tls_body(enabled, iso, left):
    warning = bool(enabled and isinstance(left, int) and left < WARN_DAYS)
    return {
        'enabled': bool(enabled),
        'cert_not_after': iso,
        'days_left': left,
        'warning': warning,
        'reason': ('certificate has %d days left' % left) if warning else None,
    }


def tls_status(now=None):
    """Health ``tls`` object. The certificate file is re-read at most every 60 seconds.

    ``enabled`` follows the live listener, not the mere presence of the env vars.
    ``ok`` on ``/api/health`` is computed by the caller and does not use this.
    ``warning`` is true once fewer than 14 days remain.
    """
    clock = time.monotonic() if now is None else now
    with _lock:
        if not LISTENER_ON or not ACTIVE_CERT:
            return _tls_body(False, None, None)
        path = ACTIVE_CERT
        cached = _cache['payload']
        if cached is not None and _cache['path'] == path and clock - _cache['mono'] < 60:
            return _tls_body(True, cached[0], cached[1])
        try:
            iso, left = _load_expiry(path)
        except Exception as exc:
            _log('TLS certificate re-read failed (%s); health tls dates cleared' % exc)
            iso, left = None, None
        _cache['mono'] = clock
        _cache['path'] = path
        _cache['payload'] = (iso, left)
        return _tls_body(True, iso, left)


def _pairs(items):
    return [[name, value] for name, value in items]


async def _http_reply(send, status, body, extra, scheme, upgrade=True):
    if isinstance(body, str):
        body = body.encode('utf-8')
    headers = [
        [b'content-type', b'text/plain; charset=utf-8'],
        [b'content-length', str(len(body)).encode('ascii')],
    ]
    headers.extend(_pairs(extra))
    headers = _merge_response_headers(headers, scheme, upgrade=upgrade)
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


async def _read_capped(receive, limit):
    """Request body, or False when it is over ``limit``. None if the client left.

    Bytes over the limit are discarded and never logged.
    """
    chunks = []
    size = 0
    too_big = False
    while True:
        message = await receive()
        if message.get('type') == 'http.disconnect':
            return None
        body = message.get('body') or b''
        size += len(body)
        if size > limit:
            too_big = True
            chunks = []
        elif not too_big:
            chunks.append(body)
        if message.get('type') == 'http.request' and not message.get('more_body', False):
            return False if too_big else b''.join(chunks)


async def _drain(receive):
    """Read the request body so a redirect does not stall the client. False if it went away."""
    while True:
        message = await receive()
        if message.get('type') == 'http.disconnect':
            return False
        if message.get('type') == 'http.request' and not message.get('more_body', False):
            return True


def request_origin(scope):
    """scheme://host[:port] from the socket scheme and the Host header."""
    scheme = scope.get('scheme') or 'http'
    if scheme == 'ws':
        scheme = 'http'
    elif scheme == 'wss':
        scheme = 'https'
    raw = (_host_header(scope) or '').strip()
    host = normalize_host(raw)
    port = ''
    if raw.count(':') == 1 and raw.rsplit(':', 1)[1].isdigit():
        port = raw.rsplit(':', 1)[1]
    if scheme == 'http' and port in ('', '80'):
        return 'http://' + host
    if scheme == 'https' and port in ('', '443'):
        return 'https://' + host
    if port:
        return '%s://%s:%s' % (scheme, host, port)
    return '%s://%s' % (scheme, host)


def redirect_suppressed(scope):
    """True when this request must stay on plain HTTP.

    Logs once when the flag is on but the target is empty, invalid, or is the
    IP host while the TLS listener is down. A target that is this same origin
    is also skipped, so a redirect cannot loop.
    """
    if not REDIRECT:
        return True
    if not valid_https_host(HTTPS_HOST):
        _warn_once('redirect-host', 'HTTPS_REDIRECT is on but HTTPS_HOST is empty or invalid; redirect stays off')
        return True
    if _IPV4_RE.fullmatch(HTTPS_HOST) and not LISTENER_ON:
        _warn_once('redirect-ip', 'HTTPS_REDIRECT stays off: HTTPS_HOST is the IP host and TLS is down')
        return True
    if (scope.get('scheme') or '') in ('http', 'ws') and request_origin(scope) == public_origin():
        return True
    return False


def _request_path_query(scope):
    host = HTTPS_HOST if valid_https_host(HTTPS_HOST) else 'localhost'
    loc = redirect_location(scope, host)
    if not loc:
        return None
    prefix = 'https://' + host
    rest = loc[len(prefix):]
    if '?' in rest:
        path, query = rest.split('?', 1)
        return (path or '/'), query
    return (rest or '/'), ''


def redirect_url(scope):
    """Absolute URL on the configured origin, or None when the path is not safe."""
    parts = _request_path_query(scope)
    origin = public_origin()
    if not parts or not origin:
        return None
    path, query = parts
    url = origin + path
    if query:
        url += '?' + query
    return url


def _html_get(scope):
    if (scope.get('method') or 'GET').upper() != 'GET':
        return False
    path = scope.get('path') or '/'
    if path in ('/', '/index.html'):
        return True
    if not path.endswith('.html'):
        return False
    decoded = unquote(path)
    if not path.startswith('/') or path.startswith('//') or '\\' in path or '..' in decoded:
        return False
    return True


def _esc(text):
    return (text or '').replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;')


def _js(obj):
    return (json.dumps(obj, separators=(',', ':'))
            .replace('<', '\\u003c').replace('\u2028', '\\u2028').replace('\u2029', '\\u2029'))


_SCRIPT_CACHE = {'text': None}


def _client_scripts():
    if _SCRIPT_CACHE['text'] is None:
        root = Path(__file__).resolve().parents[1] / 'js'
        _SCRIPT_CACHE['text'] = (
            (root / 'storage.js').read_text(encoding='utf-8')
            + '\n' + (root / 'migrate.js').read_text(encoding='utf-8')
        )
    return _SCRIPT_CACHE['text']


def _owned_spec():
    text = (Path(__file__).resolve().parents[1] / 'js' / 'storage.js').read_text(encoding='utf-8')
    block = text.split('const KEYS = {', 1)[1].split('};', 1)[0]
    keys = tuple(re.findall(r"'([^']+)'", block))
    pref = text.split('const OWNED_PREFIXES = [', 1)[1].split('];', 1)[0]
    prefixes = tuple(re.findall(r"'([^']+)'", pref))
    return keys, prefixes


def _owned_key(name):
    keys, prefixes = _owned_spec()
    if name in keys:
        return True
    for pfx in prefixes:
        if name.startswith(pfx) and re.fullmatch(r'[A-Za-z0-9._-]{1,40}', name[len(pfx):] or ''):
            return True
    return False


def _safe_http_origin(origin):
    if not origin or not origin.startswith('http://'):
        return False
    try:
        parsed = urlparse(origin)
    except ValueError:
        return False
    if parsed.scheme != 'http' or parsed.username or parsed.password:
        return False
    if parsed.path not in ('', '/') or parsed.query or parsed.fragment:
        return False
    host = parsed.hostname or ''
    if host in ('localhost', '127.0.0.1'):
        return True
    if _IPV4_RE.fullmatch(host) and all(0 <= int(part) <= 255 for part in host.split('.')):
        return True
    if ALLOWED is not None and normalize_host(host) in ALLOWED:
        return True
    return bool(valid_https_host(host) and host == HTTPS_HOST)


def _project_ok(pid, entry):
    if not isinstance(entry, dict):
        return False
    if entry.get('id') != pid or not isinstance(pid, str) or re.fullmatch(r'[A-Za-z0-9_-]{1,80}', pid) is None:
        return False
    name = entry.get('name')
    if not isinstance(name, str) or len(name) > 80:
        return False
    updated = entry.get('updated')
    if isinstance(updated, bool) or not isinstance(updated, (int, float)):
        return False
    proj = entry.get('proj')
    if not isinstance(proj, dict):
        return False
    if 'parts' in proj and not isinstance(proj.get('parts'), list):
        return False
    if 'wires' in proj and not isinstance(proj.get('wires'), list):
        return False
    try:
        encoded = json.dumps(entry, separators=(',', ':'), ensure_ascii=False)
    except (TypeError, ValueError):
        return False
    return len(encoded) <= PROJECT_CAP


def validate_bundle(obj):
    """Empty string when the move record is acceptable. The browser checks again."""
    if not isinstance(obj, dict):
        return 'not a move record'
    if set(obj) - {'v', 'origin', 'exportedAt', 'path', 'query', 'items'}:
        return 'unexpected field'
    if obj.get('v') != 1:
        return 'unsupported version'
    origin = obj.get('origin')
    if not isinstance(origin, str) or len(origin) > 200 or re.fullmatch(r'https?://[A-Za-z0-9.-]+(?::\d{1,5})?', origin) is None:
        return 'bad origin'
    exported = obj.get('exportedAt')
    if isinstance(exported, bool) or not isinstance(exported, (int, float)):
        return 'bad time'
    path = obj.get('path') or '/'
    if not isinstance(path, str) or len(path) > 512 or not path.startswith('/') or path.startswith('//') or '\\' in path or '..' in path:
        return 'bad path'
    if any(ord(c) < 32 or ord(c) == 127 for c in path):
        return 'bad path'
    query = obj.get('query') or ''
    if not isinstance(query, str) or len(query) > 4096 or query.startswith('?') or any(ord(c) < 32 or ord(c) == 127 for c in query):
        return 'bad query'
    items = obj.get('items')
    if not isinstance(items, list) or len(items) > 64:
        return 'bad items'
    seen = set()
    projects_key = next((key for key in _owned_spec()[0] if key.endswith('projects.v1')), '')
    for item in items:
        if not isinstance(item, dict) or set(item) != {'k', 'v'}:
            return 'bad item'
        key = item.get('k')
        value = item.get('v')
        if not isinstance(key, str) or not _owned_key(key):
            return 'unknown key'
        if not isinstance(value, str) or len(value) > MIGRATE_CAP:
            return 'value too large'
        if key in seen:
            return 'duplicate key'
        seen.add(key)
        if key == projects_key:
            try:
                parsed = json.loads(value)
            except ValueError:
                return 'projects are not json'
            if not isinstance(parsed, dict):
                return 'projects are not a list'
            for pid, entry in parsed.items():
                if pid in ('__proto__', 'constructor', 'prototype') or not _project_ok(pid, entry):
                    return 'bad project'
    return ''


def unpack_payload(text):
    """Decode a move body. Oversized or corrupt input is a miss, never a log line."""
    if not isinstance(text, str) or not (text.startswith('0.') or text.startswith('1.')):
        return None
    try:
        raw = base64.urlsafe_b64decode(text[2:] + '=' * (-len(text[2:]) % 4))
        if len(raw) > MIGRATE_CAP:
            return None
        if text.startswith('1.'):
            raw = zlib.decompress(raw, max_length=MIGRATE_CAP)
        if len(raw) > MIGRATE_CAP:
            return None
        return json.loads(raw.decode('utf-8'))
    except Exception:
        return None


def _safe_back(value):
    origin = public_origin()
    if not origin:
        return '/'
    if not value or not (value == origin or value.startswith(origin + '/') or value.startswith(origin + '?')):
        return origin + '/'
    rest = value[len(origin):]
    if rest.startswith('//') or '\\' in rest or any(ord(c) < 32 or ord(c) == 127 for c in rest):
        return origin + '/'
    return value


def _page(title, boot, form_action, embedded=None, note='', extra=''):
    """Move page. The hash-clearing script is the first script and the page has no subresources."""
    nonce = secrets.token_urlsafe(18)
    csp = (
        "default-src 'none'; script-src 'nonce-%s'; style-src 'none'; img-src 'none'; "
        "font-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; "
        "base-uri 'none'; form-action %s; frame-ancestors 'none'"
    ) % (nonce, form_action)
    blob = ''
    if embedded is not None:
        blob = '<script type="application/json" id="cl-migrate-payload" nonce="%s">%s</script>' % (nonce, _js(embedded))
    html = (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<script nonce="%s">%s</script>'
        '<meta name="referrer" content="no-referrer"><title>%s</title></head><body>'
        '<p>%s</p>%s%s<script nonce="%s">%s\n%s</script></body></html>'
    ) % (nonce, _CLEAR_HASH, _esc(title), _esc(note or title), extra, blob, nonce, _client_scripts(), boot)
    return html, csp


def _fail_html(origin):
    link = ''
    if _safe_http_origin(origin):
        link = '<p><a href="%s/">Back to the original address</a></p>' % _esc(origin)
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="referrer" content="no-referrer"><title>Projects were not moved</title></head>'
        '<body><p>These projects could not be moved. Open the original address and export them from My Projects.</p>%s</body></html>'
    ) % link


def _one_header(scope, name):
    found = None
    for key, value in scope.get('headers') or ():
        if key.lower() != name:
            continue
        if found is not None:
            return None
        found = value
    return found


def _content_length(scope):
    raw = _one_header(scope, b'content-length')
    if raw is None:
        return None
    text = raw.decode('latin1', 'replace').strip()
    if not text.isdigit():
        return None
    try:
        return int(text)
    except ValueError:
        return None


def _media_type(scope):
    raw = _one_header(scope, b'content-type')
    if not raw:
        return ''
    return raw.decode('latin1', 'replace').split(';', 1)[0].strip().lower()


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
            if not redirect_suppressed(scope) and scheme != 'wss':
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
        path = scope.get('path') or '/'
        if REDIRECT and path in ('/migrate', '/migrate-done'):
            await self._migrate(scope, receive, send, scheme)
            return
        if not redirect_suppressed(scope) and scheme == 'http' and not _is_health(scope):
            if _ws_upgrade(scope):
                await _http_reply(
                    send, 403,
                    'WebSocket over plain HTTP is refused while HTTPS redirect is on. Use wss://.',
                    (), scheme,
                )
                return
            if _html_get(scope):
                await self._handoff(scope, send, scheme)
                return
            location = redirect_url(scope)
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

    async def _send_html(self, send, html, csp, scheme, status=200):
        body = html.encode('utf-8')
        headers = [
            [b'content-type', b'text/html; charset=utf-8'],
            [b'content-length', str(len(body)).encode('ascii')],
            [b'cache-control', b'no-store'],
            [b'referrer-policy', b'no-referrer'],
            [b'x-content-type-options', b'nosniff'],
            [b'content-security-policy', csp.encode('ascii')],
        ]
        headers = _merge_response_headers(headers, scheme, upgrade=False)
        await send({'type': 'http.response.start', 'status': status, 'headers': headers})
        await send({'type': 'http.response.body', 'body': body})

    async def _plain(self, send, status, body, scheme):
        await _http_reply(
            send, status, body,
            ((b'cache-control', b'no-store'), (b'referrer-policy', b'no-referrer')),
            scheme, upgrade=False,
        )

    async def _handoff(self, scope, send, scheme):
        parts = _request_path_query(scope)
        path, query = parts if parts else ('/', '')
        origin = public_origin()
        note = 'Opening the secure site…'
        link = ''
        if origin:
            href = origin + path + (('?' + query) if query else '')
            link = '<p><a href="%s">Continue</a></p>' % _esc(href)
        html, csp = _page(
            'Opening the secure site',
            'clMigrate.handoff(%s);' % _js({'target': origin, 'path': path, 'query': query}),
            origin or "'none'",
            note=note,
            extra=link,
        )
        await self._send_html(send, html, csp, scheme)

    async def _migrate(self, scope, receive, send, scheme):
        path = scope.get('path') or ''
        method = (scope.get('method') or 'GET').upper()
        origin = public_origin()
        on_target = bool(origin) and request_origin(scope) == origin
        if path == '/migrate-done' and method == 'GET':
            params = parse_qs((scope.get('query_string') or b'').decode('latin1', 'replace'), max_num_fields=4)
            back = _safe_back((params.get('back') or [''])[0])
            flag = (params.get('migrated') or [''])[0] == '1'
            html, csp = _page(
                'Finishing the move',
                'clMigrate.finish(%s);' % _js({'back': back, 'flag': flag, 'target': origin or '/'}),
                "'none'",
                note='Finishing the move…',
            )
            await self._send_html(send, html, csp, scheme)
            return
        if path == '/migrate' and method == 'GET' and on_target:
            html, csp = _page(
                'Moving your projects',
                'clMigrate.receive(%s);' % _js({'target': origin, 'confirm': HSTS_SECONDS == 0}),
                "'none'",
                note='Moving your projects…',
            )
            await self._send_html(send, html, csp, scheme)
            return
        if path == '/migrate' and method == 'POST' and on_target:
            await self._migrate_post(scope, receive, send, scheme, origin)
            return
        if not origin:
            await _http_reply(send, 400, 'bad request', (), scheme)
            return
        location = origin + path
        if not await _drain(receive):
            return
        await _http_reply(
            send, redirect_status(method), '',
            ((b'location', location.encode('ascii')),), scheme,
        )

    async def _migrate_post(self, scope, receive, send, scheme, origin):
        """Accept one form body. It is not logged, not written to disk, and not kept past this call.

        Content-Length above 2 MB is refused before the body is retained. A body
        that grows past 2 MB while streaming is refused the same way. A missing
        or unexpected content type is 415. Parse failures stay off the log,
        including uvicorn's access line, which records only the request line.
        """
        declared = _content_length(scope)
        if declared is not None and declared > MIGRATE_CAP:
            await self._plain(send, 413, b'request too large', scheme)
            return
        if _media_type(scope) != 'application/x-www-form-urlencoded':
            await self._plain(send, 415, b'unsupported media type', scheme)
            return
        payload = await _read_capped(receive, MIGRATE_CAP)
        if payload is None:
            return
        if payload is False:
            await self._plain(send, 413, b'request too large', scheme)
            return
        try:
            text = payload.decode('utf-8')
            form = parse_qs(text, keep_blank_values=False, max_num_fields=2, separator='&')
            values = form.get('payload') or []
            obj = None
            error = 'bad payload'
            if len(form) == 1 and len(values) == 1 and isinstance(values[0], str):
                obj = unpack_payload(values[0])
                error = validate_bundle(obj) if obj is not None else 'bad payload'
            if error:
                html = _fail_html(obj.get('origin') if isinstance(obj, dict) else '')
                await self._send_html(send, html, _MOVE_CSP, scheme, status=400)
                return
            html, csp = _page(
                'Moving your projects',
                'clMigrate.receive(%s);' % _js({'target': origin, 'confirm': HSTS_SECONDS == 0}),
                "'none'",
                embedded=obj,
                note='Moving your projects…',
            )
            await self._send_html(send, html, csp, scheme)
        except Exception:
            html = _fail_html('')
            await self._send_html(send, html, _MOVE_CSP, scheme, status=400)

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
