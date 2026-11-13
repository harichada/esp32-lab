"""Server-side project copies.

A first save is POST /api/projects. The server picks the id with
secrets.token_urlsafe and responds 201 with {"id", "secret"}. That response
is the only place a new project's plaintext secret appears. PUT and DELETE
on /api/projects/<id> require the X-Edit-Secret header. The secret is stored
as a sha256 hex digest and compared with secrets.compare_digest. It is
rejected in the query string and redacted in every log line.

SIM_PROJECTS_LEGACY_OPEN=1 (the default) keeps the old unauthenticated PUT
only for a project that already exists and has no stored secret. That claim
sets a secret and returns it once. At 0, those projects are read-only.

Saves are limited after the secret check: SIM_PROJECT_SAVES_PER_MIN (default
10) per project id, and SIM_IP_SAVES_PER_MIN (default 120) per TCP peer
(request.client.host, never X-Forwarded-For). POST /api/projects is limited
by SIM_IP_CREATES_PER_MIN (default 10) per TCP peer. Each limit returns 429
with Retry-After. A failed secret does not spend the per-project budget.
It does spend the per-IP save budget. When that budget is exhausted the
response is 429 and the log line includes reason=bad_secret_rate.
"""
import hashlib
import json
import logging
import math
import os
import re
import secrets
import time
from pathlib import Path

from fastapi import Request
from fastapi.responses import JSONResponse

VIEW_ONLY = {
    'error': 'view_only',
    'message': 'You can view this project but not change it. Make a copy, or just start editing, to get your own version.',
}
FILE_RE = re.compile(r'^[\w.-]+\.(h|hpp|c|cpp|ino)$')
PART_RE = re.compile(r'^[A-Za-z0-9_-]{1,32}$')
KEY_RE = re.compile(r'^[A-Za-z0-9_]{1,32}$')
PID_RE = re.compile(r'^[A-Za-z0-9_-]{1,40}$')
_QUERY_KEYS = frozenset({'edit', 'edit_secret', 'editsecret', 'x-edit-secret'})
_HDR = re.compile(r'(?i)(x-edit-secret\s*[:=]\s*)([^\s,;]+)')
_QS = re.compile(r'(?i)([?&#](?:edit|edit_secret|editsecret|x-edit-secret)=)([^&\s#]+)')
_JSON_SECRET = re.compile(r'(?i)("(?:editSecret|secret)"\s*:\s*")([^"]*)(")')
FILE_MSG = 'That file name is not allowed. Use letters, digits, dot, underscore or hyphen, and an extension of h, hpp, c, cpp or ino.'
PART_MSG = 'That part id is not allowed. Use 1 to 32 letters, digits, underscores or hyphens.'
PROJ_MAX = 500
_PROJECT_SAVES = {}
_IP_SAVES = {}
_IP_CREATES = {}
_DIR = None
_MAX = None
LOG = logging.getLogger('esp32lab.projects')


def redact(value) -> str:
    text = str(value)
    text = _HDR.sub(r'\1[redacted]', text)
    text = _QS.sub(r'\1[redacted]', text)
    text = _JSON_SECRET.sub(r'\1[redacted]\3', text)
    return text


class _RedactFilter(logging.Filter):
    def filter(self, record):
        try:
            message = record.getMessage()
        except Exception:
            message = str(record.msg)
        record.msg = redact(message)
        record.args = ()
        return True


def install_redaction():
    filt = _RedactFilter()
    for name in ('', 'esp32lab.projects', 'uvicorn', 'uvicorn.access', 'uvicorn.error'):
        logger = logging.getLogger(name)
        if not any(isinstance(f, _RedactFilter) for f in logger.filters):
            logger.addFilter(filt)
    LOG.setLevel(logging.INFO)


def mount(app, dir_of, max_of):
    global _DIR, _MAX
    _DIR = dir_of
    _MAX = max_of
    install_redaction()

    @app.get('/api/projects')
    def proj_list():
        # Names of other people's projects are not listed.
        return []

    @app.post('/api/projects')
    async def proj_post(request: Request):
        return await _create(request)

    @app.get('/api/projects/{pid}')
    def proj_get(pid: str):
        i = _pid(pid)
        path = _json_path(i) if i else None
        if not path or not path.exists():
            return _json({'error': 'not found', 'message': 'No project with that id.'}, 404)
        try:
            data = json.loads(path.read_text())
        except Exception:
            return _json({'error': 'not found', 'message': 'No project with that id.'}, 404)
        return _json(_public(data))

    @app.put('/api/projects/{pid}')
    async def proj_put(pid: str, request: Request):
        return await _update(pid, request)

    @app.delete('/api/projects/{pid}')
    def proj_del(pid: str, request: Request):
        return _delete(pid, request)


