"""Google, GitHub, and optional email-code sign-in. Off unless AUTH_ENABLED=1.

The site with the flag unset is the same site as before: this middleware
does not register routes, does not set a cookie, and does not add a header.
A request under /auth is the static 404, including a POST, which would
otherwise be 405.
Provider URLs are fixed from AUTH_BASE_URL. The request's Host and forwarded
headers are never copied into redirect_uri. The client address used for the
rate limit is https.client_ip: the TCP peer, or, when that peer is in
TRUSTED_PROXY_IPS, the rightmost X-Forwarded-For address that is not itself
a trusted proxy. X-Forwarded-Proto is honored only from that same peer, and
https from it marks cl_session Secure. A provider whose flag is off
has no button and every /auth/<provider> path is 404. Google's scope is
exactly "openid email profile". GitHub's scope is exactly "read:user user:email".

No access token or refresh token is written down. The session row keeps an
opaque id. The user row keeps provider, provider_user_id, email, and display
name, keyed on (provider, provider_user_id). Two providers that share an
email stay two accounts.

Account files, including this database and any later account-saved projects,
live under the projects directory the server already uses (SIM_PROJECT_DIR,
default ~/.esp32lab/projects). The database is <projects>/accounts/auth.sqlite.
The accounts directory is mode 0700 and the files in it are mode 0600. An
AUTH_DB path that resolves outside that projects directory is ignored.

Secrets are read from the environment, including an --env-file. They are not
logged and not copied into a response. RS256 is checked with hashlib and
modular exponentiation, so this module adds no package.
"""
import base64, hashlib, hmac, json, os, re, secrets, smtplib, sqlite3, ssl, stat, threading, time, urllib.error, urllib.parse, urllib.request
from email.message import EmailMessage
from pathlib import Path

import https

LIVE_HOST = 'esp32lab.duckdns.org'
COOKIE = 'cl_session'
PENDING_S = 15 * 60
DEFAULT_SESSION_DAYS = 30
DEFAULT_RATE_MAX = 30
DEFAULT_RATE_WINDOW = 60
DEFAULT_TIMEOUT = 10
IMPORT_CAP = 1_000_000
PROJECT_CAP = 100_000
IMPORT_BATCH = 40
PROJECT_MAX = 500
CODE_MAX = 512
NEXT_MAX = 512
EMAIL_CODE_S = 600
EMAIL_RESEND_S = 60
EMAIL_ATTEMPTS = 5
EMAIL_RATE_S = 3600
EMAIL_ADDRESS_MAX = 5
EMAIL_IP_MAX = 30
GOOGLE_ISS = 'https://accounts.google.com'
GOOGLE_SCOPE = 'openid email profile'
GITHUB_SCOPE = 'read:user user:email'
SHA256_PREFIX = bytes.fromhex('3031300d060960864801650304020105000420')
_ENV_KEYS = frozenset({
    'AUTH_ENABLED', 'AUTH_GOOGLE', 'AUTH_GITHUB', 'AUTH_BASE_URL', 'AUTH_SESSION_DAYS',
    'AUTH_RATE_MAX', 'AUTH_RATE_WINDOW_S', 'AUTH_HTTP_TIMEOUT_S', 'AUTH_DB', 'AUTH_TEST_IDP',
    'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET',
    'SIM_PROJECT_DIR', 'AUTH_EMAIL', 'AUTH_SMTP_HOST', 'AUTH_SMTP_PORT',
    'AUTH_SMTP_USER', 'AUTH_SMTP_PASSWORD', 'AUTH_SMTP_FROM', 'AUTH_SMTP_SECURITY',
})
_CODE_RE = re.compile(r'[A-Za-z0-9._~/-]{1,%d}' % CODE_MAX)
_STATE_RE = re.compile(r'[A-Za-z0-9_-]{32,128}')
_ID_RE = re.compile(r'[A-Za-z0-9_-]{1,255}')
_EMAIL_RE = re.compile(r'^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}$')

ENABLED = False
GOOGLE = False
GITHUB = False
EMAIL = False
SMTP_HOST = ''
SMTP_PORT = 587
SMTP_USER = ''
SMTP_PASSWORD = ''
SMTP_FROM = ''
SMTP_SECURITY = 'starttls'
BASE = ''
SESSION_S = DEFAULT_SESSION_DAYS * 86400
RATE_MAX = DEFAULT_RATE_MAX
RATE_WINDOW = DEFAULT_RATE_WINDOW
TIMEOUT = DEFAULT_TIMEOUT
DB_PATH = ''
PROJECTS_DIR = ''
TEST_IDP = ''
GOOGLE_ID = ''
GOOGLE_SECRET = ''
GITHUB_ID = ''
GITHUB_SECRET = ''
_log = lambda msg: None
_db_lock = threading.Lock()
_db = None
_rate_lock = threading.Lock()
_rate = {}
_jwks = {'url': '', 'at': 0.0, 'ttl': 3600, 'keys': {}}
_jwks_lock = threading.Lock()


def set_logger(fn):
    global _log
    _log = fn or (lambda msg: None)


def enabled():
    return ENABLED


def _flag(env, name):
    return str(env.get(name, '0')).strip() == '1'


def _int_env(env, name, default, lo, hi):
    raw = str(env.get(name, '') or '').strip()
    if raw == '':
        return default
    if not raw.isdigit():
        _log('auth %s rejected; using %d' % (name, default))
        return default
    value = int(raw)
    if value < lo or value > hi:
        _log('auth %s rejected; using %d' % (name, default))
        return default
    return value


def _loopback_origin(value, allow_path):
    try:
        parsed = urllib.parse.urlparse(value)
    except ValueError:
        return ''
    if parsed.scheme not in ('http', 'https') or parsed.username or parsed.password:
        return ''
    if parsed.query or parsed.fragment:
        return ''
    host = (parsed.hostname or '').rstrip('.').lower()
    if host not in ('127.0.0.1', 'localhost'):
        return ''
    if parsed.port is not None and not (1 <= parsed.port <= 65535):
        return ''
    path = parsed.path or ''
    if path in ('', '/'):
        path = ''
    elif not allow_path or not path.startswith('/') or '\\' in path or '//' in path or '..' in path:
        return ''
    else:
        path = path.rstrip('/')
    netloc = host if parsed.port is None else '%s:%d' % (host, parsed.port)
    return '%s://%s%s' % (parsed.scheme, netloc, path)


def _parse_base(value):
    raw = str(value or '').strip()
    if not raw:
        return ''
    try:
        parsed = urllib.parse.urlparse(raw)
    except ValueError:
        return ''
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        return ''
    host = (parsed.hostname or '').rstrip('.').lower()
    if not host or '\\' in raw:
        return ''
    path = parsed.path or ''
    if path not in ('', '/') and (not path.startswith('/') or '\\' in path or '//' in path or '..' in path):
        return ''
    path = '' if path in ('', '/') else path.rstrip('/')
    if parsed.scheme == 'https':
        if parsed.port is not None and not (1 <= parsed.port <= 65535):
            return ''
    elif parsed.scheme == 'http':
        loop = _loopback_origin(raw, True)
        return loop
    else:
        return ''
    netloc = host if parsed.port is None else '%s:%d' % (host, parsed.port)
    return '%s://%s%s' % (parsed.scheme, netloc, path)


def _base_host(base):
    try:
        return (urllib.parse.urlparse(base).hostname or '').rstrip('.').lower()
    except ValueError:
        return ''


def _test_idp(env, base):
    """Loopback stand-in for the provider. Refused for the live host, and refused
    unless AUTH_BASE_URL is itself a loopback origin. Production cannot point
    the token request at this."""
    raw = str(env.get('AUTH_TEST_IDP', '') or '').strip()
    if not raw:
        return ''
    if _base_host(base) == LIVE_HOST:
        _log('auth test idp refused: AUTH_BASE_URL is the live host')
        return ''
    if not base or _base_host(base) not in ('127.0.0.1', 'localhost'):
        _log('auth test idp refused: AUTH_BASE_URL is not a loopback origin')
        return ''
    origin = _loopback_origin(raw, False)
    if not origin:
        _log('auth test idp refused: not a loopback origin')
        return ''
    return origin


def _close_db():
    global _db
    if _db is not None:
        try:
            _db.close()
        except sqlite3.Error:
            pass
        _db = None


def projects_dir(env=None):
    """The directory server.py already uses for /api/projects. No new mount."""
    env = os.environ if env is None else env
    proj = str(env.get('SIM_PROJECT_DIR', '') or '').strip()
    if not proj:
        proj = str(Path.home() / '.esp32lab' / 'projects')
    return Path(proj)


def _path_inside(child, parent):
    try:
        rel = Path(child).resolve().relative_to(Path(parent).resolve())
    except (OSError, ValueError):
        return False
    return bool(rel.parts)


def account_db_path(env=None):
    """SQLite file for sessions, users, and account projects.

    The default is <SIM_PROJECT_DIR>/accounts/auth.sqlite. AUTH_DB is accepted
    only when the resolved path is inside that same projects directory.
    """
    env = os.environ if env is None else env
    root = projects_dir(env)
    default = root / 'accounts' / 'auth.sqlite'
    explicit = str(env.get('AUTH_DB', '') or '').strip()
    if explicit and _path_inside(explicit, root):
        return str(Path(explicit))
    if explicit:
        _log('auth AUTH_DB rejected; account data stays in the projects directory')
    return str(default)


