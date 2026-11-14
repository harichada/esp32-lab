"""Redirect and HSTS behind Caddy. This process does not terminate TLS.

Caddy (``circuitlab-caddy``) listens on 443, holds the Let's Encrypt
certificate, and reverse-proxies to this process over plain HTTP. Off unless
the environment says otherwise, so a process with no flags keeps serving
plain HTTP and does not read forwarding headers.

HTTPS_ENABLED      default 0. Only ``1`` turns the feature on. While it is off
                   there is no redirect and no header this module would add or
                   remove. HTTP matches a process that never loaded it.
HTTPS_HOST         default empty, which leaves the redirect off. The only
                   redirect target. Never the Host header. The documented live
                   value is ``esp32lab.duckdns.org``.
HSTS_ENABLED       default 0. Only ``1`` may send Strict-Transport-Security,
                   and only on a request the trusted proxy confirmed as https.
HSTS_SECONDS       default 0. The max-age used once HSTS_ENABLED is 1.
                   No includeSubDomains, no preload. Later rollout: 300, then
                   86400, then 31536000. Values above 63072000 are rejected.
TRUSTED_PROXY_IPS  default empty, which trusts nobody. Comma-separated exact
                   IP addresses. A slash or a value that is not an IP is
                   rejected at startup and the process trusts nobody. The
                   documented address is ``172.18.0.250``.
ALLOWED_HOSTS      default unset (accept every Host). Comma-separated hostnames.
"""
import base64, ipaddress, json, os, re, secrets, threading, zlib
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

HSTS_CAP = 63072000
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

# Flags. apply_env() fills these.
ENABLED = False
HTTPS_HOST = ''
HSTS_ENABLED = False
HSTS_SECONDS = 0
ALLOWED = None  # None = accept all. A frozenset means the allow list is on.
PROXY_IPS = frozenset()
_warned = set()


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


def _flag(env, name):
    """True only for the string ``1``. Every other value, including unset, is off."""
    return str(env.get(name, '0')).strip() == '1'


def apply_env(env=None):
    """Read the flags. Called at process start and by tests."""
    global ENABLED, HTTPS_HOST, HSTS_ENABLED, HSTS_SECONDS, ALLOWED, PROXY_IPS
    env = os.environ if env is None else env
    ENABLED = _flag(env, 'HTTPS_ENABLED')
    raw_host = str(env.get('HTTPS_HOST', '') or '').strip()
    if raw_host and not valid_https_host(raw_host):
        _log('HTTPS_HOST rejected (not a single hostname); redirect target cleared')
        HTTPS_HOST = ''
    else:
        HTTPS_HOST = raw_host
    HSTS_ENABLED = _flag(env, 'HSTS_ENABLED')
    HSTS_SECONDS = _parse_hsts(env.get('HSTS_SECONDS', '0'))
    ALLOWED = _parse_allowed(env)
    PROXY_IPS = _parse_proxy_ips(env.get('TRUSTED_PROXY_IPS', ''))
    global _REDIRECT_BASE
    _REDIRECT_BASE = ''
    _warned.clear()


def _parse_proxy_ips(raw):
    """Exact IP addresses. A slash or an unparseable token trusts nobody."""
    text = str(raw or '').strip()
    if not text:
        return frozenset()
    if '/' in text:
        _log("TRUSTED_PROXY_IPS rejected (%s contains '/'); trusting nobody" % text)
        return frozenset()
    found = []
    for part in text.split(','):
        token = part.strip()
        if not token:
            _log('TRUSTED_PROXY_IPS rejected (empty address); trusting nobody')
            return frozenset()
        try:
            found.append(str(ipaddress.ip_address(token)))
        except ValueError:
            _log('TRUSTED_PROXY_IPS rejected (%s is not an IP address); trusting nobody' % token)
            return frozenset()
    return frozenset(found)


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


def redirect_status(method):
    """301 keeps GET and HEAD. 308 keeps every other method, including POST."""
    if (method or '').upper() in ('GET', 'HEAD'):
        return 301
    return 308


def _request_target(scope):
    """The raw request-target, before either HTTP parser rewrites it.

    h11 leaves ``http://host/path`` in ``raw_path``. httptools keeps only the
    path unless the protocol stashes the original bytes on ``cl_request_target``.
    """
    stamped = scope.get('cl_request_target')
    if isinstance(stamped, bytes) and stamped:
        return stamped.decode('latin1')
    if isinstance(stamped, str) and stamped:
        return stamped
    raw = scope.get('raw_path') or b''
    if isinstance(raw, str):
        text = raw
    elif raw:
        text = raw.decode('latin1')
    else:
        text = scope.get('path') or '/'
    query = scope.get('query_string') or b''
    if isinstance(query, bytes):
        query = query.decode('latin1')
    else:
        query = str(query or '')
    if query and '?' not in text:
        return text + '?' + query
    return text