def _default_now():
    return time.monotonic()


# Tests replace this with an injected clock. Production uses a monotonic clock.
NOW = _default_now


def reset_limits():
    _PROJECT_SAVES.clear()
    _IP_SAVES.clear()
    _IP_CREATES.clear()


def _proj_dir() -> Path:
    return Path(_DIR())


def _max_body() -> int:
    return int(_MAX())


def _pid(value):
    return value if PID_RE.fullmatch(value or '') else None


def _json(body, status=200, headers=None):
    merged = {'Cache-Control': 'no-store'}
    if headers:
        merged.update(headers)
    return JSONResponse(body, status, headers=merged)


def _audit(request: Request, status: int, note=''):
    secret = request.headers.get('x-edit-secret') or ''
    # The header value is passed through redact before it is printed or logged.
    line = redact(
        f'project {request.method} {request.url.path} X-Edit-Secret: {secret or "-"} status={status} {note}'.rstrip()
    )
    LOG.info('%s', line)
    print(line, flush=True)


def _query_has_secret(request: Request) -> bool:
    return any(key.lower() in _QUERY_KEYS for key in request.query_params.keys())


def _note_referer(request: Request):
    referer = request.headers.get('referer') or ''
    if re.search(r'(?i)(?:[?#&](?:edit|edit_secret|x-edit-secret)=|x-edit-secret\s*[:=])', referer):
        LOG.info('project %s referer contained an edit secret and was not recorded', request.method)
        print('project referer contained an edit secret and was not recorded', flush=True)


def _legacy_open() -> bool:
    return os.environ.get('SIM_PROJECTS_LEGACY_OPEN', '1') != '0'