def apply_env(env=None):
    """Read flags and secrets. A dict from a test replaces the process environment."""
    global ENABLED, GOOGLE, GITHUB, BASE, SESSION_S, RATE_MAX, RATE_WINDOW, TIMEOUT
    global DB_PATH, PROJECTS_DIR, TEST_IDP, GOOGLE_ID, GOOGLE_SECRET, GITHUB_ID, GITHUB_SECRET
    global EMAIL, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM, SMTP_SECURITY
    env = os.environ if env is None else env
    ENABLED = _flag(env, 'AUTH_ENABLED')
    GOOGLE = _flag(env, 'AUTH_GOOGLE')
    GITHUB = _flag(env, 'AUTH_GITHUB')
    BASE = _parse_base(env.get('AUTH_BASE_URL', ''))
    if ENABLED and str(env.get('AUTH_BASE_URL', '') or '').strip() and not BASE:
        _log('auth AUTH_BASE_URL rejected; sign-in cannot build a callback')
    elif ENABLED and not BASE:
        _log('auth AUTH_BASE_URL is empty; sign-in cannot build a callback')
    SESSION_S = _int_env(env, 'AUTH_SESSION_DAYS', DEFAULT_SESSION_DAYS, 1, 365) * 86400
    RATE_MAX = _int_env(env, 'AUTH_RATE_MAX', DEFAULT_RATE_MAX, 1, 1000)
    RATE_WINDOW = _int_env(env, 'AUTH_RATE_WINDOW_S', DEFAULT_RATE_WINDOW, 1, 3600)
    TIMEOUT = _int_env(env, 'AUTH_HTTP_TIMEOUT_S', DEFAULT_TIMEOUT, 1, 30)
    GOOGLE_ID = str(env.get('GOOGLE_CLIENT_ID', '') or '').strip()
    GOOGLE_SECRET = str(env.get('GOOGLE_CLIENT_SECRET', '') or '').strip()
    GITHUB_ID = str(env.get('GITHUB_CLIENT_ID', '') or '').strip()
    GITHUB_SECRET = str(env.get('GITHUB_CLIENT_SECRET', '') or '').strip()
    EMAIL = _flag(env, 'AUTH_EMAIL')
    SMTP_HOST = str(env.get('AUTH_SMTP_HOST', '') or '').strip()
    if not re.fullmatch(r'[A-Za-z0-9.:-]{1,253}', SMTP_HOST):
        SMTP_HOST = ''
    SMTP_SECURITY = str(env.get('AUTH_SMTP_SECURITY', 'starttls') or '').strip().lower()
    SMTP_PORT = _int_env(env, 'AUTH_SMTP_PORT', 465 if SMTP_SECURITY == 'ssl' else 587, 1, 65535)
    SMTP_USER = str(env.get('AUTH_SMTP_USER', '') or '').strip()
    SMTP_PASSWORD = str(env.get('AUTH_SMTP_PASSWORD', '') or '')
    SMTP_FROM = _clean_email(env.get('AUTH_SMTP_FROM'))
    if EMAIL and not (SMTP_HOST and SMTP_FROM and SMTP_SECURITY in ('ssl', 'starttls')
                      and bool(SMTP_USER) == bool(SMTP_PASSWORD)):
        _log('auth email delivery is not configured; email sign-in is unavailable')
    TEST_IDP = _test_idp(env, BASE) if ENABLED else ''
    PROJECTS_DIR = str(projects_dir(env))
    DB_PATH = account_db_path(env)
    with _jwks_lock:
        _jwks.update(url='', at=0.0, ttl=3600, keys={})
    with _db_lock:
        _close_db()
    with _rate_lock:
        _rate.clear()


def load_env_file(path):
    """Copy allow-listed KEY=VALUE lines into the environment. Values are not logged."""
    try:
        info = os.stat(path)
        text = Path(path).read_text(encoding='utf-8')
    except OSError:
        _log('oauth env file could not be read')
        return False
    mode = stat.S_IMODE(info.st_mode)
    if mode & 0o077:
        _log('oauth env file mode allows other users to read it')
    loaded = 0
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith('#') or '=' not in stripped:
            continue
        key, value = stripped.split('=', 1)
        key = key.strip()
        if key not in _ENV_KEYS:
            continue
        if len(value) >= 2 and value[0] == value[-1] and value[0] in '"\'':
            value = value[1:-1]
        if not value or len(value) > 512 or any(ord(ch) < 32 or ord(ch) == 127 for ch in value):
            _log('oauth env file skipped an unusable line')
            continue
        if os.environ.get(key):
            continue
        os.environ[key] = value
        loaded += 1
    _log('oauth env file loaded')
    return loaded >= 0


def provider_on(name):
    if not ENABLED or not BASE:
        return False
    if name == 'google':
        return GOOGLE and bool(GOOGLE_ID) and bool(GOOGLE_SECRET)
    if name == 'github':
        return GITHUB and bool(GITHUB_ID) and bool(GITHUB_SECRET)
    if name == 'email':
        return bool(EMAIL and SMTP_HOST and SMTP_FROM and SMTP_SECURITY in ('ssl', 'starttls')
                    and bool(SMTP_USER) == bool(SMTP_PASSWORD))
    return False


def _providers():
    result = {'google': provider_on('google'), 'github': provider_on('github')}
    if EMAIL:
        result['email'] = provider_on('email')
    return result


def redirect_uri(provider):
    """Callback URL. AUTH_BASE_URL only. Request headers are not an input."""
    if provider not in ('google', 'github') or not BASE:
        return ''
    return BASE + '/auth/' + provider + '/callback'


def cookie_path():
    path = urllib.parse.urlparse(BASE).path if BASE else ''
    if not path or path == '/':
        return '/'
    return path


def mount_path():
    """Path prefix of AUTH_BASE_URL, or '' when sign-in is mounted at the origin."""
    path = urllib.parse.urlparse(BASE).path if BASE else ''
    if not path or path == '/':
        return ''
    return path.rstrip('/')


def public_href(path):
    """A root-relative URL under the AUTH_BASE_URL path.

    ``/auth/google`` on a staging mount is ``/staging/auth/google``. A path
    that already starts with the mount is left alone. With no mount this is
    the path unchanged, so a lab at the origin keeps today's links.
    """
    base = mount_path()
    if not isinstance(path, str) or not path:
        path = '/'
    if not path.startswith('/'):
        path = '/' + path
    if not base:
        return path
    if path == base or path.startswith(base + '/') or path.startswith(base + '?'):
        return path
    if path == '/':
        return base + '/'
    return base + path


def _urls():
    if TEST_IDP:
        root = TEST_IDP
        return {
            'google_auth': root + '/google/authorize',
            'google_token': root + '/google/token',
            'google_jwks': root + '/google/certs',
            'github_auth': root + '/github/authorize',
            'github_token': root + '/github/token',
            'github_user': root + '/github/user',
            'github_emails': root + '/github/emails',
        }
    return {
        'google_auth': 'https://accounts.google.com/o/oauth2/v2/auth',
        'google_token': 'https://oauth2.googleapis.com/token',
        'google_jwks': 'https://www.googleapis.com/oauth2/v3/certs',
        'github_auth': 'https://github.com/login/oauth/authorize',
        'github_token': 'https://github.com/login/oauth/access_token',
        'github_user': 'https://api.github.com/user',
        'github_emails': 'https://api.github.com/user/emails',
    }


def safe_next(value):
    """A same-origin path, or None. Rejects scheme, protocol-relative, and backslash forms."""
    if not isinstance(value, str) or not value or len(value) > NEXT_MAX:
        return None
    if not value.startswith('/') or value.startswith('//') or '\\' in value:
        return None
    if '://' in value:
        return None
    for ch in value:
        if ord(ch) < 32 or ord(ch) == 127:
            return None
    current = value
    for _ in range(2):
        current = urllib.parse.unquote(current)
        if current.startswith('//') or '\\' in current or '://' in current:
            return None
        if not current.startswith('/'):
            return None
    return value


def _ct_eq(left, right):
    a = left.encode('utf-8') if isinstance(left, str) else bytes(left or b'')
    b = right.encode('utf-8') if isinstance(right, str) else bytes(right or b'')
    if len(a) != len(b):
        hmac.compare_digest(a, a)
        return False
    return hmac.compare_digest(a, b)


def _b64url(raw):
    return base64.urlsafe_b64encode(raw).decode('ascii').rstrip('=')


def _b64url_decode(text):
    if not isinstance(text, str) or not text or len(text) > 20000:
        return None
    if not re.fullmatch(r'[A-Za-z0-9_-]+', text):
        return None
    pad = '=' * ((4 - len(text) % 4) % 4)
    try:
        return base64.urlsafe_b64decode(text + pad)
    except (ValueError, TypeError):
        return None