def normalize_authority(scheme, netloc):
    """Lowercase host, no trailing dot, and no default port. Empty when unusable.

    Only ``http`` (port 80) and ``https`` (port 443) are accepted. A user, a
    non-default port, or a bad port stays out of the allow-list comparison by
    coming back empty or with the port still attached.
    """
    if not netloc or '@' in netloc or any(c in netloc for c in ' \t/?#\\'):
        return ''
    if (scheme or '').lower() not in ('http', 'https'):
        return ''
    text = netloc.strip().lower()
    if text.startswith('['):
        end = text.find(']')
        if end < 0:
            return ''
        host = text[:end + 1]
        rest = text[end + 1:]
        if rest.startswith(':'):
            port = rest[1:]
        elif rest:
            return ''
        else:
            port = ''
    else:
        if text.count(':') > 1:
            return ''
        host, sep, port = text.partition(':')
        if not sep:
            port = ''
        host = host.rstrip('.')
    if not host or any(c in host for c in '/\\@?#%'):
        return ''
    default = '443' if scheme.lower() == 'https' else '80'
    if not port or port == default:
        return host
    if not port.isdigit():
        return ''
    return host + ':' + port


def _parse_request_target(target):
    """Origin-form or absolute-form, parsed here. None when the target is empty.

    Absolute-form is split here, not by h11 or httptools. The allow-list
    decision and the redirect path are ours.
    """
    if isinstance(target, bytes):
        target = target.decode('latin1')
    if not isinstance(target, str) or not target:
        return None
    if target.startswith('/'):
        path, _, query = target.partition('?')
        return {'absolute': False, 'authority': None, 'path': path, 'query': query}
    scheme, sep, rest = target.partition('://')
    if not sep or '/' in scheme or '?' in scheme or not scheme:
        path, _, query = target.partition('?')
        return {'absolute': False, 'authority': None, 'path': path, 'query': query}
    if any(ord(c) < 33 or ord(c) == 127 for c in scheme) or not scheme[:1].isalpha():
        return None
    authority, sep, tail = rest.partition('/')
    if '?' in authority and not sep:
        authority, _, query = authority.partition('?')
        path, tail = '/', ''
    else:
        path = '/' + tail
        path, _, query = path.partition('?')
    if '@' in authority:
        return {'absolute': True, 'authority': '', 'path': path or '/', 'query': query}
    return {
        'absolute': True,
        'authority': normalize_authority(scheme, authority),
        'path': path or '/',
        'query': query,
    }


def _authority_allowed(name):
    if not name:
        return False
    if ALLOWED is None:
        return True
    return name in ALLOWED


def _origin_scope(scope):
    """Drop an absolute-form authority out of the path. None when it is not allowed.

    The copy carries only the path and query, so a later Location is
    ``https://HTTPS_HOST`` plus that path. The request authority is not copied.
    """
    parsed = _parse_request_target(_request_target(scope))
    if not parsed or not parsed['absolute']:
        return scope
    if not _authority_allowed(parsed['authority']):
        return None
    scope = dict(scope)
    scope['path'] = parsed['path']
    scope['raw_path'] = parsed['path'].encode('latin1', 'replace')
    scope['query_string'] = parsed['query'].encode('latin1', 'replace')
    scope.pop('cl_request_target', None)
    return scope


def redirect_location(scope, host):
    """https://<configured host><path>?<query>. None when the path is not safe to echo.

    ``host`` is the configured HTTPS_HOST. The request Host header and, for an
    absolute-form target, the request authority are not used.
    """
    if not valid_https_host(host):
        return None
    parsed = _parse_request_target(_request_target(scope))
    if not parsed:
        return None
    path = parsed['path'] or '/'
    qtext = parsed['query']
    if not path.startswith('/') or path.startswith('//') or '\\' in path:
        return None
    if any(ord(c) < 32 or ord(c) == 127 for c in path) or any(ord(c) < 32 or ord(c) == 127 or ord(c) > 127 for c in qtext):
        return None
    loc = 'https://' + host + path
    if qtext:
        loc += '?' + qtext
    return loc



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
    if HSTS_ENABLED and HSTS_SECONDS > 0:
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