def _cap(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except ValueError:
        return default


def _client_ip(request: Request) -> str:
    # The TCP peer only. X-Forwarded-For and every other header are ignored
    # until a signed client cookie exists.
    if request.client and request.client.host:
        return request.client.host
    return 'unknown'


def _prune(bucket, key):
    now_s = NOW()
    stamps = [stamp for stamp in bucket.get(key, []) if now_s - stamp < 60]
    bucket[key] = stamps
    return stamps


def _retry_after(stamps) -> int:
    if not stamps:
        return 60
    return max(1, math.ceil(60 - (NOW() - stamps[0])))


def _limited_bucket(bucket, key, cap: int):
    """Return Retry-After seconds when the bucket is full. Does not record a hit."""
    if cap < 0:
        cap = 0
    stamps = _prune(bucket, key)
    if len(stamps) >= cap:
        return _retry_after(stamps)
    return None


def _commit(bucket, key):
    _prune(bucket, key)
    bucket.setdefault(key, []).append(NOW())


def _reject_limit(request: Request, kind: str, retry: int, detail: str):
    line = f'project {kind} rate limit hit {detail} retry_after={retry}'
    LOG.info('%s', line)
    print(line, flush=True)
    return _json(
        {'error': 'rate_limit', 'message': 'Too many project saves from this address. Try again shortly.'},
        429,
        {'Retry-After': str(retry)},
    )


def _hash_secret(secret: str) -> str:
    return hashlib.sha256(secret.encode('utf-8')).hexdigest()


def _secret_matches(stored_hash: str, presented: str) -> bool:
    if not presented:
        return False
    got = _hash_secret(presented)
    if not stored_hash or len(stored_hash) != len(got):
        # Same-length compare even when nothing is stored, so the branch is not a shortcut.
        secrets.compare_digest(got, _hash_secret(''))
        return False
    return secrets.compare_digest(stored_hash, got)


def _json_path(pid: str) -> Path:
    return _proj_dir() / f'{pid}.json'


def _hash_path(pid: str) -> Path:
    return _proj_dir() / f'{pid}.secret'


def _read_hash(pid: str) -> str:
    path = _hash_path(pid)
    if not path.exists():
        return ''
    try:
        return path.read_text().strip()
    except OSError:
        return ''


def _write_hash(pid: str, secret: str):
    path = _hash_path(pid)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.parent / f'.{pid}.secret.tmp'
    tmp.write_text(_hash_secret(secret))
    tmp.replace(path)


def _write_project(pid: str, proj: dict):
    body = dict(proj)
    for key in ('editSecret', 'editSecretHash', 'secret', 'readOnly'):
        body.pop(key, None)
    body['id'] = pid
    folder = _proj_dir()
    folder.mkdir(parents=True, exist_ok=True)
    tmp = folder / f'.{pid}.tmp'
    tmp.write_text(json.dumps(body))
    tmp.replace(_json_path(pid))


def _public(data):
    if not isinstance(data, dict):
        return data
    out = dict(data)
    out.pop('editSecret', None)
    out.pop('editSecretHash', None)
    out.pop('secret', None)
    return out


def _reject_constant(raw):
    raise ValueError('non-finite')


def _parse_body(raw: bytes):
    try:
        data = json.loads(raw, parse_constant=_reject_constant)
    except Exception as exc:
        if 'non-finite' in str(exc) or 'NaN' in str(exc) or 'Infinity' in str(exc):
            return None, 'A property value must be a finite number.'
        return None, 'The body is not a project.'
    if not isinstance(data, dict) or not isinstance(data.get('parts'), list):
        return None, 'The body is not a project.'
    message = validate_project(data)
    if message:
        return None, message
    return data, ''


def _key_name(key):
    return key if KEY_RE.fullmatch(key or '') else 'A property'


def _finite_msg(key):
    if KEY_RE.fullmatch(key or ''):
        return f'{key} must be a finite number.'
    return 'A property value must be a finite number.'


def _range_msg(key, lo, hi):
    name = _key_name(key)
    if lo is not None and hi is not None:
        return f'{name} must be between {lo} and {hi}.'
    if lo is not None:
        return f'{name} must be at least {lo}.'
    if hi is not None:
        return f'{name} must be at most {hi}.'
    return _finite_msg(key)


def _bounds():
    path = Path(__file__).with_name('prop_bounds.json')
    try:
        return json.loads(path.read_text())
    except Exception:
        return {}


def _walk_finite(value, key=''):
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return ''
    if isinstance(value, (int, float)):
        if not math.isfinite(value):
            return _finite_msg(key)
        return ''
    if isinstance(value, dict):
        for child_key, child in value.items():
            message = _walk_finite(child, str(child_key))
            if message:
                return message
        return ''
    if isinstance(value, list):
        for child in value:
            message = _walk_finite(child, key)
            if message:
                return message
    return ''


def validate_project(proj: dict) -> str:
    files = proj.get('files')
    if files is not None:
        if not isinstance(files, dict):
            return 'Project files are not valid.'
        for name, text in files.items():
            if not isinstance(name, str) or not FILE_RE.fullmatch(name):
                return FILE_MSG
            if not isinstance(text, str):
                return 'A project file must be text.'
    bounds = _bounds()
    for part in proj.get('parts') or []:
        if not isinstance(part, dict) or not PART_RE.fullmatch(str(part.get('id') or '')):
            return PART_MSG
        props = part.get('props')
        if props is None:
            continue
        if not isinstance(props, dict):
            return 'A part property is not valid.'
        known = {row[0]: row for row in bounds.get(part.get('type') or '', [])}
        for key, value in props.items():
            spec = known.get(key)
            if isinstance(value, bool):
                if spec:
                    return _finite_msg(key)
                continue
            if isinstance(value, (int, float)) and not math.isfinite(value):
                return _finite_msg(key)
            if not spec:
                continue
            lo, hi = spec[1], spec[2]
            if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
                return _finite_msg(key)
            if lo is not None and value < lo:
                return _range_msg(key, lo, hi)
            if hi is not None and value > hi:
                return _range_msg(key, lo, hi)
    return _walk_finite(proj.get('wires') or [])


def _new_id() -> str:
    folder = _proj_dir()
    for _ in range(8):
        pid = secrets.token_urlsafe(12)
        if _pid(pid) and not (folder / f'{pid}.json').exists():
            return pid
    raise RuntimeError('could not allocate a project id')


def _too_many(pid: str) -> bool:
    folder = _proj_dir()
    if not folder.exists():
        return False
    if (folder / f'{pid}.json').exists():
        return False
    return len(list(folder.glob('*.json'))) >= PROJ_MAX


def _limited(request: Request):
    _note_referer(request)
    if _query_has_secret(request):
        print('project request rejected: edit secret was in the query string', flush=True)
        LOG.info('project request rejected: edit secret was in the query string')
        return _json({
            'error': 'secret_in_url',
            'message': 'Send the edit secret in the X-Edit-Secret header, not the URL.',
        }, 400)
    return None


async def _read_request(request: Request):
    rejected = _limited(request)
    if rejected:
        return None, rejected
    raw = await request.body()
    if len(raw) > _max_body():
        return None, _json({'error': 'too large', 'message': 'The project is too large.'}, 413)
    data, message = _parse_body(raw)
    if message:
        code = 'invalid' if message not in ('The body is not a project.',) else 'not a project'
        return None, _json({'error': code, 'message': message}, 400)
    return data, None


def _allow_create(request: Request):
    ip = _client_ip(request)
    retry = _limited_bucket(_IP_CREATES, ip, _cap('SIM_IP_CREATES_PER_MIN', 10))
    if retry is not None:
        return _reject_limit(request, 'create', retry, f'ip={ip}')
    _commit(_IP_CREATES, ip)
    return None


def _charge_bad_secret(request: Request):
    """A wrong edit secret spends the shared per-IP save budget, not the project budget."""
    ip = _client_ip(request)
    retry = _limited_bucket(_IP_SAVES, ip, _cap('SIM_IP_SAVES_PER_MIN', 120))
    if retry is not None:
        return _reject_limit(request, 'ip-save', retry, f'ip={ip} reason=bad_secret_rate')
    _commit(_IP_SAVES, ip)
    return None


def _allow_save(request: Request, pid: str):
    """Count a save only after the edit secret has been accepted."""
    ip = _client_ip(request)
    ip_retry = _limited_bucket(_IP_SAVES, ip, _cap('SIM_IP_SAVES_PER_MIN', 120))
    if ip_retry is not None:
        return _reject_limit(request, 'ip-save', ip_retry, f'ip={ip}')
    proj_retry = _limited_bucket(_PROJECT_SAVES, pid, _cap('SIM_PROJECT_SAVES_PER_MIN', 10))
    if proj_retry is not None:
        return _reject_limit(request, 'project-save', proj_retry, f'ip={ip} project={pid}')
    _commit(_IP_SAVES, ip)
    _commit(_PROJECT_SAVES, pid)
    return None


async def _create(request: Request):
    data, rejected = await _read_request(request)
    if rejected:
        return rejected
    limited = _allow_create(request)
    if limited:
        return limited
    if _too_many(''):
        return _json({'error': 'project limit', 'message': 'The server cannot store another project.'}, 507)
    pid = _new_id()
    secret = secrets.token_urlsafe(32)
    _write_project(pid, data)
    _write_hash(pid, secret)
    _audit(request, 201, 'created')
    # Plaintext secret: this 201 body only. It is not written into the project file.
    return _json({'id': pid, 'secret': secret}, 201)


async def _update(pid: str, request: Request):
    i = _pid(pid)
    if not i:
        return _json({'error': 'bad id', 'message': 'That project id is not valid.'}, 400)
    data, rejected = await _read_request(request)
    if rejected:
        return rejected
    path = _json_path(i)
    if not path.exists():
        _audit(request, 404)
        return _json({'error': 'not found', 'message': 'No project with that id.'}, 404)
    if _too_many(i):
        return _json({'error': 'project limit', 'message': 'The server cannot store another project.'}, 507)
    stored = _read_hash(i)
    presented = request.headers.get('x-edit-secret') or ''
    if not stored:
        if not _legacy_open():
            _audit(request, 403, 'legacy-closed')
            return _json(VIEW_ONLY, 403)
        limited = _allow_save(request, i)
        if limited:
            return limited
        secret = secrets.token_urlsafe(32)
        _write_project(i, data)
        _write_hash(i, secret)
        _audit(request, 200, 'claimed')
        # Grandfathered projects have no hash yet. This old PUT is the one time their secret is returned.
        return _json({'id': i, 'secret': secret})
    if not _secret_matches(stored, presented):
        # Counted on the per-IP save budget only. The owner's project budget stays put.
        limited = _charge_bad_secret(request)
        if limited:
            return limited
        _audit(request, 403)
        return _json(VIEW_ONLY, 403)
    limited = _allow_save(request, i)
    if limited:
        return limited
    _write_project(i, data)
    _audit(request, 200)
    return _json({'id': i})


def _delete(pid: str, request: Request):
    rejected = _limited(request)
    if rejected:
        return rejected
    i = _pid(pid)
    if not i:
        return _json({'error': 'bad id', 'message': 'That project id is not valid.'}, 400)
    path = _json_path(i)
    if not path.exists():
        _audit(request, 404)
        return _json({'error': 'not found', 'message': 'No project with that id.'}, 404)
    stored = _read_hash(i)
    presented = request.headers.get('x-edit-secret') or ''
    # A project with no secret is not deleted until a save has claimed it.
    if not stored or not _secret_matches(stored, presented):
        _audit(request, 403)
        return _json(VIEW_ONLY, 403)
    path.unlink()
    hash_path = _hash_path(i)
    if hash_path.exists():
        hash_path.unlink()
    _audit(request, 200, 'deleted')
    return _json({'ok': True})