def _challenge(verifier):
    return _b64url(hashlib.sha256(verifier.encode('ascii')).digest())


def _rsa_pkcs1_sha256(n, e, message, signature):
    if not isinstance(n, int) or not isinstance(e, int) or e < 3 or n.bit_length() < 2000:
        return False
    k = (n.bit_length() + 7) // 8
    if not isinstance(signature, (bytes, bytearray)) or len(signature) != k:
        return False
    sig_int = int.from_bytes(signature, 'big')
    if sig_int <= 0 or sig_int >= n:
        return False
    try:
        em = pow(sig_int, e, n).to_bytes(k, 'big')
    except (ValueError, OverflowError):
        return False
    digest = hashlib.sha256(message).digest()
    tail = SHA256_PREFIX + digest
    if len(tail) + 11 > k:
        return False
    expected = b'\x00\x01' + (b'\xff' * (k - len(tail) - 3)) + b'\x00' + tail
    return hmac.compare_digest(em, expected)


def _json_bytes(raw):
    try:
        return json.loads(raw.decode('utf-8'))
    except (UnicodeError, json.JSONDecodeError, AttributeError):
        return None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def _http(method, url, body=None, headers=None, timeout=None):
    """One provider call. Timeouts and HTTP errors come back as (None, reason).
    The body of an error is returned only for the caller to parse a known code.
    Nothing here is logged."""
    hdrs = {'Accept': 'application/json', 'User-Agent': 'esp32lab-auth'}
    if headers:
        hdrs.update(headers)
    data = body if body is None or isinstance(body, bytes) else body.encode('utf-8')
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with _OPENER.open(req, timeout=timeout or TIMEOUT) as resp:
            raw = resp.read(65536)
            return resp.status, raw
    except urllib.error.HTTPError as exc:
        try:
            raw = exc.read(65536)
        except Exception:
            raw = b''
        return exc.code, raw
    except Exception:
        return None, b''


def _provider_error(raw):
    parsed = _json_bytes(raw) if raw else None
    if isinstance(parsed, dict):
        err = parsed.get('error')
        if err == 'invalid_grant':
            return 'pkce'
        if isinstance(err, str) and err in ('invalid_client', 'invalid_request', 'unauthorized_client'):
            return 'token'
    return 'token'


def _jwks_keys(url, force=False):
    now = time.time()
    with _jwks_lock:
        fresh = _jwks['url'] == url and _jwks['keys'] and (now - _jwks['at']) < _jwks['ttl']
        cached = dict(_jwks['keys']) if fresh and not force else None
    if cached is not None:
        return cached
    status, raw = _http('GET', url, timeout=TIMEOUT)
    if status != 200:
        with _jwks_lock:
            if _jwks['url'] == url and _jwks['keys']:
                return dict(_jwks['keys'])
        return None
    parsed = _json_bytes(raw)
    keys = {}
    if isinstance(parsed, dict):
        for key in parsed.get('keys') or []:
            if not isinstance(key, dict) or key.get('kty') != 'RSA':
                continue
            kid = key.get('kid')
            n = _b64url_decode(key.get('n') or '')
            e = _b64url_decode(key.get('e') or '')
            if not kid or not n or not e or not isinstance(kid, str) or len(kid) > 128:
                continue
            keys[kid] = (int.from_bytes(n, 'big'), int.from_bytes(e, 'big'))
    if not keys:
        return None
    with _jwks_lock:
        _jwks['url'] = url
        _jwks['at'] = now
        _jwks['ttl'] = 3600
        _jwks['keys'] = keys
    return dict(keys)


def _verify_google_id_token(token, nonce):
    parts = token.split('.') if isinstance(token, str) else []
    if len(parts) != 3:
        return None, 'id_token'
    header = _json_bytes(_b64url_decode(parts[0]) or b'')
    payload = _json_bytes(_b64url_decode(parts[1]) or b'')
    signature = _b64url_decode(parts[2])
    if not isinstance(header, dict) or not isinstance(payload, dict) or signature is None:
        return None, 'id_token'
    if header.get('alg') != 'RS256':
        return None, 'signature'
    kid = header.get('kid')
    if not isinstance(kid, str):
        return None, 'signature'
    keys = _jwks_keys(_urls()['google_jwks'])
    if not keys:
        return None, 'timeout'
    if kid not in keys:
        keys = _jwks_keys(_urls()['google_jwks'], force=True)
        if not keys or kid not in keys:
            return None, 'signature'
    n, e = keys[kid]
    signing = (parts[0] + '.' + parts[1]).encode('ascii')
    if not _rsa_pkcs1_sha256(n, e, signing, signature):
        return None, 'signature'
    if payload.get('iss') != GOOGLE_ISS:
        return None, 'iss'
    aud = payload.get('aud')
    if isinstance(aud, list):
        aud_ok = GOOGLE_ID in aud
    else:
        aud_ok = aud == GOOGLE_ID
    if not aud_ok:
        return None, 'aud'
    azp = payload.get('azp')
    if azp is not None and azp != GOOGLE_ID:
        return None, 'aud'
    exp = payload.get('exp')
    if not isinstance(exp, (int, float)) or exp < time.time() - 60:
        return None, 'exp'
    nbf = payload.get('nbf')
    if nbf is not None and (not isinstance(nbf, (int, float)) or nbf > time.time() + 60):
        return None, 'exp'
    if not _ct_eq(str(payload.get('nonce') or ''), nonce):
        return None, 'nonce'
    sub = payload.get('sub')
    if not isinstance(sub, str) or not _ID_RE.fullmatch(sub):
        return None, 'id_token'
    email = ''
    if payload.get('email_verified') is True:
        email = _clean_email(payload.get('email'))
    name = _clean_name(payload.get('name'), email.split('@')[0] if email else 'Google user')
    return {'provider': 'google', 'provider_user_id': sub, 'email': email, 'display_name': name}, ''


def _clean_email(value):
    if not isinstance(value, str):
        return ''
    value = value.strip().lower()
    if len(value) > 254 or not _EMAIL_RE.fullmatch(value):
        return ''
    return value


def _clean_name(value, fallback):
    if not isinstance(value, str):
        value = ''
    cleaned = ''.join(ch for ch in value if 32 <= ord(ch) < 127 or ord(ch) > 127 and ord(ch) != 0x2028).strip()
    cleaned = cleaned[:80]
    if cleaned:
        return cleaned
    fallback = ''.join(ch for ch in str(fallback or '') if 32 <= ord(ch) < 127).strip()[:80]
    return fallback or 'Signed-in user'


def _exchange_google(code, verifier, nonce):
    form = urllib.parse.urlencode({
        'grant_type': 'authorization_code',
        'code': code,
        'client_id': GOOGLE_ID,
        'client_secret': GOOGLE_SECRET,
        'redirect_uri': redirect_uri('google'),
        'code_verifier': verifier,
    }).encode('ascii')
    status, raw = _http(
        'POST', _urls()['google_token'], body=form,
        headers={'Content-Type': 'application/x-www-form-urlencoded'},
    )
    if status is None:
        return None, 'timeout'
    if status != 200:
        return None, _provider_error(raw)
    parsed = _json_bytes(raw)
    raw = b''
    if not isinstance(parsed, dict) or not isinstance(parsed.get('id_token'), str):
        return None, 'id_token'
    id_token = parsed.get('id_token')
    parsed.pop('access_token', None)
    parsed.pop('refresh_token', None)
    parsed.clear()
    ident, reason = _verify_google_id_token(id_token, nonce)
    return ident, reason


def _github_email(payload):
    if not isinstance(payload, list):
        return ''
    primary = ''
    other = ''
    for item in payload:
        if not isinstance(item, dict) or item.get('verified') is not True:
            continue
        email = _clean_email(item.get('email'))
        if not email:
            continue
        if item.get('primary') is True and not primary:
            primary = email
        elif not other:
            other = email
    return primary or other


def _exchange_github(code, verifier):
    form = urllib.parse.urlencode({
        'grant_type': 'authorization_code',
        'code': code,
        'client_id': GITHUB_ID,
        'client_secret': GITHUB_SECRET,
        'redirect_uri': redirect_uri('github'),
        'code_verifier': verifier,
    }).encode('ascii')
    status, raw = _http(
        'POST', _urls()['github_token'], body=form,
        headers={'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json'},
    )
    if status is None:
        return None, 'timeout'
    if status != 200:
        return None, _provider_error(raw)
    parsed = _json_bytes(raw)
    raw = b''
    token = parsed.get('access_token') if isinstance(parsed, dict) else ''
    if isinstance(parsed, dict):
        parsed.pop('access_token', None)
        parsed.pop('refresh_token', None)
        parsed.clear()
    if not isinstance(token, str) or not token or len(token) > 512:
        return None, 'token'
    auth_header = {'Authorization': 'Bearer ' + token, 'Accept': 'application/json'}
    token = ''
    user_status, user_raw = _http('GET', _urls()['github_user'], headers=auth_header)
    email_status, email_raw = _http('GET', _urls()['github_emails'], headers=auth_header)
    auth_header.clear()
    if user_status is None or email_status is None:
        return None, 'timeout'
    if user_status != 200 or email_status != 200:
        return None, 'token'
    user = _json_bytes(user_raw)
    if not isinstance(user, dict) or user.get('id') is None:
        return None, 'token'
    uid = str(user.get('id'))
    if not _ID_RE.fullmatch(uid):
        return None, 'token'
    email = _github_email(_json_bytes(email_raw))
    if not email:
        return None, 'email'
    name = _clean_name(user.get('name') or user.get('login'), email.split('@')[0])
    return {'provider': 'github', 'provider_user_id': uid, 'email': email, 'display_name': name}, ''