def _peer_ip(scope):
    """The TCP peer, never a forwarding header. Empty when it is not an IP."""
    client = scope.get('client') or None
    if not client:
        return ''
    host = client[0]
    if isinstance(host, bytes):
        host = host.decode('ascii', 'replace')
    host = str(host or '').strip()
    if host.startswith('[') and host.endswith(']'):
        host = host[1:-1]
    try:
        return str(ipaddress.ip_address(host))
    except ValueError:
        return ''


def _forwarded_values(scope, name):
    found = []
    for key, value in scope.get('headers') or []:
        if key.lower() == name:
            try:
                text = value.decode('latin1')
            except AttributeError:
                text = str(value)
            found.append(text)
    return found


def _single_forwarded(values):
    """``('missing', '')``, ``('one', text)``, or ``('bad', '')``."""
    if not values:
        return 'missing', ''
    if len(values) != 1:
        return 'bad', ''
    text = values[0]
    if text != text.strip() or not text or any(c in text for c in ', \t\r\n'):
        return 'bad', ''
    return 'one', text


def _apply_forwarded(scope):
    """Apply X-Forwarded-Proto and X-Forwarded-Host from a trusted peer.

    A peer that is not in TRUSTED_PROXY_IPS is returned unchanged, headers and
    all. A trusted peer that sends a malformed or repeated value returns None,
    which the caller answers with 400. X-Forwarded-For is never read.
    """
    if _peer_ip(scope) not in PROXY_IPS:
        return scope
    proto_kind, proto = _single_forwarded(_forwarded_values(scope, b'x-forwarded-proto'))
    host_kind, host = _single_forwarded(_forwarded_values(scope, b'x-forwarded-host'))
    if proto_kind == 'bad' or host_kind == 'bad':
        return None
    scope = dict(scope)
    scope['headers'] = [tuple(item) for item in (scope.get('headers') or [])]
    if proto_kind == 'one':
        value = proto.lower()
        if value not in ('http', 'https'):
            return None
        websocket = scope.get('type') == 'websocket' or (scope.get('scheme') or '') in ('ws', 'wss')
        if value == 'https':
            scope['scheme'] = 'wss' if websocket else 'https'
        else:
            scope['scheme'] = 'ws' if websocket else 'http'
    if host_kind == 'one':
        name = normalize_host(host)
        if not name or not valid_https_host(name):
            return None
        if ALLOWED is not None and name not in ALLOWED:
            return None
        if ALLOWED is not None:
            encoded = host.encode('latin1')
            headers = []
            replaced = False
            for key, value in scope['headers']:
                if key.lower() == b'host':
                    headers.append((b'host', encoded))
                    replaced = True
                else:
                    headers.append((key, value))
            if not replaced:
                headers.insert(0, (b'host', encoded))
            scope['headers'] = headers
    return scope


def redirect_suppressed(scope):
    """True when this request must not be redirected.

    The redirect runs only when HTTPS_ENABLED is ``1`` and HTTPS_HOST is a
    single hostname. A request the trusted proxy already marked https, and a
    request that is already on the public origin, stay put.
    """
    if not ENABLED:
        return True
    if not valid_https_host(HTTPS_HOST):
        _warn_once('redirect-host', 'HTTPS_ENABLED is on but HTTPS_HOST is empty or invalid; redirect stays off')
        return True
    scheme = scope.get('scheme') or ''
    if scheme in ('https', 'wss'):
        return True
    if scheme in ('http', 'ws') and request_origin(scope) == public_origin():
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
        # Master flag off: do not inspect the host, do not read forwarding
        # headers, do not redirect, and do not add or remove a header.
        if not ENABLED:
            await self.app(scope, receive, send)
            return
        forwarded = _apply_forwarded(scope)
        if forwarded is None:
            socket_scheme = scope.get('scheme') or ''
            if kind == 'websocket':
                await _ws_reply(send, 400, 'bad request', socket_scheme)
            else:
                await _http_reply(send, 400, 'bad request', (), socket_scheme)
            return
        scope = forwarded
        scheme = scope.get('scheme') or ''
        scope = _origin_scope(scope)
        if scope is None:
            if kind == 'websocket':
                await _ws_reply(send, 400, 'unknown host', scheme)
            else:
                await _http_reply(send, 400, 'unknown host', (), scheme)
            return
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
        path = scope.get('path') or '/'
        if path in ('/migrate', '/migrate-done'):
            await self._migrate(scope, receive, send, scheme)
            return
        if not redirect_suppressed(scope) and scheme in ('http', 'ws') and not _is_health(scope):
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
                'clMigrate.receive(%s);' % _js({'target': origin, 'confirm': not (HSTS_ENABLED and HSTS_SECONDS > 0)}),
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
                'clMigrate.receive(%s);' % _js({'target': origin, 'confirm': not (HSTS_ENABLED and HSTS_SECONDS > 0)}),
                "'none'",
                embedded=obj,
                note='Moving your projects…',
            )
            await self._send_html(send, html, csp, scheme)
        except Exception:
            html = _fail_html('')
            await self._send_html(send, html, _MOVE_CSP, scheme, status=400)

