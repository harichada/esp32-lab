"""Guest starter-part limit. Off unless sign-in is on.

With AUTH_ENABLED=0 the limit is off and every part, example, compile, and
run behaves as it does today. With AUTH_ENABLED=1 the limit defaults on.
GUEST_PARTS_LIMIT=0 (or false/no/off) turns it off again while sign-in stays
on. GUEST_PARTS, when set to a non-empty comma list, replaces the starter
set. Signed-in sessions are never limited.

A compile that does not name parts is a code-only compile and is allowed:
the source does not place a part. A run is a simulation, so a guest must
name the circuit, and any type outside the starter set is rejected. The
browser solver is what draws the circuit; rejecting the run is what stops a
tweaked page from driving QEMU with a locked part. Account saves and the
server project copy are rejected the same way and are not written.
"""
from __future__ import annotations

import os
import re

# Catalog ids. Labels in the parts palette:
#   esp32         ESP32 DevKit V1
#   breadboard    Breadboard 830
#   led           LED            (not irled, not an RGB or bar-graph LED)
#   resistor      Resistor       (not a trimmer)
#   pushbutton    Pushbutton 6 mm
#   potentiometer Potentiometer  (not the 3296 trimmer)
#   buzzer        Buzzer (active) (not the passive 12085 buzzer)
# Schematic symbols, not parts you buy. Pot, Fade, and Pot (JS) place a
# ground. 3.3 V, 5 V, and a text label are the same kind of symbol.
#   ground        Ground
#   vcc33         3.3 V supply
#   vcc5          5 V supply
#   label         Text label (a net label on the sheet)
DEFAULT_PARTS = (
    'esp32', 'breadboard', 'led', 'resistor', 'pushbutton', 'potentiometer', 'buzzer',
    'ground', 'vcc33', 'vcc5', 'label',
)
MESSAGE = 'Sign in free to use this part'
_ON = {'1', 'true', 'yes', 'on'}
_OFF = {'0', 'false', 'no', 'off'}
_TYPE_RE = re.compile(r'^[A-Za-z0-9_-]{1,40}$')


def _env(env):
    return os.environ if env is None else env


def _auth_on(env) -> bool:
    return str(_env(env).get('AUTH_ENABLED', '') or '').strip().lower() in _ON


def _sign_in_on(env) -> bool:
    """Live auth flag when env is the process. A dict is read on its own."""
    if env is None:
        try:
            import auth
            return bool(getattr(auth, 'ENABLED', False))
        except ImportError:
            return _auth_on(os.environ)
    return _auth_on(env)


def enabled(env=None) -> bool:
    """True only when sign-in is on and the limit was not turned off.

    With no env dict, sign-in follows the live auth flag (apply_env), which
    is what the page and the compile route are using. A dict is for tests
    and is read on its own.
    """
    src = _env(env)
    if not _sign_in_on(env):
        return False
    raw = src.get('GUEST_PARTS_LIMIT')
    if raw is None or str(raw).strip() == '':
        return True
    return str(raw).strip().lower() in _ON


def allow_list(env=None) -> tuple:
    """Starter type ids, or GUEST_PARTS when that variable names at least one."""
    raw = str(_env(env).get('GUEST_PARTS', '') or '').strip()
    if not raw:
        return DEFAULT_PARTS
    found = []
    seen = set()
    for piece in raw.split(','):
        name = piece.strip()
        if not _TYPE_RE.fullmatch(name) or name in seen:
            continue
        seen.add(name)
        found.append(name)
    return tuple(found) if found else DEFAULT_PARTS


def meta_content(env=None) -> str:
    """The guestparts meta value. Empty when the limit is off."""
    if not enabled(env):
        return ''
    return ','.join(allow_list(env))


def _types_in(value, out, seen):
    if isinstance(value, str):
        for piece in value.split(','):
            name = piece.strip()
            if name and name not in seen:
                seen.add(name)
                out.append(name)
        return
    if isinstance(value, dict):
        if isinstance(value.get('parts'), list):
            _types_in(value.get('parts'), out, seen)
            return
        name = value.get('type')
        if isinstance(name, str) and name and name not in seen:
            seen.add(name)
            out.append(name)
        return
    if isinstance(value, (list, tuple)):
        for item in value:
            _types_in(item, out, seen)


def named_types(payload):
    """Type ids named by a compile body, a project, or a parts list.

    None means the request did not name parts (a code-only compile).
    """
    if payload is None:
        return None
    if isinstance(payload, dict):
        if 'parts' not in payload and 'project' not in payload and 'projects' not in payload:
            return None
        out, seen = [], set()
        if 'parts' in payload:
            _types_in(payload.get('parts'), out, seen)
        if isinstance(payload.get('project'), dict):
            _types_in(payload['project'], out, seen)
        projects = payload.get('projects')
        if isinstance(projects, list):
            for item in projects:
                if isinstance(item, dict) and isinstance(item.get('proj'), dict):
                    _types_in(item['proj'], out, seen)
                else:
                    _types_in(item, out, seen)
        return out
    if isinstance(payload, (list, tuple)):
        out, seen = [], set()
        _types_in(payload, out, seen)
        return out
    if isinstance(payload, str):
        out, seen = [], set()
        _types_in(payload, out, seen)
        return out
    return None


def locked_types(types, env=None) -> list:
    allowed = set(allow_list(env))
    if not types:
        return []
    return [name for name in types if name not in allowed]


def is_signed_in(cookies, env=None) -> bool:
    """True when this request's cl_session belongs to an account."""
    if not _sign_in_on(env):
        return False
    try:
        import auth
    except ImportError:
        return False
    if not getattr(auth, 'ENABLED', False):
        return False
    sid = ''
    if cookies:
        try:
            sid = cookies.get(getattr(auth, 'COOKIE', 'cl_session'), '') or ''
        except Exception:
            sid = ''
    try:
        view = auth.session_view(sid)
    except Exception:
        return False
    return bool(view and view.get('signed_in'))


def blocks(types, *, signed_in: bool, env=None, require_named: bool = False) -> bool:
    """Whether this guest request must be rejected.

    require_named is for a simulation: a missing parts list is a rejection,
    because a run with no declared circuit is how a tweaked browser would
    skip the check. A code-only compile leaves require_named false.
    """
    if not enabled(env) or signed_in:
        return False
    if types is None:
        return bool(require_named)
    return bool(locked_types(types, env))


def denied_body():
    return {'ok': False, 'error': 'guest_parts', 'message': MESSAGE}


def denied_response():
    from starlette.responses import JSONResponse
    return JSONResponse(denied_body(), status_code=403)


def reject(payload, cookies, *, require_named: bool = False, env=None):
    """A 403 response, or None when the request may proceed."""
    if not blocks(named_types(payload), signed_in=is_signed_in(cookies, env), env=env, require_named=require_named):
        return None
    return denied_response()