def _chmod(path, mode):
    try:
        os.chmod(path, mode)
    except OSError:
        return


def _secure_account_files(path):
    """accounts/ is 0700. The database and its SQLite sidecars are 0600."""
    directory = path.parent
    directory.mkdir(parents=True, exist_ok=True)
    if directory.name == 'accounts':
        _chmod(directory, 0o700)
    _chmod(path, 0o600)
    for suffix in ('-wal', '-shm', '-journal'):
        side = Path(str(path) + suffix)
        if side.exists():
            _chmod(side, 0o600)


def _open_db():
    global _db
    if _db is not None:
        return _db
    path = Path(DB_PATH)
    if not _path_inside(path, PROJECTS_DIR or projects_dir()):
        _log('auth database path is outside the projects directory')
        return None
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.parent.name == 'accounts':
        _chmod(path.parent, 0o700)
    conn = sqlite3.connect(str(path), timeout=5, isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA busy_timeout=3000')
    conn.execute(
        'CREATE TABLE IF NOT EXISTS users ('
        'id INTEGER PRIMARY KEY, provider TEXT NOT NULL, provider_user_id TEXT NOT NULL, '
        'email TEXT NOT NULL DEFAULT "", display_name TEXT NOT NULL DEFAULT "", created INTEGER NOT NULL, '
        'UNIQUE (provider, provider_user_id))'
    )
    conn.execute(
        'CREATE TABLE IF NOT EXISTS sessions ('
        'id TEXT PRIMARY KEY, user_id INTEGER, csrf TEXT NOT NULL, expires INTEGER NOT NULL, '
        'pending TEXT, created INTEGER NOT NULL)'
    )
    conn.execute(
        'CREATE TABLE IF NOT EXISTS owned_projects ('
        'user_id INTEGER NOT NULL, project_id TEXT NOT NULL, name TEXT NOT NULL, '
        'body TEXT NOT NULL, body_hash TEXT NOT NULL, updated INTEGER NOT NULL, '
        'PRIMARY KEY (user_id, project_id))'
    )
    conn.execute(
        'CREATE TABLE IF NOT EXISTS imports ('
        'user_id INTEGER NOT NULL, local_id TEXT NOT NULL, body_hash TEXT NOT NULL, '
        'project_id TEXT NOT NULL, PRIMARY KEY (user_id, local_id, body_hash))'
    )
    conn.execute(
        'CREATE TABLE IF NOT EXISTS email_codes ('
        'token_hash TEXT PRIMARY KEY, session_id TEXT NOT NULL, email TEXT NOT NULL, '
        'code_hash TEXT NOT NULL, next TEXT NOT NULL, expires INTEGER NOT NULL, attempts INTEGER NOT NULL)'
    )
    conn.execute(
        'CREATE TABLE IF NOT EXISTS email_limits ('
        'key TEXT PRIMARY KEY, started INTEGER NOT NULL, last_sent INTEGER NOT NULL, count INTEGER NOT NULL)'
    )
    _secure_account_files(path)
    _db = conn
    return conn


def _db_call(fn):
    with _db_lock:
        try:
            conn = _open_db()
            if conn is None:
                _log('auth store unavailable')
                return None
            return fn(conn)
        except (sqlite3.Error, OSError):
            _log('auth store unavailable')
            return None


def _new_session(conn, user_id, life):
    sid = secrets.token_urlsafe(32)
    csrf = secrets.token_urlsafe(32)
    now = int(time.time())
    conn.execute(
        'INSERT INTO sessions (id, user_id, csrf, expires, pending, created) VALUES (?,?,?,?,NULL,?)',
        (sid, user_id, csrf, now + life, now),
    )
    return sid, csrf, life


def _session_row(conn, sid):
    if not sid or not _STATE_RE.fullmatch(sid):
        return None
    row = conn.execute('SELECT * FROM sessions WHERE id = ?', (sid,)).fetchone()
    if row is None or int(row['expires']) < int(time.time()):
        if row is not None:
            conn.execute('DELETE FROM sessions WHERE id = ?', (sid,))
        return None
    return row


def _user_public(conn, user_id):
    if not user_id:
        return None
    row = conn.execute(
        'SELECT provider, display_name FROM users WHERE id = ?', (user_id,)
    ).fetchone()
    if row is None:
        return None
    return {'provider': row['provider'], 'display_name': row['display_name']}


def session_view(sid):
    def run(conn):
        row = _session_row(conn, sid)
        user = _user_public(conn, row['user_id']) if row and row['user_id'] else None
        return {
            'signed_in': bool(user),
            'display_name': user['display_name'] if user else '',
            'provider': user['provider'] if user else '',
            'csrf': row['csrf'] if row else '',
            'providers': _providers(),
            'limits': {'import_batch': IMPORT_BATCH, 'import_bytes': IMPORT_CAP, 'project_bytes': PROJECT_CAP},
            'auth_origin': BASE,
            'https_origin': '',
        }
    found = _db_call(run)
    if found is None:
        return {
            'signed_in': False, 'display_name': '', 'provider': '', 'csrf': '',
            'providers': {provider: False for provider in _providers()},
            'auth_origin': BASE, 'https_origin': '', 'unavailable': True,
            'message': 'The account service is unavailable. Try again.',
        }
    return found


def begin_login(provider, nxt, sid):
    """Bind state, PKCE, and (for Google) nonce to the pre-login session."""
    state = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(64)
    nonce = secrets.token_urlsafe(32)
    pending = json.dumps({
        'provider': provider, 'state': state, 'verifier': verifier, 'nonce': nonce,
        'next': nxt, 'exp': int(time.time()) + PENDING_S,
    }, separators=(',', ':'))

    def run(conn):
        row = _session_row(conn, sid)
        now = int(time.time())
        if row is None:
            new_sid, csrf, life = _new_session(conn, None, PENDING_S)
            conn.execute('UPDATE sessions SET pending = ?, expires = ? WHERE id = ?', (pending, now + PENDING_S, new_sid))
            return new_sid, life
        life = max(60, int(row['expires']) - now)
        conn.execute('DELETE FROM email_codes WHERE session_id = ?', (row['id'],))
        conn.execute('UPDATE sessions SET pending = ? WHERE id = ?', (pending, row['id']))
        return row['id'], life

    created = _db_call(run)
    if not created:
        return None
    new_sid, life = created
    params = {
        'response_type': 'code',
        'redirect_uri': redirect_uri(provider),
        'state': state,
        'code_challenge': _challenge(verifier),
        'code_challenge_method': 'S256',
    }
    urls = _urls()
    if provider == 'google':
        params.update({
            'client_id': GOOGLE_ID,
            'scope': GOOGLE_SCOPE,
            'nonce': nonce,
        })
        url = urls['google_auth'] + '?' + urllib.parse.urlencode(params)
    else:
        params.update({
            'client_id': GITHUB_ID,
            'scope': GITHUB_SCOPE,
        })
        url = urls['github_auth'] + '?' + urllib.parse.urlencode(params)
    return {'sid': new_sid, 'life': life, 'url': url}


def consume_pending(sid, state):
    """Constant-time state check. A match deletes the pending record before return."""
    def run(conn):
        row = _session_row(conn, sid)
        if row is None or not row['pending']:
            _ct_eq(state or '', secrets.token_urlsafe(32))
            return None
        try:
            pending = json.loads(row['pending'])
        except json.JSONDecodeError:
            return None
        if not isinstance(pending, dict) or int(pending.get('exp') or 0) < int(time.time()):
            conn.execute('UPDATE sessions SET pending = NULL WHERE id = ?', (row['id'],))
            return None
        if not _ct_eq(str(pending.get('state') or ''), state or ''):
            return None
        conn.execute('UPDATE sessions SET pending = NULL WHERE id = ?', (row['id'],))
        return pending
    return _db_call(run)


def _finish_login_row(conn, old_sid, ident):
    now = int(time.time())
    row = conn.execute(
        'SELECT id FROM users WHERE provider = ? AND provider_user_id = ?',
        (ident['provider'], ident['provider_user_id']),
    ).fetchone()
    if row is None:
        cur = conn.execute(
            'INSERT INTO users (provider, provider_user_id, email, display_name, created) VALUES (?,?,?,?,?)',
            (ident['provider'], ident['provider_user_id'], ident['email'], ident['display_name'], now),
        )
        user_id = cur.lastrowid
    else:
        user_id = row['id']
        conn.execute(
            'UPDATE users SET email = ?, display_name = ? WHERE id = ?',
            (ident['email'], ident['display_name'], user_id),
        )
    sid, csrf, life = _new_session(conn, user_id, SESSION_S)
    if old_sid:
        conn.execute('DELETE FROM sessions WHERE id = ?', (old_sid,))
        conn.execute('DELETE FROM email_codes WHERE session_id = ?', (old_sid,))
    return sid, life


def finish_login(old_sid, ident):
    """Upsert the account and rotate the session id. The old id stops working."""
    def run(conn):
        with conn:
            conn.execute('BEGIN IMMEDIATE')
            return _finish_login_row(conn, old_sid, ident)
    return _db_call(run)


def _send_email_code(address, code):
    message = EmailMessage()
    message['From'] = SMTP_FROM
    message['To'] = address
    message['Subject'] = 'Your ESP32 Circuit Lab sign-in code'
    message.set_content(
        'Your ESP32 Circuit Lab sign-in code is: %s\n\n'
        'It expires in 10 minutes and can be used once in the browser that requested it.\n'
        'Enter it at %s. Never share this code.\n'
        'If you did not request it, you can ignore this message.\n' % (code, BASE)
    )
    context = ssl.create_default_context()
    if SMTP_SECURITY == 'ssl':
        transport = smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=TIMEOUT, context=context)
    else:
        transport = smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=TIMEOUT)
    with transport as smtp:
        if SMTP_SECURITY == 'starttls':
            smtp.ehlo()
            smtp.starttls(context=context)
            smtp.ehlo()
        if SMTP_USER:
            smtp.login(SMTP_USER, SMTP_PASSWORD)
        refused = smtp.send_message(message)
        if refused:
            raise smtplib.SMTPException('delivery refused')