def _quiet_server(config):
    """A uvicorn server that does not install signal handlers.

    Tests run this inside a thread. The process entry installs its own
    SIGINT and SIGTERM handlers instead.
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


def _note_request_target(scope, target):
    if isinstance(scope, dict) and target and 'cl_request_target' not in scope:
        scope['cl_request_target'] = target if isinstance(target, bytes) else str(target).encode('latin1', 'replace')


def _install_target_capture():
    """Keep the raw request-target on the scope for both HTTP parsers.

    Done once. httptools would otherwise discard the authority before the app
    runs, and the redirect would only see the path.
    """
    if getattr(_install_target_capture, 'done', False):
        return
    _install_target_capture.done = True
    try:
        from uvicorn.protocols.http import h11_impl
    except Exception:
        h11_impl = None
    try:
        from uvicorn.protocols.http import httptools_impl
    except Exception:
        httptools_impl = None

    def _wrap_cycle(cls):
        orig = cls.__init__

        def __init__(self, scope, *args, **kwargs):
            if isinstance(scope, dict) and 'cl_request_target' not in scope:
                raw = scope.get('raw_path') or b''
                query = scope.get('query_string') or b''
                if isinstance(raw, str):
                    raw = raw.encode('latin1', 'replace')
                if isinstance(query, str):
                    query = query.encode('latin1', 'replace')
                _note_request_target(scope, raw + (b'?' + query if query else b''))
            return orig(self, scope, *args, **kwargs)

        cls.__init__ = __init__

    if h11_impl is not None:
        _wrap_cycle(h11_impl.RequestResponseCycle)
    if httptools_impl is not None:
        _wrap_cycle(httptools_impl.RequestResponseCycle)
        orig = httptools_impl.HttpToolsProtocol.on_headers_complete

        def on_headers_complete(self):
            target = bytes(getattr(self, 'url', b'') or b'')
            result = orig(self)
            scope = getattr(self, 'scope', None)
            if isinstance(scope, dict) and target:
                scope['cl_request_target'] = target
            return result

        httptools_impl.HttpToolsProtocol.on_headers_complete = on_headers_complete


def _uvicorn_config(app, host, port, *, lifespan='on', log_level='warning', access_log=True):
    import uvicorn
    _install_target_capture()
    parser = (os.environ.get('UVICORN_HTTP') or 'auto').strip() or 'auto'
    # proxy_headers stays off. Forwarding headers are read only from a peer in
    # TRUSTED_PROXY_IPS. Staging tests look for this exact argument pair.
    return uvicorn.Config(
        app, host=host, port=port, log_level=log_level, access_log=access_log,
        proxy_headers=False, forwarded_allow_ips='',
        lifespan=lifespan,
        http=parser,
    )


async def serve_listeners(app, host, http_port, *, tls_port=None, signals=False,
                          log_level='warning', access_log=True, ready=None):
    """Serve one plain-HTTP listener. ``tls_port`` is accepted and ignored.

    TLS is terminated by Caddy. This process does not open a certificate socket.
    """
    import asyncio
    del tls_port
    http = _quiet_server(_uvicorn_config(
        app, host, http_port, lifespan='on', log_level=log_level, access_log=access_log,
    ))
    if signals and threading.current_thread() is threading.main_thread():
        import signal

        def _stop(signum, _frame):
            if http.should_exit:
                http.force_exit = True
            else:
                http.should_exit = True

        for sig in (signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, _stop)
    http_task = asyncio.create_task(http.serve())
    try:
        started = await _wait_started(http, http_task)
        if ready is not None:
            ready(http, None)
        if started:
            await http_task
        else:
            http.should_exit = True
            await http_task
    finally:
        http.should_exit = True


async def _wait_started(server, task, timeout=8):
    import asyncio
    import time
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
    asyncio.run(serve_listeners(app, host, port, signals=True, ready=None))


class Background:
    """One HTTP listener for tests. TLS is not started here."""

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
        self.tls_port = None
        self.ready.set()

    def stop(self):
        if self.http is not None:
            self.http.should_exit = True
        if self.thread is not None:
            self.thread.join(5)

    def __enter__(self):
        return self.start()

    def __exit__(self, *_exc):
        self.stop()