def _prepare_email_code(address, nxt, sid, client_ip):
    token = secrets.token_urlsafe(32)
    code = '%06d' % secrets.randbelow(1_000_000)
    token_hash = hashlib.sha256(token.encode('ascii')).hexdigest()
    # The database stores neither the code nor the random browser-held HMAC key.
    code_hash = hmac.new(token.encode('ascii'), code.encode('ascii'), hashlib.sha256).hexdigest()

    def run(conn):
        now = int(time.time())
        with conn:
            conn.execute('BEGIN IMMEDIATE')
            current = _session_row(conn, sid)
            if current and current['user_id']:
                return {'error': 'signed_in'}
            limits = [
                ('address:' + hashlib.sha256(address.encode('utf-8')).hexdigest(), EMAIL_ADDRESS_MAX, EMAIL_RESEND_S),
                ('ip:' + hashlib.sha256(client_ip.encode('utf-8')).hexdigest(), EMAIL_IP_MAX, 0),
            ]
            conn.execute('DELETE FROM email_limits WHERE started <= ?', (now - EMAIL_RATE_S,))
            conn.execute('DELETE FROM email_codes WHERE expires <= ?', (now,))
            conn.execute('DELETE FROM sessions WHERE user_id IS NULL AND expires < ?', (now,))
            for key, maximum, cooldown in limits:
                row = conn.execute('SELECT * FROM email_limits WHERE key = ?', (key,)).fetchone()
                if row and row['count'] >= maximum:
                    return {'error': 'rate', 'retry_after': max(1, row['started'] + EMAIL_RATE_S - now)}
                if row and row['last_sent'] + cooldown > now:
                    return {'error': 'rate', 'retry_after': row['last_sent'] + cooldown - now}
            for key, _maximum, _cooldown in limits:
                conn.execute(
                    'INSERT INTO email_limits (key, started, last_sent, count) VALUES (?,?,?,1) '
                    'ON CONFLICT(key) DO UPDATE SET last_sent = excluded.last_sent, count = count + 1',
                    (key, now, now),
                )
            if current:
                new_sid, csrf, life = current['id'], current['csrf'], PENDING_S
                conn.execute('UPDATE sessions SET pending = NULL, expires = ? WHERE id = ?', (now + life, new_sid))
            else:
                new_sid, csrf, life = _new_session(conn, None, PENDING_S)
            conn.execute('DELETE FROM email_codes WHERE session_id = ?', (new_sid,))
            conn.execute(
                'INSERT INTO email_codes (token_hash, session_id, email, code_hash, next, expires, attempts) '
                'VALUES (?,?,?,?,?,?,0)',
                (token_hash, new_sid, address, code_hash, nxt, now + EMAIL_CODE_S),
            )
            return {'sid': new_sid, 'csrf': csrf, 'life': life, 'token': token, 'code': code}
    return _db_call(run)


def _verify_email_code(sid, csrf, token, code):
    token_hash = hashlib.sha256(token.encode('ascii')).hexdigest()
    expected_hash = hmac.new(token.encode('ascii'), code.encode('ascii'), hashlib.sha256).hexdigest()

    def run(conn):
        with conn:
            conn.execute('BEGIN IMMEDIATE')
            session = _session_row(conn, sid)
            if not session or session['user_id'] or not _ct_eq(session['csrf'], csrf):
                return {'error': 'csrf'}
            pending = conn.execute(
                'SELECT * FROM email_codes WHERE token_hash = ? AND session_id = ?', (token_hash, sid)
            ).fetchone()
            if pending is None:
                return {'error': 'code_expired'}
            if pending['expires'] <= int(time.time()):
                conn.execute('DELETE FROM email_codes WHERE token_hash = ?', (token_hash,))
                return {'error': 'code_expired'}
            if not _ct_eq(pending['code_hash'], expected_hash):
                attempts = pending['attempts'] + 1
                if attempts >= EMAIL_ATTEMPTS:
                    conn.execute('DELETE FROM email_codes WHERE token_hash = ?', (token_hash,))
                    return {'error': 'code_locked'}
                conn.execute('UPDATE email_codes SET attempts = ? WHERE token_hash = ?', (attempts, token_hash))
                return {'error': 'code_invalid', 'attempts_left': EMAIL_ATTEMPTS - attempts}
            address = pending['email']
            ident = {
                'provider': 'email', 'provider_user_id': hashlib.sha256(address.encode('utf-8')).hexdigest(),
                'email': address, 'display_name': address,
            }
            new_sid, life = _finish_login_row(conn, sid, ident)
            return {'sid': new_sid, 'life': life, 'next': pending['next']}
    return _db_call(run)


def logout(sid, token):
    def run(conn):
        row = _session_row(conn, sid)
        if row is None or not _ct_eq(row['csrf'], token or ''):
            return False
        conn.execute('DELETE FROM sessions WHERE id = ?', (row['id'],))
        return True
    return _db_call(run) is True


def _project_item(item):
    if not isinstance(item, dict):
        return None, 'invalid_project'
    pid = item.get('id')
    if not isinstance(pid, str) or re.fullmatch(r'[A-Za-z0-9_-]{1,40}', pid) is None:
        return None, 'invalid_project'
    proj = item.get('proj')
    if proj is None and isinstance(item.get('parts'), list):
        proj = item
    if not isinstance(proj, dict) or not isinstance(proj.get('parts'), list):
        return None, 'invalid_project'
    name = item.get('name') if isinstance(item.get('name'), str) else proj.get('name')
    name = _clean_name(name if isinstance(name, str) else '', 'Untitled')
    try:
        encoded = json.dumps(proj, separators=(',', ':'), sort_keys=True)
    except (TypeError, ValueError):
        return None, 'invalid_project'
    if len(encoded.encode('utf-8')) > PROJECT_CAP:
        return None, 'project_too_large'
    digest = hashlib.sha256(encoded.encode('utf-8')).hexdigest()
    return (pid, name, encoded, digest), ''


def import_projects(sid, token, items):
    """Attach local projects to this account. The same id and body is a no-op."""
    if not isinstance(items, list) or len(items) > IMPORT_BATCH:
        return None

    def run(conn):
        row = _session_row(conn, sid)
        if row is None or not row['user_id'] or not _ct_eq(row['csrf'], token or ''):
            return None
        user_id = row['user_id']
        imported = unchanged = last_saved = 0
        rejected = []
        now = int(time.time())
        for item in items:
            parsed, reason = _project_item(item)
            if not parsed:
                rejected.append({
                    'id': str(item.get('id', ''))[:40] if isinstance(item, dict) else '',
                    'name': _clean_name(item.get('name'), 'Untitled') if isinstance(item, dict) else 'Untitled',
                    'reason': reason,
                })
                continue
            local_id, name, encoded, digest = parsed
            seen = conn.execute(
                'SELECT project_id FROM imports WHERE user_id = ? AND local_id = ? AND body_hash = ?',
                (user_id, local_id, digest),
            ).fetchone()
            if seen is not None:
                unchanged += 1
                saved = conn.execute(
                    'SELECT updated FROM owned_projects WHERE user_id = ? AND project_id = ?',
                    (user_id, seen['project_id']),
                ).fetchone()
                if saved:
                    last_saved = max(last_saved, saved['updated'])
                continue
            count = conn.execute(
                'SELECT COUNT(*) AS n FROM owned_projects WHERE user_id = ?', (user_id,)
            ).fetchone()['n']
            current = conn.execute(
                'SELECT body_hash FROM owned_projects WHERE user_id = ? AND project_id = ?',
                (user_id, local_id),
            ).fetchone()
            stored_id = local_id
            if current is not None and current['body_hash'] != digest:
                stored_id = local_id[:31] + '-' + digest[:8]
            if current is not None and current['body_hash'] == digest:
                conn.execute(
                    'INSERT OR IGNORE INTO imports (user_id, local_id, body_hash, project_id) VALUES (?,?,?,?)',
                    (user_id, local_id, digest, local_id),
                )
                unchanged += 1
                saved = conn.execute(
                    'SELECT updated FROM owned_projects WHERE user_id = ? AND project_id = ?',
                    (user_id, local_id),
                ).fetchone()
                last_saved = max(last_saved, saved['updated'])
                continue
            occupied = conn.execute(
                'SELECT body_hash FROM owned_projects WHERE user_id = ? AND project_id = ?',
                (user_id, stored_id),
            ).fetchone()
            if occupied is not None and occupied['body_hash'] == digest:
                conn.execute(
                    'INSERT OR IGNORE INTO imports (user_id, local_id, body_hash, project_id) VALUES (?,?,?,?)',
                    (user_id, local_id, digest, stored_id),
                )
                unchanged += 1
                saved = conn.execute(
                    'SELECT updated FROM owned_projects WHERE user_id = ? AND project_id = ?',
                    (user_id, stored_id),
                ).fetchone()
                last_saved = max(last_saved, saved['updated'])
                continue
            if occupied is not None:
                rejected.append({'id': local_id, 'name': name, 'reason': 'snapshot_conflict'})
                continue
            if count >= PROJECT_MAX:
                rejected.append({'id': local_id, 'name': name, 'reason': 'account_full'})
                continue
            conn.execute(
                'INSERT INTO owned_projects (user_id, project_id, name, body, body_hash, updated) VALUES (?,?,?,?,?,?)',
                (user_id, stored_id, name, encoded, digest, now),
            )
            conn.execute(
                'INSERT OR IGNORE INTO imports (user_id, local_id, body_hash, project_id) VALUES (?,?,?,?)',
                (user_id, local_id, digest, stored_id),
            )
            imported += 1
            last_saved = max(last_saved, now)
        return {'imported': imported, 'unchanged': unchanged, 'rejected': rejected, 'last_saved': last_saved}
    return _db_call(run)


def get_project(sid, project_id):
    """One account project for this session's user, or None.

    The body stays under PROJECT_CAP. Another user's id is the same as a
    missing id: nothing is returned.
    """
    if not isinstance(project_id, str) or re.fullmatch(r'[A-Za-z0-9_-]{1,40}', project_id) is None:
        return None

    def run(conn):
        row = _session_row(conn, sid)
        if row is None or not row['user_id']:
            return None
        found = conn.execute(
            'SELECT name, body, updated FROM owned_projects WHERE user_id = ? AND project_id = ?',
            (row['user_id'], project_id),
        ).fetchone()
        if found is None:
            return None
        raw = found['body'] if isinstance(found['body'], str) else ''
        if len(raw.encode('utf-8')) > PROJECT_CAP:
            return None
        try:
            proj = json.loads(raw)
        except ValueError:
            return None
        if not isinstance(proj, dict) or not isinstance(proj.get('parts'), list):
            return None
        proj['id'] = project_id
        proj['name'] = found['name']
        return {'id': project_id, 'name': found['name'], 'updated': found['updated'], 'proj': proj}
    return _db_call(run)


def list_projects(sid):
    def run(conn):
        row = _session_row(conn, sid)
        if row is None or not row['user_id']:
            return []
        rows = conn.execute(
            'SELECT project_id, name, updated FROM owned_projects WHERE user_id = ? ORDER BY updated DESC, rowid DESC',
            (row['user_id'],),
        ).fetchall()
        return [{'id': r['project_id'], 'name': r['name'], 'updated': r['updated']} for r in rows]
    found = _db_call(run)
    return found if found is not None else []


def _origin_value(url):
    """scheme://host[:port] for an absolute URL, or empty when it is not one."""
    if not isinstance(url, str) or not url or len(url) > 500:
        return ''
    parts = urllib.parse.urlsplit(url.strip())
    if parts.scheme not in ('http', 'https') or not parts.hostname or parts.username or parts.password:
        return ''
    host = parts.hostname
    port = parts.port
    default = 443 if parts.scheme == 'https' else 80
    if port is None or port == default:
        return '%s://%s' % (parts.scheme, host)
    return '%s://%s:%s' % (parts.scheme, host, port)


def _declared_origin(scope):
    """The browser's Origin, or the origin of Referer when Origin is absent."""
    origin = _header(scope, 'origin').strip()
    if origin:
        if origin == 'null':
            return 'null'
        return _origin_value(origin) or 'invalid'
    referer = _header(scope, 'referer').strip()
    if not referer:
        return ''
    return _origin_value(referer) or 'invalid'


def cross_site(scope):
    """True when Origin or Referer names a site other than AUTH_BASE_URL.

    A request with neither header is not judged here. The CSRF token still is.
    """
    declared = _declared_origin(scope)
    if not declared:
        return False
    expected = _origin_value(BASE)
    if not expected:
        return True
    return not _ct_eq(declared, expected)


def _client_ip(scope):
    return https.client_ip(scope)


def rate_limit(scope):
    """Return Retry-After seconds when this client is over the limit, else 0."""
    ip = _client_ip(scope)
    now = time.monotonic()
    with _rate_lock:
        bucket = [t for t in _rate.get(ip, []) if now - t < RATE_WINDOW]
        if len(bucket) >= RATE_MAX:
            _rate[ip] = bucket
            wait = int(RATE_WINDOW - (now - bucket[0])) + 1
            return max(1, wait)
        bucket.append(now)
        _rate[ip] = bucket
        return 0


def _header(scope, name):
    want = name.lower().encode('ascii')
    for key, value in scope.get('headers') or []:
        if key.lower() == want:
            return value.decode('latin1', 'replace')
    return ''


def _cookies(scope):
    out = {}
    for part in _header(scope, 'cookie').split(';'):
        if '=' not in part:
            continue
        key, value = part.split('=', 1)
        out[key.strip()] = value.strip()
    return out


def _query(scope):
    raw = (scope.get('query_string') or b'').decode('latin1', 'replace')
    return urllib.parse.parse_qs(raw, keep_blank_values=True, max_num_fields=16, separator='&')


def _one(params, name):
    values = params.get(name) or []
    if len(values) != 1 or not isinstance(values[0], str):
        return ''
    return values[0]


def _esc(text):
    return (str(text or '')
            .replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;'))


def _html(title, sentence, link_href='', link_label=''):
    nonce = secrets.token_urlsafe(16)
    link = ''
    if link_href and link_label:
        link = '<p><a class="go" href="%s">%s</a></p>' % (_esc(link_href), _esc(link_label))
    body = (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        '<title>%s</title><style nonce="%s">'
        'body{font:16px/1.45 system-ui,sans-serif;background:#08090b;color:#e8eaed;margin:0;padding:32px}'
        'p{max-width:36rem}a.go{display:inline-flex;align-items:center;min-height:44px;min-width:44px;'
        'padding:0 16px;border-radius:8px;background:#1b1f24;color:#e8eaed;text-decoration:none;'
        'border:1px solid #3a414a}'
        'a.go:hover{background:#2a3038}a.go:active{background:#12161b}'
        'a.go:focus-visible{outline:2px solid #67e8f9;outline-offset:2px}'
        '</style></head><body><p>%s</p>%s</body></html>'
    ) % (_esc(title), nonce, _esc(sentence), link)
    csp = (
        "default-src 'none'; style-src 'nonce-%s'; img-src 'none'; script-src 'none'; "
        "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    ) % nonce
    return body, csp


def _json(payload, status=200, extra=None):
    from starlette.responses import JSONResponse
    headers = {'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff'}
    if extra:
        headers.update(extra)
    return JSONResponse(payload, status_code=status, headers=headers)


def _page(sentence, status=200, link_href='', link_label='Try again', title='Sign-in'):
    from starlette.responses import HTMLResponse
    body, csp = _html(title, sentence, link_href, link_label)
    return HTMLResponse(body, status_code=status, headers={
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': csp,
    })


def _stamp(response, sid, life, scope):
    response.set_cookie(
        COOKIE, sid, max_age=int(life), httponly=True, secure=https.request_secure(scope),
        samesite='lax', path=cookie_path(),
    )
    return response


def _clear_cookie(response, scope):
    response.set_cookie(
        COOKIE, '', max_age=0, httponly=True, secure=https.request_secure(scope),
        samesite='lax', path=cookie_path(),
    )
    return response


def _again(provider, nxt):
    target = nxt if safe_next(nxt) else public_href('/')
    target = public_href(target)
    return public_href('/auth/%s' % provider) + '?next=' + urllib.parse.quote(target, safe='')


def _with_flag(nxt, flag):
    target = nxt if safe_next(nxt) else public_href('/')
    target = public_href(target)
    parts = urllib.parse.urlsplit(target)
    query = urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
    query = [(k, v) for k, v in query if k not in ('auth_error', 'signin')]
    query.append(('auth_error', flag))
    return urllib.parse.urlunsplit(('', '', parts.path, urllib.parse.urlencode(query), ''))


async def _read_body(receive, limit):
    size = 0
    chunks = []
    while True:
        message = await receive()
        if message['type'] == 'http.disconnect':
            return None
        if message['type'] != 'http.request':
            continue
        chunk = message.get('body') or b''
        size += len(chunk)
        if size > limit:
            return False
        chunks.append(chunk)
        if not message.get('more_body'):
            return b''.join(chunks)


def _handle_start(provider, scope):
    if not provider_on(provider):
        return _page('That sign-in option is not available.', status=404, link_href=public_href('/'), link_label='Back')
    params = _query(scope)
    nxt = safe_next(_one(params, 'next') or '/')
    if nxt is None:
        return _page('That return address was rejected.', status=400, link_href=public_href('/'), link_label='Back to the lab')
    sid = _cookies(scope).get(COOKIE, '')
    started = begin_login(provider, nxt, sid)
    if not started:
        return _page('Sign-in could not be started. Your work is still on this device.', link_href=public_href('/'), link_label='Back')
    from starlette.responses import RedirectResponse
    resp = RedirectResponse(started['url'], status_code=302, headers={
        'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    })
    return _stamp(resp, started['sid'], started['life'], scope)


def _cancel_or_error(provider, pending, error):
    nxt = pending.get('next') if isinstance(pending, dict) else '/'
    if error == 'access_denied':
        from starlette.responses import RedirectResponse
        resp = RedirectResponse(_with_flag(nxt, 'cancelled'), status_code=302, headers={
            'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
        })
        return resp
    return _page(
        'The sign-in service did not respond. Your work is still on this device.',
        link_href=_again(provider, nxt),
    )


def _handle_callback(provider, scope):
    if not provider_on(provider):
        return _page('That sign-in option is not available.', status=404, link_href=public_href('/'), link_label='Back')
    params = _query(scope)
    error = _one(params, 'error')
    state = _one(params, 'state')
    code = _one(params, 'code')
    if error and not _STATE_RE.fullmatch(state or ''):
        return _page(
            'Sign-in could not be confirmed. Your work is still on this device.',
            link_href=_again(provider, '/'),
        )
    if state and not _STATE_RE.fullmatch(state):
        return _page(
            'Sign-in could not be confirmed. Your work is still on this device.',
            link_href=_again(provider, '/'),
        )
    sid = _cookies(scope).get(COOKIE, '')
    pending = consume_pending(sid, state) if state else None
    if error:
        if error == 'access_denied' and pending:
            return _cancel_or_error(provider, pending, error)
        nxt = pending.get('next') if isinstance(pending, dict) else '/'
        if error == 'access_denied':
            return _page(
                'Sign-in could not be confirmed. Your work is still on this device.',
                link_href=_again(provider, nxt),
            )
        return _page(
            'The sign-in service did not respond. Your work is still on this device.',
            link_href=_again(provider, nxt),
        )
    if not pending or pending.get('provider') != provider:
        return _page(
            'Sign-in could not be confirmed. Your work is still on this device.',
            link_href=_again(provider, '/'),
        )
    if not _CODE_RE.fullmatch(code or ''):
        return _page(
            'Sign-in could not be confirmed. Your work is still on this device.',
            link_href=_again(provider, pending.get('next') or '/'),
        )
    if provider == 'google':
        ident, reason = _exchange_google(code, pending.get('verifier') or '', pending.get('nonce') or '')
    else:
        ident, reason = _exchange_github(code, pending.get('verifier') or '')
    if not ident:
        _log('auth provider=%s result=error reason=%s' % (provider, reason or 'token'))
        sentence = 'The sign-in service did not respond. Your work is still on this device.'
        if reason not in ('timeout',):
            sentence = 'Sign-in could not be completed. Your work is still on this device.'
        return _page(sentence, link_href=_again(provider, pending.get('next') or '/'))
    rotated = finish_login(sid, ident)
    if not rotated:
        _log('auth provider=%s result=error reason=store' % provider)
        return _page(
            'Sign-in could not be completed. Your work is still on this device.',
            link_href=_again(provider, pending.get('next') or '/'),
        )
    new_sid, life = rotated
    _log('auth provider=%s result=ok' % provider)
    from starlette.responses import RedirectResponse
    resp = RedirectResponse(_with_flag(pending.get('next') or '/', 'ok'), status_code=302, headers={
        'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    })
    return _stamp(resp, new_sid, life, scope)


def _csrf_from(headers_token, body_token):
    if isinstance(headers_token, str) and headers_token:
        return headers_token
    if isinstance(body_token, str):
        return body_token
    return ''


async def _email_input(scope, receive):
    if not _declared_origin(scope) or cross_site(scope):
        return None, _cross_site_rejected()
    if _header(scope, 'content-type').split(';', 1)[0].strip().lower() != 'application/json':
        return None, _json({'ok': False, 'error': 'type', 'message': 'Send the email form as JSON.'}, 415)
    body = await _read_body(receive, 8192)
    if body is None:
        return None, _json({'ok': False, 'error': 'closed', 'message': 'The request was interrupted. Try again.'}, 400)
    if body is False:
        return None, _json({'ok': False, 'error': 'size', 'message': 'That sign-in request is too large.'}, 413)
    parsed = _json_bytes(body)
    if not isinstance(parsed, dict):
        return None, _json({'ok': False, 'error': 'body', 'message': 'Check the sign-in form and try again.'}, 400)
    return parsed, None


async def _handle_email_start(scope, receive):
    parsed, error = await _email_input(scope, receive)
    if error is not None:
        return error
    address = _clean_email(parsed.get('email'))
    if not address:
        return _json({'ok': False, 'error': 'email', 'message': 'Enter a valid email address.'}, 422)
    nxt = safe_next(parsed.get('next', public_href('/')))
    if nxt is None:
        return _json({'ok': False, 'error': 'next', 'message': 'That return address was rejected.'}, 400)
    prepared = _prepare_email_code(address, nxt, _cookies(scope).get(COOKIE, ''), _client_ip(scope))
    if prepared is None:
        return _json({'ok': False, 'error': 'store', 'message': 'Email sign-in is unavailable. Try again later.'}, 503)
    if prepared.get('error') == 'signed_in':
        return _json({'ok': False, 'error': 'signed_in', 'message': 'Sign out before using another account.'}, 409)
    if prepared.get('error') == 'rate':
        wait = prepared['retry_after']
        return _json({'ok': False, 'error': 'rate', 'message': 'Please wait before requesting another code.',
                      'retry_after': wait}, 429, {'Retry-After': str(wait)})
    from starlette.concurrency import run_in_threadpool
    try:
        await run_in_threadpool(_send_email_code, address, prepared.pop('code'))
    except (smtplib.SMTPException, OSError):
        token_hash = hashlib.sha256(prepared['token'].encode('ascii')).hexdigest()
        _db_call(lambda conn: conn.execute('DELETE FROM email_codes WHERE token_hash = ?', (token_hash,)))
        _log('auth provider=email result=error reason=delivery')
        return _stamp(_json({
            'ok': False, 'error': 'delivery',
            'message': 'The code could not be emailed. Check the address and try again in a minute.',
            'retry_after': EMAIL_RESEND_S,
        }, 503, {'Retry-After': str(EMAIL_RESEND_S)}), prepared['sid'], prepared['life'], scope)
    return _stamp(_json({
        'ok': True, 'challenge': prepared['token'], 'csrf': prepared['csrf'],
        'expires_in': EMAIL_CODE_S, 'resend_after': EMAIL_RESEND_S,
    }), prepared['sid'], prepared['life'], scope)


async def _handle_email_verify(scope, receive):
    parsed, error = await _email_input(scope, receive)
    if error is not None:
        return error
    token = parsed.get('challenge')
    code = parsed.get('code')
    if not isinstance(token, str) or not _STATE_RE.fullmatch(token):
        return _json({'ok': False, 'error': 'code_expired', 'message': 'Request a new sign-in code.'}, 410)
    if not isinstance(code, str) or not re.fullmatch(r'[0-9]{6}', code):
        return _json({'ok': False, 'error': 'code_invalid', 'message': 'Enter the six-digit code from your email.'}, 422)
    csrf = _csrf_from(_header(scope, 'x-csrf-token'), parsed.get('csrf'))
    verified = _verify_email_code(_cookies(scope).get(COOKIE, ''), csrf, token, code)
    if verified is None:
        return _json({'ok': False, 'error': 'store', 'message': 'Sign-in could not be completed. Try again.'}, 503)
    reason = verified.get('error')
    if reason:
        messages = {
            'csrf': 'This sign-in attempt is no longer active. Request a new code.',
            'code_expired': 'That code has expired or was already used. Request a new code.',
            'code_invalid': 'That code did not match. Check the email and try again.',
            'code_locked': 'Too many incorrect codes. Request a new code.',
        }
        status = {'csrf': 403, 'code_expired': 410, 'code_invalid': 422, 'code_locked': 429}[reason]
        return _json({'ok': False, 'error': reason, 'message': messages[reason],
                      'attempts_left': verified.get('attempts_left', 0)}, status)
    _log('auth provider=email result=ok')
    return _stamp(_json({'ok': True, 'redirect': _with_flag(verified['next'], 'ok')}),
                  verified['sid'], verified['life'], scope)


def _cross_site_rejected():
    return _json(
        {'ok': False, 'error': 'csrf', 'message': 'That request was refused.'},
        403,
    )


async def _handle_logout(scope, receive):
    if cross_site(scope):
        return _cross_site_rejected()
    body = await _read_body(receive, 8192)
    if body is False:
        return _page('That sign-out was too large.', link_href=public_href('/'), link_label='Back')
    token = _header(scope, 'x-csrf-token')
    if body:
        ctype = _header(scope, 'content-type').split(';', 1)[0].strip().lower()
        if ctype == 'application/json':
            parsed = _json_bytes(body)
            if isinstance(parsed, dict):
                token = _csrf_from(token, parsed.get('csrf'))
        elif ctype == 'application/x-www-form-urlencoded':
            form = urllib.parse.parse_qs(body.decode('utf-8', 'replace'), max_num_fields=4)
            values = form.get('csrf') or []
            if len(values) == 1:
                token = _csrf_from(token, values[0])
    sid = _cookies(scope).get(COOKIE, '')
    if not logout(sid, token):
        return _json({'ok': False, 'error': 'csrf', 'message': 'Sign-out needs a fresh page. Reload and try again.'}, 403)
    return _clear_cookie(_json({'ok': True}), scope)


async def _handle_import(scope, receive):
    if cross_site(scope):
        return _cross_site_rejected()
    body = await _read_body(receive, IMPORT_CAP)
    if body is None:
        return _json({'ok': False, 'error': 'closed'}, 400)
    if body is False:
        return _json({'ok': False, 'error': 'size', 'message': 'That batch is too large. Save fewer projects at once.'}, 413)
    if _header(scope, 'content-type').split(';', 1)[0].strip().lower() != 'application/json':
        return _json({'ok': False, 'error': 'type'}, 415)
    parsed = _json_bytes(body)
    if not isinstance(parsed, dict):
        return _json({'ok': False, 'error': 'body'}, 400)
    token = _csrf_from(_header(scope, 'x-csrf-token'), parsed.get('csrf'))
    items = parsed.get('projects')
    sid = _cookies(scope).get(COOKIE, '')
    view = session_view(sid)
    if view.get('unavailable'):
        return _json({'ok': False, 'error': 'store', 'message': view['message']}, 503)
    # A guest account-save that names a locked part is refused before any row
    # is written. A signed-in save, and a guest save that names no locked part,
    # keep the existing checks (including the sign-in requirement).
    import guestparts
    if guestparts.blocks(
        guestparts.named_types(parsed),
        signed_in=bool(view.get('signed_in')),
    ):
        return guestparts.denied_response()
    if not view.get('signed_in'):
        return _json({'ok': False, 'error': 'auth', 'message': 'Sign in again before saving to your account.'}, 403)
    if not isinstance(items, list) or len(items) > IMPORT_BATCH:
        return _json({'ok': False, 'error': 'batch', 'message': 'Save at most %d projects per request.' % IMPORT_BATCH}, 400)
    saved = import_projects(sid, token, items)
    if saved is None:
        return _json({'ok': False, 'error': 'csrf', 'message': 'Sign-in is needed before projects can be saved to the account.'}, 403)
    status = 200 if not saved['rejected'] else 207 if saved['imported'] or saved['unchanged'] else 422
    return _json({'ok': not saved['rejected'], **saved}, status)


def _provider_prefix(path):
    if path == '/auth/google' or path.startswith('/auth/google/'):
        return 'google'
    if path == '/auth/github' or path.startswith('/auth/github/'):
        return 'github'
    if path == '/auth/email' or path.startswith('/auth/email/'):
        return 'email'
    return ''


def _not_found():
    from starlette.responses import PlainTextResponse
    return PlainTextResponse('not found', status_code=404, headers={
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
    })


def _account_denied():
    return _json(
        {'ok': False, 'error': 'auth', 'message': 'Sign in to see the projects in your account.'},
        401,
    )


def _account_list(scope):
    if cross_site(scope):
        return _cross_site_rejected()
    sid = _cookies(scope).get(COOKIE, '')
    view = session_view(sid)
    if view.get('unavailable'):
        return _json({'ok': False, 'error': 'store', 'message': view['message']}, 503)
    if not view.get('signed_in'):
        return _account_denied()
    return _json({'projects': list_projects(sid)})


def _account_one(scope, raw_id):
    if cross_site(scope):
        return _cross_site_rejected()
    sid = _cookies(scope).get(COOKIE, '')
    view = session_view(sid)
    if view.get('unavailable'):
        return _json({'ok': False, 'error': 'store', 'message': view['message']}, 503)
    if not view.get('signed_in'):
        return _account_denied()
    project_id = urllib.parse.unquote(raw_id or '')
    if '/' in project_id or project_id == 'import':
        return _not_found()
    found = get_project(sid, project_id)
    if not found:
        return _json(
            {'ok': False, 'error': 'missing', 'message': 'That project is not in your account.'},
            404,
        )
    return _json(found)


def _dispatch(method, path, scope, receive):
    named = _provider_prefix(path)
    if named and not provider_on(named):
        return _not_found()
    if path == '/auth/session' and method == 'GET':
        sid = _cookies(scope).get(COOKIE, '')
        view = session_view(sid)
        return _json(view, 503 if view.get('unavailable') else 200)
    if path in ('/auth/email/start', '/auth/email/verify'):
        if method != 'POST':
            return _json({'ok': False, 'error': 'method', 'message': 'Use the email sign-in form.'}, 405)
        return _handle_email_start(scope, receive) if path.endswith('/start') else _handle_email_verify(scope, receive)
    if path == '/auth/projects' and method == 'GET':
        return _account_list(scope)
    if path.startswith('/auth/projects/') and path != '/auth/projects/import' and method == 'GET':
        return _account_one(scope, path[len('/auth/projects/'):])
    if path == '/auth/google' and method == 'GET':
        return _handle_start('google', scope)
    if path == '/auth/github' and method == 'GET':
        return _handle_start('github', scope)
    if path == '/auth/google/callback' and method == 'GET':
        return _handle_callback('google', scope)
    if path == '/auth/github/callback' and method == 'GET':
        return _handle_callback('github', scope)
    if path == '/auth/logout' and method == 'POST':
        return _handle_logout(scope, receive)
    if path == '/auth/projects/import' and method == 'POST':
        return _handle_import(scope, receive)
    if path in ('/auth/google', '/auth/github', '/auth/google/callback', '/auth/github/callback', '/auth/session', '/auth/projects') and method != 'GET':
        return _page('That action is not available.', status=405, link_href=public_href('/'), link_label='Back')
    if path == '/auth/logout' and method != 'POST':
        return _page('Sign out is a button on this site.', status=405, link_href=public_href('/'), link_label='Back')
    if path == '/auth/projects/import' and method != 'POST':
        return _page('That action is not available.', status=405, link_href=public_href('/'), link_label='Back')
    provider = path.split('/')[2] if path.startswith('/auth/') and path.count('/') >= 2 else ''
    if provider and provider not in ('google', 'github', 'email', 'session', 'logout', 'projects'):
        return _page('That sign-in option is not available.', status=404, link_href=public_href('/'), link_label='Back')
    return _page('That page is not part of sign-in.', status=404, link_href=public_href('/'), link_label='Back')


class AuthMiddleware:
    """Innermost auth gate. With AUTH_ENABLED off, /auth is the static 404."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get('type') != 'http':
            await self.app(scope, receive, send)
            return
        path = scope.get('path') or ''
        if path != '/auth' and not path.startswith('/auth/'):
            await self.app(scope, receive, send)
            return
        if not ENABLED:
            # A POST would otherwise be 405 from the static app. Every auth
            # path is the same 404 as a missing page, with no cookie and no
            # database read. GET and HEAD are passed through unchanged.
            method = (scope.get('method') or 'GET').upper()
            if method not in ('GET', 'HEAD'):
                scope = dict(scope)
                scope['method'] = 'GET'
            await self.app(scope, receive, send)
            return
        wait = rate_limit(scope)
        if wait:
            _log(https.rate_limit_log(scope))
            if path == '/auth/session' or path.startswith(('/auth/email/', '/auth/projects')):
                response = _json({
                    'ok': False, 'error': 'rate',
                    'message': 'Too many account requests. Wait a moment and try again.',
                    'retry_after': wait,
                }, 429, {'Retry-After': str(wait)})
                await response(scope, receive, send)
                return
            page = _page(
                'Too many sign-in attempts. Wait a moment and try again.',
                status=429, link_href=public_href('/'), link_label='Back',
            )
            page.headers['Retry-After'] = str(wait)
            await page(scope, receive, send)
            return
        method = (scope.get('method') or 'GET').upper()
        result = _dispatch(method, path, scope, receive)
        if hasattr(result, '__await__'):
            result = await result
        await result(scope, receive, send)
