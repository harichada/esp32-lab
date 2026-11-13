"""Compile-time include checks and the arduino-cli sandbox.

The literal ``#include`` scan in ``server.check_sources`` runs first. This module
then asks the C preprocessor which files a sketch actually opens, and runs
``arduino-cli`` in a mount namespace that cannot see the rest of the host.

``SIM_COMPILE_SANDBOX`` defaults to on. The only value that runs the compiler
on the host is the literal ``off`` (``SIM_SANDBOX=off`` is the same switch
when the primary variable is unset). Unset, ``0``, ``auto``, and any other
value keep the sandbox on. If bubblewrap is missing, the probe fails, or the
seccomp filter cannot load, compilation is refused. There is no docker
fallback and no unsandboxed fallback for an unset flag.

The filter loaded with ``bwrap --seccomp`` is a small classic-BPF deny-list
built in this file. It is not ``deploy/seccomp-bwrap.json`` (that file is the
container profile applied outside the process).
"""

from __future__ import annotations

import os
import re
import shutil
import struct
import subprocess
import tempfile
import time
from pathlib import Path

import diskkeep

OUTSIDE_MSG = (
    'This sketch tries to include a file from outside the project. '
    'Use a library name like <WiFi.h> or a file in your sketch.')
ASM_MSG = (
    'This sketch tries to embed a file with an assembler include (.incbin or .include). '
    'Only libraries and files in your project can be included.')
SCAN_MSG = (
    "We couldn't check this sketch's #include lines, so it wasn't built. "
    'Check them for typos, then press Run again.')
SANDBOX_MSG = (
    "The build server had a problem. Your code wasn't the cause. "
    'Please try again in a minute.')
UNSUPPORTED_MSG = (
    "This sketch uses an include this builder can't check. "
    'Only libraries and files in your project can be included.')
LIBRARY_MSG = (
    "Circuit Lab doesn't have a library called {name}. "
    'Check the spelling and capital letters, since names must match exactly, then press Run again.')
_LIBRARY_NAME = re.compile(r'^[A-Za-z0-9_.\-/]{1,64}$')
_NET_HEADER = re.compile(
    r'#\s*include\s*[<"](?:WiFi|HTTPClient|WiFiClient\w*|WiFiUdp|NetworkClient\w*'
    r'|WiFiServer|WebServer|HTTPUpdate|WiFiMulti|ESPmDNS|AsyncUDP|Ethernet)\.h[>"]')

_ASM_RE = re.compile(
    r'(?<![A-Za-z0-9_])\.\s*inc\s*bin\b|(?<![A-Za-z0-9_])\.\s*include\b',
    re.IGNORECASE)
_INCLUDE_LINE = re.compile(r'^\s*#\s*include\b(.*)$', re.MULTILINE)
_MACRO_INCLUDE = re.compile(r'^\s*#\s*include\s+[A-Za-z_]', re.MULTILINE)
# A real asm token. "Tasmota" in the remote example must not count.
_ASM_TOKEN = re.compile(r'(?<![A-Za-z0-9_])(?:__)?asm(?:__)?(?![A-Za-z0-9_])')
_ALIAS_RE = re.compile(r'^\s*#\s*define\s+([A-Za-z_]\w*)\s+__has_include\s*$', re.MULTILINE)
_TU_SUFFIXES = {'.c', '.cpp', '.cc', '.ino'}

# Tests set this to 'off', 'bwrap', 'docker', or 'missing'. None uses the environment.
_backend_override = None
# Tests set this to a string to make the dependency scan fail before it runs gcc.
_scan_fault = None
_bwrap_ok = None
_bwrap_reason = ''
_bwrap_checked_at = None
# Tests set these to True or False to skip the live probe. None probes.
_works_override = None
_seccomp_override = None
_seccomp_ok = None
_seccomp_reason = ''
_seccomp_checked_at = None
_PROBE_TTL = 60.0

# Classic BPF. SECCOMP_RET_ERRNO | EPERM, so a denied call returns EPERM.
_BPF_LD_W_ABS = 0x00 | 0x00 | 0x20
_BPF_JEQ_K = 0x05 | 0x10 | 0x00
_BPF_RET_K = 0x06 | 0x00
_SECCOMP_RET_ALLOW = 0x7FFF0000
_SECCOMP_RET_EPERM = 0x00050000 | 1
# Names the filter refuses. Numbers are the native syscall id seccomp sees.
_SECCOMP_DENY = {
    'x86_64': {
        'ptrace': 101, 'mount': 165, 'umount2': 166, 'pivot_root': 155,
        'kexec_load': 246, 'init_module': 175, 'finit_module': 313,
        'delete_module': 176, 'bpf': 321, 'perf_event_open': 298,
        'keyctl': 250, 'add_key': 248, 'request_key': 249,
        'userfaultfd': 323, 'unshare': 272, 'setns': 308,
        'process_vm_readv': 310, 'process_vm_writev': 311,
    },
    'aarch64': {
        'ptrace': 117, 'mount': 40, 'umount2': 39, 'pivot_root': 41,
        'kexec_load': 104, 'init_module': 105, 'finit_module': 273,
        'delete_module': 106, 'bpf': 280, 'perf_event_open': 241,
        'keyctl': 219, 'add_key': 217, 'request_key': 218,
        'userfaultfd': 282, 'unshare': 97, 'setns': 268,
        'process_vm_readv': 270, 'process_vm_writev': 271,
    },
}

_SYSTEM_RO = ('/usr', '/usr/local', '/lib', '/lib64', '/bin', '/sbin')
_ETC_FILES = ('/etc/ld.so.cache', '/etc/ld.so.conf', '/etc/passwd', '/etc/group', '/etc/nsswitch.conf')
_ETC_DIRS = ('/etc/ld.so.conf.d', '/etc/alternatives')
_PASS_ENV = (
    'ARDUINO_DIRECTORIES_DATA', 'ARDUINO_DIRECTORIES_USER', 'ARDUINO_DIRECTORIES_DOWNLOADS',
    'ARDUINO_BUILD_CACHE_PATH', 'ARDUINO_DATA_DIR', 'XDG_CACHE_HOME', 'ARDUINO_CLI',
)


def outside_message(path: str) -> str:
    """The learner message. The path is not repeated."""
    return OUTSIDE_MSG


def library_label(header: str) -> str | None:
    """Basename shown to the learner, or None when it is not a plain library name.

    A 65-character name is not cut down to 64. It is omitted.
    """
    name = str(header).replace('\\', '/').rsplit('/', 1)[-1]
    if _LIBRARY_NAME.fullmatch(name):
        return name
    return None


def library_message(header: str) -> str:
    label = library_label(header)
    return LIBRARY_MSG.format(name=label if label is not None else 'this library')


def library_log_name(header: str) -> str:
    label = library_label(header)
    return label if label is not None else 'invalid'


def library_log_from_message(message: str) -> str:
    """``lib=`` value from the learner sentence. Never the raw header."""
    found = re.search(r"called (.+)\. Check the spelling", message or '')
    if not found:
        return 'invalid'
    name = found.group(1)
    if name == 'this library' or not _LIBRARY_NAME.fullmatch(name):
        return 'invalid'
    return name


def net_notice_enabled(env=None) -> bool:
    """``SIM_NET_NOTICE`` defaults to on. Read when the compile response is built."""
    env = os.environ if env is None else env
    return env.get('SIM_NET_NOTICE', '1') != '0'


def sketch_uses_network(sketch: str, files=None) -> bool:
    """True when the include scan sees a network header. Comments do not count."""
    parts = [sketch or '']
    if isinstance(files, dict):
        parts.extend(value for value in files.values() if isinstance(value, str))
    blob = '\n'.join(normalize_source(part) for part in parts)
    return _NET_HEADER.search(blob) is not None


def net_blocked_notice(sketch: str, files=None, env=None) -> bool:
    if not net_notice_enabled(env):
        return False
    return sketch_uses_network(sketch, files)


def present_include_error(err: str | None) -> str | None:
    """Turn a ``check_sources`` string into the sentence the browser shows."""
    if not err:
        return None
    if err.startswith('This sketch'):
        return err
    found = re.match(r'forbidden include path:\s*(.*)$', err)
    if found:
        return outside_message(found.group(1).strip())
    if err.startswith('forbidden directive') and (
            'include_next' in err or re.search(r'\bimport\b', err)):
        return UNSUPPORTED_MSG
    if err.startswith('forbidden directive') and 'incbin' in err.lower():
        return ASM_MSG
    if err.startswith('unsupported #include form'):
        return UNSUPPORTED_MSG
    if err.startswith('include not in allowlist'):
        header = err.split(':', 1)[-1].strip()
        return library_message(header)
    return 'rejected: ' + err


def splice_lines(src: str) -> str:
    return re.sub(r'\\\r?\n', '', src or '')


def strip_comments(src: str) -> str:
    """Remove C comments. Strings keep their backslash escapes."""
    out = []
    i = 0
    n = len(src)
    while i < n:
        if src.startswith('//', i):
            j = src.find('\n', i)
            if j < 0:
                break
            out.append('\n')
            i = j + 1
            continue
        if src.startswith('/*', i):
            j = src.find('*/', i + 2)
            out.append(' ')
            i = n if j < 0 else j + 2
            continue
        if src[i] in '"\'':
            quote = src[i]
            out.append(quote)
            i += 1
            while i < n:
                out.append(src[i])
                if src[i] == '\\' and i + 1 < n:
                    out.append(src[i + 1])
                    i += 2
                    continue
                if src[i] == quote:
                    i += 1
                    break
                i += 1
            continue
        out.append(src[i])
        i += 1
    return ''.join(out)


def normalize_source(src: str) -> str:
    """Preprocessor phases 2 and 3: line splicing, then comments."""
    return strip_comments(splice_lines(src))


def _decode_escapes(body: str) -> str:
    def repl(match):
        esc = match.group(0)
        if len(esc) == 2 and esc[1] in '"\'\\?nrtabfv':
            return {'n': '\n', 'r': '\r', 't': '\t', 'a': '\a', 'b': '\b', 'f': '\f', 'v': '\v',
                    '"': '"', "'": "'", '\\': '\\', '?': '?'}.get(esc[1], esc[1])
        if esc.startswith('\\x'):
            try:
                return chr(int(esc[2:], 16) & 0xFF)
            except ValueError:
                return esc
        if re.fullmatch(r'\\[0-7]{1,3}', esc):
            return chr(int(esc[1:], 8) & 0xFF)
        return esc[1:] if len(esc) > 1 else esc

    return re.sub(r'\\x[0-9A-Fa-f]{1,2}|\\[0-7]{1,3}|\\.', repl, body)


def concat_strings(src: str) -> str:
    """Join adjacent C string literals and decode simple escapes inside them."""
    out = []
    i = 0
    n = len(src)
    while i < n:
        if src[i] != '"':
            out.append(src[i])
            i += 1
            continue
        chunks = []
        while i < n and src[i] == '"':
            j = i + 1
            while j < n:
                if src[j] == '\\' and j + 1 < n:
                    j += 2
                    continue
                if src[j] == '"':
                    break
                j += 1
            chunks.append(_decode_escapes(src[i + 1:j if j <= n else n]))
            i = j + 1 if j < n and src[j] == '"' else j
            k = i
            while k < n and src[k] in ' \t\r\n':
                k += 1
            if k < n and src[k] == '"':
                i = k
                continue
            break
        out.append('"' + ''.join(chunks) + '"')
    return ''.join(out)


def has_asm_directive(src: str) -> bool:
    folded = concat_strings(src or '')
    loose = re.sub(r'\\(.)', r'\1', folded)
    return bool(_ASM_RE.search(folded) or _ASM_RE.search(loose))


def asm_error(src: str) -> str | None:
    return ASM_MSG if has_asm_directive(src) else None


def extract_calls(src: str, name: str) -> list[str]:
    """Arguments of ``name(...)``, respecting strings and nested parentheses."""
    found = []
    i = 0
    n = len(src)
    token = name
    while True:
        j = src.find(token, i)
        if j < 0:
            break
        if j > 0 and (src[j - 1].isalnum() or src[j - 1] == '_'):
            i = j + len(token)
            continue
        k = j + len(token)
        while k < n and src[k] in ' \t\r\n':
            k += 1
        if k >= n or src[k] != '(':
            i = j + len(token)
            continue
        depth = 0
        p = k
        while p < n:
            if src[p] in '"\'':
                quote = src[p]
                p += 1
                while p < n:
                    if src[p] == '\\':
                        p += 2
                        continue
                    if src[p] == quote:
                        p += 1
                        break
                    p += 1
                continue
            if src[p] == '(':
                depth += 1
            elif src[p] == ')':
                depth -= 1
                if depth == 0:
                    found.append(src[k + 1:p])
                    p += 1
                    break
            p += 1
        i = p
    return found


def _spelling_is_outside(path: str) -> bool:
    text = (path or '').strip()
    if not text:
        return False
    if text.startswith('/') or text.startswith('\\') or (len(text) > 2 and text[1] == ':'):
        return True
    return '..' in re.split(r'[\\/]', text)


_DEFINE_ARG = re.compile(r'^([A-Za-z_]\w*)=(?:"([^"]*)"|(.+))$')
_DEFINE_STRING = re.compile(r'^\s*#\s*define\s+([A-Za-z_]\w*)\s+"([^"]*)"', re.MULTILINE)
_DEFINE_ANGLE = re.compile(r'^\s*#\s*define\s+([A-Za-z_]\w*)\s+<([^>\n]*)>', re.MULTILINE)
# gcc: "fatal error: /etc/hostname: No such file or directory"
_MISSING_FILE = re.compile(
    r'(?:fatal error|error):\s*([^:\n]+?)\s*:\s*No such file or directory',
    re.IGNORECASE)


def _macro_strings(text: str, defines) -> dict[str, str]:
    """String values of ``#define NAME "path"`` and of accepted ``NAME="path"`` defines."""
    macros: dict[str, str] = {}
    for item in defines or []:
        if not isinstance(item, str):
            continue
        found = _DEFINE_ARG.fullmatch(item.strip())
        if found:
            macros[found.group(1)] = found.group(2) if found.group(2) is not None else found.group(3)
    norm = normalize_source(text or '')
    for found in _DEFINE_STRING.finditer(norm):
        macros[found.group(1)] = found.group(2)
    for found in _DEFINE_ANGLE.finditer(norm):
        macros[found.group(1)] = found.group(2)
    return macros


def _resolve_macro(name: str, macros: dict[str, str], seen: tuple[str, ...] = ()) -> str | None:
    if name not in macros or name in seen:
        return None
    value = macros[name].strip()
    if re.fullmatch(r'[A-Za-z_]\w*', value):
        nested = _resolve_macro(value, macros, seen + (name,))
        if nested is not None:
            return nested
    return value


def _include_spellings(text: str, defines) -> list[str]:
    """Include paths written in the sketch, after one level of string-macro substitution."""
    macros = _macro_strings(text, defines)
    norm = normalize_source(text or '')
    spellings = []
    for match in _INCLUDE_LINE.finditer(norm):
        arg = match.group(1).strip()
        found = re.match(r'^[<"]([^<>"]*)[>"]', arg)
        if found:
            spellings.append(found.group(1))
            continue
        head = re.match(r'([A-Za-z_]\w*)\s*$', arg)
        if head:
            resolved = _resolve_macro(head.group(1), macros)
            if resolved is not None:
                spellings.append(resolved)
    for arg in extract_calls(norm, '__has_include'):
        spelled = _has_include_path(arg)
        if spelled:
            spellings.append(spelled)
            continue
        name = arg.strip()
        if re.fullmatch(r'[A-Za-z_]\w*', name):
            resolved = _resolve_macro(name, macros)
            if resolved is not None:
                spellings.append(resolved)
    return spellings


def textual_outside(text: str, defines=None) -> str | None:
    """An include whose spelling is absolute or contains ``..``, before the compiler runs."""
    for spelling in _include_spellings(text, defines):
        if _spelling_is_outside(spelling):
            return outside_message(spelling)
    return None


def _path_outside(path: str, roots: list[Path]) -> bool:
    """True for ``..``, or an absolute path that does not realpath inside ``roots``.

    A missing absolute path is outside even when the sandbox hid it, so the
    compiler's ``No such file`` is not treated as a typo.
    """
    text = (path or '').strip().strip('"').strip("'")
    if not text:
        return False
    raw = Path(text)
    if '..' in raw.parts:
        return True
    if raw.is_absolute() or text.startswith(('/', '\\')) or (len(text) > 2 and text[1] == ':'):
        return not _inside(raw, roots)
    return False


def outside_from_diagnostic(stderr: str, roots: list[Path]) -> str | None:
    """A missing-file error that names an absolute path or a path outside ``roots``."""
    for match in _MISSING_FILE.finditer(stderr or ''):
        if _path_outside(match.group(1), roots):
            return outside_message(match.group(1).strip())
    return None


def _has_include_path(arg: str) -> str | None:
    text = (arg or '').strip()
    if len(text) >= 2 and text[0] == '<' and text[-1] == '>':
        return text[1:-1].strip()
    if len(text) >= 2 and text[0] == '"' and text[-1] == '"':
        return text[1:-1]
    return None


def fast_error(sketch: str, files: dict | None) -> str | None:
    """Catch include bypasses that are visible before the compiler runs."""
    parts = [sketch or '', *(files or {}).values()]
    raw = '\n'.join(parts)
    norm = '\n'.join(normalize_source(p) for p in parts)
    for blob in (norm, raw):
        err = asm_error(blob)
        if err:
            return err
    for match in _INCLUDE_LINE.finditer(norm):
        arg = match.group(1).strip()
        found = re.match(r'^[<"]([^<>"]+)[>"]', arg)
        if not found:
            continue
        if _spelling_is_outside(found.group(1)):
            return outside_message(found.group(1))
    for arg in extract_calls(norm, '__has_include'):
        spelled = _has_include_path(arg)
        if spelled and _spelling_is_outside(spelled):
            return outside_message(spelled)
    return None


def needs_dependency_scan(sketch: str, files: dict | None) -> bool:
    """True when the literal scan cannot see the file the preprocessor will open."""
    norm = '\n'.join(normalize_source(p) for p in [sketch or '', *(files or {}).values()])
    if '__has_include' in norm:
        return True
    if _MACRO_INCLUDE.search(norm):
        return True
    if '#define' in norm and _ASM_TOKEN.search(norm):
        return True
    return False


def rewrite_for_deps(original: str) -> str:
    """Turn ``__has_include`` probes into real ``#include`` lines so ``-M`` lists them.

    The builtin itself is replaced with a macro that expands to 0, so the scan
    does not keep the probe in a ``#if`` and also miss the path.
    """
    norm = normalize_source(original)
    args = extract_calls(norm, '__has_include')
    for alias in _ALIAS_RE.findall(norm):
        args.extend(extract_calls(norm, alias))
    text = re.sub(r'\b__has_include\b', 'SIM_HAS_INCLUDE_OFF', original or '')
    lines = ['#define SIM_HAS_INCLUDE_OFF(...) 0', text]
    for arg in args:
        arg = arg.strip()
        if arg:
            lines.append('#include ' + arg)
    return '\n'.join(lines) + '\n'


def rewrite_for_asm(original: str) -> str:
    """Expand macros without opening headers, so an ``asm`` string cannot read a file."""
    text = splice_lines(original or '')
    text = re.sub(r'^\s*#\s*include\b[^\n]*$', '', text, flags=re.MULTILINE)
    text = re.sub(r'\b__has_include\b', 'SIM_HAS_INCLUDE_OFF', text)
    return '#define SIM_HAS_INCLUDE_OFF(...) 0\n' + text


def parse_make_deps(text: str) -> list[str]:
    """Paths from a ``gcc -M`` makefile. The target before the first colon is dropped."""
    if not text:
        return []
    flat = text.replace('\\\n', ' ').replace('\\\r\n', ' ')
    _target, sep, rest = flat.partition(':')
    if not sep:
        return []
    parts = re.findall(r'(?:\\.|[^\s])+', rest)
    out = []
    for part in parts:
        path = part.replace('\\ ', ' ').replace('\\\\', '\\')
        if path and not path.endswith('.o'):
            out.append(path)
    return out


def _real(path: Path) -> Path:
    return Path(os.path.realpath(path))


def _inside(path: Path, roots: list[Path]) -> bool:
    try:
        resolved = _real(path)
    except OSError:
        return False
    for root in roots:
        if resolved == root or root in resolved.parents:
            return True
    return False


def dependency_error(deps: list[str], roots: list[Path]) -> str | None:
    """Reject a dependency whose real path is outside ``roots``.

    A relative name gcc could not open (``-MG``) is left for the real compile,
    which has the full Arduino include path. Absolute paths and ``..`` are not.
    """
    clean = []
    for root in roots:
        try:
            clean.append(_real(Path(root)))
        except OSError:
            continue
    for dep in deps:
        raw = Path(dep)
        if '..' in raw.parts:
            return outside_message(dep)
        if not raw.is_absolute():
            escaped = False
            for root in clean:
                candidate = root / raw
                if candidate.exists() or candidate.is_symlink():
                    if not _inside(candidate, clean):
                        return outside_message(str(_real(candidate)))
                    escaped = True
            if not escaped:
                continue
            continue
        if _inside(raw, clean):
            continue
        return outside_message(str(_real(raw)))
    return None


def arduino_data_dir() -> Path | None:
    home = Path.home()
    candidates = []
    for key in ('ARDUINO_DIRECTORIES_DATA', 'ARDUINO_DATA_DIR'):
        if os.environ.get(key):
            candidates.append(Path(os.environ[key]))
    candidates.extend((home / '.arduino15', home / '.esp32lab' / 'arduino15'))
    for data in candidates:
        if (data / 'packages' / 'esp32').is_dir():
            return data
    return None


class ToolchainError(Exception):
    """The ESP32 toolchain is present, but the real compiler cannot be used.

    The Rust ``xtensa-esp32-elf-*`` wrappers are not a fallback: they read
    ``/proc/self/exe`` and panic inside the sandbox.
    """

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def _toolchain_roots(env) -> list[Path]:
    """esp-x32 directories to search, newest last. An explicit dir is first."""
    roots = []
    explicit = (env.get('SIM_TOOLCHAIN_DIR') or '').strip()
    if explicit:
        roots.append(Path(explicit))
    data = arduino_data_dir()
    if data:
        roots.extend(sorted(path for path in (data / 'packages/esp32/tools/esp-x32').glob('*') if path.is_dir()))
    which = shutil.which('xtensa-esp32-elf-g++')
    if which:
        roots.append(Path(which).resolve().parent.parent)
    return roots


def _real_in(root: Path) -> dict | None:
    """Real ``xtensa-esp-elf-*`` binaries and ``lib/xtensa_esp32.so`` under ``root``."""
    gxx_candidates = (
        root / 'bin' / 'xtensa-esp-elf-g++',
        root / 'xtensa-esp-elf' / 'bin' / 'xtensa-esp-elf-g++',
    )
    gxx = next((path for path in gxx_candidates if path.is_file()), None)
    if gxx is None:
        return None
    gcc = gxx.with_name('xtensa-esp-elf-gcc')
    ar = next((gxx.with_name(name) for name in ('xtensa-esp-elf-gcc-ar', 'xtensa-esp-elf-ar')
               if gxx.with_name(name).is_file()), None)
    size = gxx.with_name('xtensa-esp-elf-size')
    dyn_candidates = (
        root / 'lib' / 'xtensa_esp32.so',
        root / 'xtensa-esp-elf' / 'lib' / 'xtensa_esp32.so',
        gxx.parent.parent / 'lib' / 'xtensa_esp32.so',
    )
    dyn = next((path for path in dyn_candidates if path.is_file()), None)
    return {
        'root': root,
        'gxx': gxx,
        'gcc': gcc if gcc.is_file() else None,
        'ar': ar,
        'size': size if size.is_file() else None,
        'dynconfig': dyn,
    }


def resolve_xtensa(env=None) -> dict | None:
    """The real Xtensa compiler, or None when no ESP32 toolchain is installed.

    ``SIM_XTENSA_CC_REAL`` is the real ``xtensa-esp-elf-g++`` (or gcc; the sibling
    is derived). ``SIM_XTENSA_DYNCONFIG`` is ``lib/xtensa_esp32.so``. A set override
    that does not exist, or a toolchain directory with no real compiler, raises
    ``ToolchainError`` instead of falling back to the Rust wrapper.
    """
    env = os.environ if env is None else env
    real = (env.get('SIM_XTENSA_CC_REAL') or '').strip()
    dyn_env = (env.get('SIM_XTENSA_DYNCONFIG') or '').strip()
    if real or dyn_env:
        gxx = Path(real) if real else None
        if gxx is None or not gxx.is_file():
            raise ToolchainError('SIM_XTENSA_CC_REAL is missing')
        if gxx.name.endswith('-gcc') and not gxx.name.endswith('-g++'):
            sibling = gxx.with_name(gxx.name[:-3] + 'g++')
            if sibling.is_file():
                gxx = sibling
        gcc = gxx.with_name('xtensa-esp-elf-gcc')
        if not gcc.is_file():
            gcc = gxx.with_name(gxx.name[:-3] + 'gcc') if gxx.name.endswith('g++') else None
        ar = next((gxx.with_name(name) for name in ('xtensa-esp-elf-gcc-ar', 'xtensa-esp-elf-ar')
                   if gxx.with_name(name).is_file()), None)
        size = gxx.with_name('xtensa-esp-elf-size')
        dyn = Path(dyn_env) if dyn_env else None
        if dyn is None or not dyn.is_file():
            raise ToolchainError('SIM_XTENSA_DYNCONFIG is missing')
        root = gxx.parent.parent if gxx.parent.name == 'bin' else gxx.parent
        return {'root': root, 'gxx': gxx, 'gcc': gcc if gcc is not None and gcc.is_file() else None,
                'ar': ar, 'size': size if size.is_file() else None, 'dynconfig': dyn}
    roots = _toolchain_roots(env)
    if not roots:
        return None
    # An explicit SIM_TOOLCHAIN_DIR that does not contain the real compiler fails closed.
    # A discovered esp-x32 directory that only has the Rust wrapper does too.
    last_reason = 'real xtensa-esp-elf compiler not found'
    for root in roots:
        if not root.exists():
            if (env.get('SIM_TOOLCHAIN_DIR') or '').strip() and root == Path(env.get('SIM_TOOLCHAIN_DIR')):
                raise ToolchainError('SIM_TOOLCHAIN_DIR does not exist')
            continue
        found = _real_in(root)
        if found and found['dynconfig'] is not None and found['gxx'] is not None:
            return found
        if found and found['dynconfig'] is None:
            last_reason = 'lib/xtensa_esp32.so not found under ' + root.name
        else:
            last_reason = 'xtensa-esp-elf-g++ not found under ' + root.name
        if (env.get('SIM_TOOLCHAIN_DIR') or '').strip() and root == Path((env.get('SIM_TOOLCHAIN_DIR') or '').strip()):
            raise ToolchainError(last_reason)
    # Every discovered toolchain dir failed. Do not use the wrapper.
    if any(path.exists() for path in roots):
        raise ToolchainError(last_reason)
    return None


def dynconfig_flag(tc: dict) -> str:
    """The ``-mdynconfig`` value the real gcc's multilib spec matches.

    esp-x32 selects ``lib/esp32`` only for the literal ``mdynconfig=xtensa_esp32.so``.
    An absolute path loads the config but links the big-endian default libraries.
    ``cc1plus`` and ``as`` then dlopen that basename, so the sandbox puts
    ``tc['dynconfig']``'s directory on ``LD_LIBRARY_PATH``.
    """
    return Path(tc['dynconfig']).name


def dynconfig_library_dir(env=None) -> str | None:
    """Directory of ``lib/xtensa_esp32.so``, or None when no toolchain is installed."""
    try:
        tc = resolve_xtensa(env)
    except ToolchainError:
        return None
    if not tc or not tc.get('dynconfig'):
        return None
    return str(Path(tc['dynconfig']).parent)


def find_preprocessor(env=None) -> str | None:
    """Real ``xtensa-esp-elf-g++`` when the core is installed, otherwise host g++.

    The Rust ``xtensa-esp32-elf-g++`` wrapper is never returned.
    """
    try:
        tc = resolve_xtensa(env)
    except ToolchainError:
        return None
    if tc:
        return str(tc['gxx'])
    return shutil.which('g++') or shutil.which('gcc')


def preprocessor_command(compiler: str | None = None, env=None) -> list[str]:
    """Argv prefix for the include scan. Adds ``-mdynconfig`` for the real Xtensa g++."""
    tc = resolve_xtensa(env)
    if compiler:
        path = str(compiler)
        if tc and Path(path).resolve() == Path(tc['gxx']).resolve():
            return [path, '-mdynconfig=' + dynconfig_flag(tc)]
        return [path]
    if tc:
        return [str(tc['gxx']), '-mdynconfig=' + dynconfig_flag(tc)]
    host = shutil.which('g++') or shutil.which('gcc')
    if not host:
        raise ToolchainError('no C++ compiler on PATH')
    return [host]


def toolchain_recipe(c_flags: str = '', cpp_flags: str = '', s_flags: str = '',
                     elf_flags: str = '', env=None) -> list[tuple[str, str]]:
    """arduino-cli ``--build-property`` pairs that skip the Rust wrappers.

    Empty when no ESP32 toolchain is installed. ``ToolchainError`` when the
    toolchain is installed but the real gcc, g++, ar, or dynconfig is missing.
    """
    tc = resolve_xtensa(env)
    if tc is None:
        return []
    if tc['gcc'] is None or tc['ar'] is None or tc['dynconfig'] is None:
        raise ToolchainError('real xtensa-esp-elf gcc, g++, or ar is missing')
    # The multilib spec matches the literal string xtensa_esp32.so. An absolute
    # path loads the config but links the big-endian default libraries.
    dyn = '-mdynconfig=' + dynconfig_flag(tc)

    def merge(extra: str) -> str:
        extra = (extra or '').strip()
        return dyn if not extra else dyn + ' ' + extra

    bindir = str(tc['gxx'].parent) + '/'
    pairs = [
        ('compiler.path', bindir),
        ('compiler.c.cmd', tc['gcc'].name),
        ('compiler.cpp.cmd', tc['gxx'].name),
        ('compiler.S.cmd', tc['gcc'].name),
        ('compiler.c.elf.cmd', tc['gxx'].name),
        ('compiler.ar.cmd', tc['ar'].name),
    ]
    if tc.get('size') is not None:
        # {compiler.prefix}size is the Rust wrapper, which panics with no /proc.
        pairs.append(('compiler.size.cmd', tc['size'].name))
    pairs += [
        ('compiler.c.extra_flags', merge(c_flags)),
        ('compiler.cpp.extra_flags', merge(cpp_flags)),
        ('compiler.S.extra_flags', merge(s_flags)),
        ('compiler.c.elf.extra_flags', merge(elf_flags)),
    ]
    return pairs


def library_roots() -> list[Path]:
    here = Path(__file__).resolve().parent
    roots = [here / 'shims']
    data = arduino_data_dir()
    if data:
        roots.append(data / 'packages')
    user = os.environ.get('ARDUINO_DIRECTORIES_USER')
    roots.append(Path(user) if user else Path.home() / 'Arduino' / 'libraries')
    return roots


def include_search_dirs(sketch_dir: Path) -> list[Path]:
    """``-I`` directories for the dependency scan. Missing directories are skipped."""
    dirs = [Path(sketch_dir)]
    for root in library_roots():
        if not root.is_dir() or root.is_symlink():
            continue
        if root.name in {'shims', 'libraries'}:
            try:
                children = list(root.iterdir())
            except OSError:
                continue
            for child in children:
                if not child.is_dir() or child.is_symlink():
                    continue
                src = child / 'src'
                dirs.append(src if src.is_dir() else child)
        elif root.name == 'packages':
            dirs.extend(list(root.glob('esp32/hardware/esp32/*/cores/esp32'))[:1])
    out = []
    for path in dirs:
        if path.is_dir() and not path.is_symlink():
            out.append(path)
    return out


def include_roots(sketch_dir: Path, extra: list[Path] | None = None) -> list[Path]:
    roots = [Path(sketch_dir)]
    for path in library_roots():
        if path.is_dir():
            roots.append(path)
    for path in extra or []:
        roots.append(Path(path))
    return roots


def _define_args(defines) -> list[str]:
    args = []
    for item in defines or []:
        if isinstance(item, str) and diskkeep.flags_are_safe([item]):
            args.append('-D' + item)
    return args


# A gcc diagnostic that names the translation unit. A Rust panic does not look like this.
_SKETCH_DIAG = re.compile(
    r'[\w./+-]+:\d+:\d+:\s*(?:fatal error|error|warning)\b|(?:fatal error|error):',
    re.IGNORECASE)
_PANIC = re.compile(r'no /proc/self/exe|is /proc mounted|panicked at', re.IGNORECASE)


def _setup_error(stderr: str, returncode: int = 0, stdout: str = '') -> bool:
    """True when the build server failed, not when the sketch did.

    Bubblewrap mount errors, the Rust wrapper's ``/proc/self/exe`` panic (exit
    101), and any other nonzero exit that produced no makefile and no compiler
    diagnostic are the server. A ``fatal error`` that names the sketch is not.
    """
    text = stderr or ''
    low = text.lower()
    if 'bwrap:' in low or "can't mount" in low or 'can not mount' in low:
        return True
    if _PANIC.search(text) or returncode == 101:
        return True
    if returncode and not parse_make_deps(stdout or '') and not _SKETCH_DIAG.search(text):
        return True
    return False


def host_sandbox_env(env=None) -> dict[str, str]:
    """Environment of the host ``bwrap`` or ``docker`` process.

    That process runs as the server user, so ``/proc/<pid>/environ`` is
    readable. Copy ``PATH`` and ``LANG``, and ``LD_LIBRARY_PATH`` only when
    the server already set it. Do not prepend the toolchain directory; the
    sandbox sets ``LD_LIBRARY_PATH`` to that directory itself. Nothing else
    is copied: not ``SIM_TOKEN``, ``SIM_ACCESS_TOKEN``, or any other server
    variable.

    ``_PASS_ENV`` is not copied here. ``arduino-cli`` runs inside the sandbox,
    after ``--clearenv``, and those keys are handed in with ``--setenv`` /
    ``-e``. The host launcher does not read them.
    """
    src = os.environ if env is None else env
    out: dict[str, str] = {}
    for key in ('PATH', 'LANG'):
        value = src.get(key)
        if value:
            out[key] = value
    library_path = src.get('LD_LIBRARY_PATH')
    if library_path:
        out['LD_LIBRARY_PATH'] = library_path
    return out


def _direct_compiler_env(env=None) -> dict[str, str]:
    """Environment for a compiler run on the host, when the sandbox is ``off``.

    Start from ``host_sandbox_env`` (``PATH``, ``LANG``, and an already-set
    ``LD_LIBRARY_PATH``). Prepend the toolchain library directory so
    ``xtensa-esp-elf-g++`` can dlopen ``xtensa_esp32.so`` by basename. Then
    copy only ``_PASS_ENV``: arduino-cli is this process, so it needs its data,
    user, download, and cache directories (``ARDUINO_DIRECTORIES_DATA``,
    ``ARDUINO_DATA_DIR``, ``ARDUINO_DIRECTORIES_USER``,
    ``ARDUINO_DIRECTORIES_DOWNLOADS``, ``ARDUINO_BUILD_CACHE_PATH``,
    ``XDG_CACHE_HOME``, ``ARDUINO_CLI``). Nothing else is copied.
    """
    src = os.environ if env is None else env
    out = host_sandbox_env(src)
    lib = dynconfig_library_dir()
    if lib:
        prev = out.get('LD_LIBRARY_PATH')
        out['LD_LIBRARY_PATH'] = lib if not prev else lib + os.pathsep + prev
    for key in _PASS_ENV:
        value = src.get(key)
        if value:
            out[key] = value
    return out


def _run(argv: list[str], cwd: Path, sandbox: bool, work: Path) -> subprocess.CompletedProcess:
    if _scan_fault:
        # A forced failure is the build server, not a typo in the sketch.
        raise SandboxUnavailable(SANDBOX_MSG)
    fds: tuple[int, ...] = ()
    if sandbox:
        wrapped, err = wrap_command(argv, work=work, read_only=_ro_for(work), read_write=_rw_for(work))
        if err:
            raise SandboxUnavailable(err)
        argv, fds = attach_seccomp(wrapped)
        if argv is None:
            close_fds(fds)
            raise SandboxUnavailable(SANDBOX_MSG)
        # bwrap stays on the tiny host environment. An explicit sandbox-off
        # compile is the compiler itself, so it gets the toolchain library
        # path and the named arduino-cli keys, still with no secrets.
        env = host_sandbox_env() if Path(argv[0]).name == 'bwrap' else _direct_compiler_env()
    else:
        env = _direct_compiler_env()
    try:
        proc = subprocess.run(
            argv, cwd=str(cwd), capture_output=True, text=True, timeout=60, env=env, pass_fds=fds)
    finally:
        close_fds(fds)
    if proc.returncode and _setup_error(proc.stderr or '', proc.returncode, proc.stdout or ''):
        raise SandboxUnavailable(SANDBOX_MSG)
    return proc


class SandboxUnavailable(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


def _gcc_deps(compiler: str | None, source: Path, sketch_dir: Path, work: Path, defines, sandbox: bool) -> tuple[list[str], str]:
    """Dependency paths and the compiler's stderr. An empty list is not success."""
    try:
        cmd = preprocessor_command(compiler)
    except ToolchainError as exc:
        raise SandboxUnavailable(SANDBOX_MSG) from exc
    cmd += ['-nostdinc', '-M', '-MG', '-w', '-x', 'c++']
    for inc in include_search_dirs(sketch_dir):
        cmd.append('-I' + str(inc))
    cmd.extend(_define_args(defines))
    cmd.append(str(source))
    proc = _run(cmd, work, sandbox, work)
    return parse_make_deps(proc.stdout or ''), proc.stderr or ''


def _gcc_asm(compiler: str | None, source: Path, work: Path, defines, sandbox: bool) -> str:
    try:
        cmd = preprocessor_command(compiler)
    except ToolchainError as exc:
        raise SandboxUnavailable(SANDBOX_MSG) from exc
    cmd += ['-nostdinc', '-E', '-P', '-w', '-x', 'c++', *_define_args(defines), str(source)]
    proc = _run(cmd, work, sandbox, work)
    return proc.stdout or ''


def scan_translation_unit(text: str, sketch_dir: Path, *, compiler: str, roots: list[Path],
                          defines=None, sandbox: bool) -> str | None:
    # A path the sketch spells out is outside even when the sandbox hides the file
    # and the compiler only reports "No such file".
    spelled = textual_outside(text, defines)
    if spelled:
        return spelled
    work = sketch_dir.parent
    scan_dir = work / '.include-scan'
    scan_dir.mkdir(parents=True, exist_ok=True)
    unit = scan_dir / 'unit.cpp'
    allowed = list(roots) + [scan_dir]
    try:
        unit.write_text(rewrite_for_deps(text))
        deps, stderr = _gcc_deps(compiler, unit, sketch_dir, work, defines, sandbox)
        err = dependency_error(deps, allowed)
        if err:
            return err
        err = outside_from_diagnostic(stderr, allowed)
        if err:
            return err
        # A failed preprocessor that printed no makefile, and named no outside path,
        # is a problem in the sketch (a typo), not a build-server failure.
        if not deps:
            return SCAN_MSG
        return None
    except SandboxUnavailable as exc:
        return exc.message
    except OSError:
        return SANDBOX_MSG
    finally:
        shutil.rmtree(scan_dir, ignore_errors=True)


def scan_sketch_dir(sketch_dir: Path, *, compiler: str | None = None, defines=None,
                    sandbox: bool | None = None, roots: list[Path] | None = None) -> str | None:
    """Run the dependency scan on each translation unit under ``sketch_dir``."""
    sketch_dir = Path(sketch_dir)
    if sandbox is None:
        sandbox = sandbox_enabled()
    refusal = sandbox_refusal() if sandbox else None
    if refusal:
        return refusal
    compiler = compiler or find_preprocessor()
    if not compiler:
        return SANDBOX_MSG
    roots = list(roots) if roots is not None else include_roots(sketch_dir)
    units = []
    ino = sketch_dir / 'sketch.ino'
    if ino.is_file():
        units.append(ino)
    try:
        extras = sorted(sketch_dir.iterdir())
    except OSError:
        return SANDBOX_MSG
    for path in extras:
        if path.is_file() and path.suffix.lower() in _TU_SUFFIXES and path.name != 'sketch.ino':
            units.append(path)
    if not units:
        return SCAN_MSG
    for unit in units:
        try:
            text = unit.read_text(encoding='utf-8', errors='replace')
        except OSError:
            return SANDBOX_MSG
        err = scan_translation_unit(
            text, sketch_dir, compiler=compiler, roots=roots, defines=defines, sandbox=bool(sandbox))
        if err:
            return err
    return _scan_asm(sketch_dir, compiler, defines, bool(sandbox))


def _scan_asm(sketch_dir: Path, compiler: str, defines, sandbox: bool) -> str | None:
    """Expand macros from every user file without opening absolute includes."""
    chunks = []
    try:
        paths = sorted(sketch_dir.iterdir())
    except OSError:
        return SANDBOX_MSG
    for path in paths:
        if path.is_file() and path.suffix.lower() in {'.h', '.hpp', '.hh', '.c', '.cpp', '.cc', '.ino'}:
            try:
                chunks.append(rewrite_for_asm(path.read_text(encoding='utf-8', errors='replace')))
            except OSError:
                return SANDBOX_MSG
    if not chunks:
        return None
    work = sketch_dir.parent
    scan_dir = work / '.include-scan'
    scan_dir.mkdir(parents=True, exist_ok=True)
    asm_unit = scan_dir / 'asm.cpp'
    try:
        asm_unit.write_text('\n'.join(chunks))
        expanded = _gcc_asm(compiler, asm_unit, work, defines, sandbox)
    except SandboxUnavailable as exc:
        return exc.message
    except (OSError, subprocess.SubprocessError):
        return SCAN_MSG
    finally:
        shutil.rmtree(scan_dir, ignore_errors=True)
    return asm_error(expanded)


def dependency_paths(sketch: str, files: dict | None = None, *, compiler: str | None = None,
                     sandbox: bool = False, defines=None) -> list[str]:
    """Dependency paths for tests. Does not raise; returns what ``-M`` printed."""
    compiler = compiler or find_preprocessor()
    if not compiler:
        return []
    files = files or {}
    with tempfile.TemporaryDirectory(prefix='esp32inc-') as tmp:
        work = Path(tmp)
        sketch_dir = work / 'sketch'
        sketch_dir.mkdir()
        (sketch_dir / 'sketch.ino').write_text(sketch or '')
        for name, content in files.items():
            (sketch_dir / name).write_text(content)
        scan_dir = work / '.include-scan'
        scan_dir.mkdir()
        unit = scan_dir / 'unit.cpp'
        unit.write_text(rewrite_for_deps(sketch or ''))
        try:
            deps, _stderr = _gcc_deps(compiler, unit, sketch_dir, work, defines, sandbox)
            return deps
        except (OSError, subprocess.SubprocessError, SandboxUnavailable):
            return []


def audit_texts(sketch: str, files: dict | None = None, *, compiler: str | None = None,
                sandbox: bool | None = None, defines=None) -> str | None:
    """Write the sketch to a temp directory and run the same scan a compile runs."""
    fast = fast_error(sketch, files)
    if fast:
        return fast
    if sandbox is None:
        sandbox = sandbox_enabled()
    files = files or {}
    with tempfile.TemporaryDirectory(prefix='esp32inc-') as tmp:
        work = Path(tmp)
        sketch_dir = work / 'sketch'
        sketch_dir.mkdir()
        (sketch_dir / 'sketch.ino').write_text(sketch or '')
        for name, content in files.items():
            if '/' in name or '\\' in name or name.startswith('.'):
                continue
            (sketch_dir / name).write_text(content)
        return scan_sketch_dir(sketch_dir, compiler=compiler, defines=defines, sandbox=sandbox)


def sandbox_choice(env=None) -> str:
    """``off`` or ``on``. Only the literal word ``off`` disables the sandbox.

    ``SIM_COMPILE_SANDBOX=off`` is the switch. ``SIM_SANDBOX=off`` is that
    same switch when the primary variable is unset. Unset, ``0``, ``1``,
    ``auto``, and any other value stay ``on``.
    """
    env = os.environ if env is None else env
    primary = env.get('SIM_COMPILE_SANDBOX')
    if primary is None or not str(primary).strip():
        raw = env.get('SIM_SANDBOX')
    else:
        raw = primary
    if raw is not None and str(raw).strip().lower() == 'off':
        return 'off'
    return 'on'


def sandbox_enabled(env=None) -> bool:
    return sandbox_choice(env) != 'off'


def startup_banner(env=None) -> str:
    """One startup phrase. ``off`` is logged as unsafe; every other mode is not."""
    if sandbox_choice(env) == 'off':
        return 'compile sandbox OFF (unsafe, dev only)'
    return 'compile sandbox ' + describe(env)


def resolve_backend(env=None) -> str:
    """``off``, ``bwrap``, or ``missing``.

    Bubblewrap is the only sandbox. A docker image name does not select a
    backend: when ``bwrap`` is absent the result is ``missing`` and the
    compile is refused.
    """
    if _backend_override:
        return _backend_override
    env = os.environ if env is None else env
    if not sandbox_enabled(env):
        return 'off'
    if shutil.which('bwrap'):
        return 'bwrap'
    return 'missing'


def _one_line(text: str) -> str:
    return re.sub(r'\s+', ' ', text or '').strip()[:180]


def _probe_commands(work: Path) -> list[list[str]]:
    """``-E`` then ``-c`` of a one-line program, using the compiler a compile uses."""
    try:
        prefix = preprocessor_command()
    except ToolchainError:
        raise
    src = work / 'probe.cpp'
    src.write_text('int probe_ok(){return 1;}\n')
    return [
        prefix + ['-E', '-o', str(work / 'probe.i'), str(src)],
        prefix + ['-c', '-o', str(work / 'probe.o'), str(src)],
    ]


def _probe_argv() -> list[tuple[list[str], Path]] | None:
    """Each startup command wrapped by ``bwrap_argv``. None when there is no compiler."""
    work = Path(tempfile.mkdtemp(prefix='esp32bwrap-'))
    try:
        commands = _probe_commands(work)
    except ToolchainError:
        shutil.rmtree(work, ignore_errors=True)
        raise
    except Exception:
        shutil.rmtree(work, ignore_errors=True)
        raise
    ro = _ro_for(work)
    rw = _rw_for(work)
    return [(bwrap_argv(cmd, work=work, read_only=ro, read_write=rw), work) for cmd in commands], work


def _probe_fresh(when, ok, refresh: bool) -> bool:
    """A success is reused for 60s. A failure is reused for 60s unless a run asks again."""
    if when is None:
        return False
    if time.monotonic() - when >= _PROBE_TTL:
        return False
    if not ok and refresh:
        return False
    return True


def _sock_filter(code: int, jt: int, jf: int, k: int) -> bytes:
    return struct.pack('=HBBI', code, jt, jf, k)


def seccomp_arch() -> str | None:
    machine = os.uname().machine
    if machine == 'x86_64':
        return 'x86_64'
    if machine in {'aarch64', 'arm64'}:
        return 'aarch64'
    return None


def seccomp_filter_bytes() -> bytes | None:
    """Deny-list BPF for this machine, or None when the arch is unknown.

    ``ld [0]`` loads the syscall number. Each ``jeq`` jumps to ``ret EPERM``;
    a fall-through is ``ret ALLOW``. Bubblewrap installs this after it has
    already made the namespaces, so refusing ``unshare`` and ``mount`` here
    does not stop bwrap itself.
    """
    arch = seccomp_arch()
    if arch is None:
        return None
    numbers = list(_SECCOMP_DENY[arch].values())
    program = [_sock_filter(_BPF_LD_W_ABS, 0, 0, 0)]
    total = len(numbers)
    for index, number in enumerate(numbers, start=1):
        program.append(_sock_filter(_BPF_JEQ_K, total + 1 - index, 0, number))
    program.append(_sock_filter(_BPF_RET_K, 0, 0, _SECCOMP_RET_ALLOW))
    program.append(_sock_filter(_BPF_RET_K, 0, 0, _SECCOMP_RET_EPERM))
    return b''.join(program)


def close_fds(fds) -> None:
    for fd in fds or ():
        try:
            os.close(fd)
        except OSError:
            pass


def attach_seccomp(argv: list[str] | None) -> tuple[list[str] | None, tuple[int, ...]]:
    """Add ``--seccomp FD`` when ``argv`` starts bwrap. The caller passes and closes ``FD``."""
    if not argv or Path(argv[0]).name != 'bwrap':
        return list(argv or []), ()
    blob = seccomp_filter_bytes()
    if not blob:
        return None, ()
    read_fd, write_fd = os.pipe()
    try:
        view = blob
        while view:
            wrote = os.write(write_fd, view)
            view = view[wrote:]
    except OSError:
        os.close(read_fd)
        return None, ()
    finally:
        try:
            os.close(write_fd)
        except OSError:
            pass
    return [argv[0], '--seccomp', str(read_fd), *argv[1:]], (read_fd,)


def _seccomp_probe_argv() -> list[str] | None:
    true_bin = shutil.which('true')
    if not true_bin:
        return None
    argv = ['bwrap', '--die-with-parent', '--unshare-all', '--new-session']
    for path in ('/usr', '/bin', '/lib', '/lib64'):
        if os.path.exists(path):
            argv += ['--ro-bind', path, path]
    argv += ['--', true_bin]
    return argv


def seccomp_loads(*, refresh: bool = False) -> bool:
    """True when bwrap accepts the filter. A load failure is fail-closed."""
    global _seccomp_ok, _seccomp_reason, _seccomp_checked_at
    if _seccomp_override is not None:
        if not _seccomp_override:
            _seccomp_reason = 'forced'
        return bool(_seccomp_override)
    if _seccomp_ok is not None and _probe_fresh(_seccomp_checked_at, _seccomp_ok, refresh):
        return bool(_seccomp_ok)
    _seccomp_checked_at = time.monotonic()
    if seccomp_filter_bytes() is None:
        _seccomp_ok = False
        _seccomp_reason = 'unsupported arch ' + os.uname().machine
        print('compile sandbox seccomp probe failed: ' + _seccomp_reason)
        return False
    if not shutil.which('bwrap'):
        _seccomp_ok = False
        _seccomp_reason = 'bwrap not on PATH'
        print('compile sandbox seccomp probe failed: ' + _seccomp_reason)
        return False
    argv = _seccomp_probe_argv()
    if not argv:
        _seccomp_ok = False
        _seccomp_reason = 'true not on PATH'
        print('compile sandbox seccomp probe failed: ' + _seccomp_reason)
        return False
    launched, fds = attach_seccomp(argv)
    if launched is None:
        close_fds(fds)
        _seccomp_ok = False
        _seccomp_reason = 'filter was not built'
        print('compile sandbox seccomp probe failed: ' + _seccomp_reason)
        return False
    try:
        proc = subprocess.run(
            launched, capture_output=True, timeout=15, env=host_sandbox_env(), pass_fds=fds)
    except (OSError, subprocess.SubprocessError) as exc:
        _seccomp_ok = False
        _seccomp_reason = 'probe error ' + exc.__class__.__name__
        print('compile sandbox seccomp probe failed: ' + _seccomp_reason)
        return False
    finally:
        close_fds(fds)
    if proc.returncode != 0:
        err = (proc.stderr or b'').decode(errors='replace').strip().splitlines()
        tail = err[-1][:160] if err else ''
        _seccomp_ok = False
        _seccomp_reason = 'exit %s%s' % (proc.returncode, (' ' + tail) if tail else '')
        print('compile sandbox seccomp probe failed: ' + _seccomp_reason)
        return False
    _seccomp_ok = True
    _seccomp_reason = 'ok'
    return True


def sandbox_ok(*, refresh: bool = False) -> bool:
    """Bubblewrap probe and seccomp load. False when either cannot run."""
    if not sandbox_enabled():
        return False
    if resolve_backend() != 'bwrap':
        return False
    if not bwrap_works(refresh=refresh):
        return False
    if not seccomp_loads(refresh=refresh):
        return False
    return True


def sandbox_ok_for_run() -> bool:
    """A run re-probes when the last result failed. A recent success is reused."""
    failed = _bwrap_ok is False or _seccomp_ok is False
    return sandbox_ok(refresh=failed)


def bwrap_works(*, refresh: bool = False) -> bool:
    """Preprocess and compile one line through ``bwrap_argv``, the same builder a compile uses."""
    global _bwrap_ok, _bwrap_reason, _bwrap_checked_at
    if _works_override is not None:
        if not _works_override:
            _bwrap_reason = 'forced'
        return bool(_works_override)
    if _backend_override == 'bwrap':
        return True
    if _backend_override in {'missing', 'off', 'docker'}:
        return False
    if _bwrap_ok is not None and _probe_fresh(_bwrap_checked_at, _bwrap_ok, refresh):
        return bool(_bwrap_ok)
    _bwrap_checked_at = time.monotonic()
    if not shutil.which('bwrap'):
        _bwrap_ok = False
        _bwrap_reason = 'bwrap not on PATH'
        return False
    try:
        built = _probe_argv()
    except ToolchainError as exc:
        _bwrap_ok = False
        _bwrap_reason = exc.reason
        return False
    if built is None:
        _bwrap_ok = False
        _bwrap_reason = 'probe could not find a compiler'
        return False
    wrapped, work = built
    try:
        for argv, _same in wrapped:
            launched, fds = attach_seccomp(argv)
            if launched is None:
                _bwrap_ok = False
                _bwrap_reason = 'seccomp filter was not built'
                return False
            try:
                proc = subprocess.run(
                    launched, capture_output=True, timeout=60, env=host_sandbox_env(), pass_fds=fds)
            finally:
                close_fds(fds)
            if proc.returncode != 0:
                err = (proc.stderr or b'').decode(errors='replace').strip().splitlines()
                tail = err[-1][:160] if err else ''
                _bwrap_ok = False
                _bwrap_reason = f'exit {proc.returncode}' + (f' {tail}' if tail else '')
                return False
    except (OSError, subprocess.SubprocessError) as exc:
        _bwrap_ok = False
        _bwrap_reason = 'probe error ' + exc.__class__.__name__
        return False
    finally:
        shutil.rmtree(work, ignore_errors=True)
    _bwrap_ok = True
    _bwrap_reason = 'ok'
    return True


def sandbox_problem(env=None) -> str | None:
    """Why the sandbox cannot run, for the server log. None when a compile may proceed.

    The learner never sees this. It names the backend and the probe result only.
    """
    if not sandbox_enabled(env):
        return None
    backend = resolve_backend(env)
    if backend == 'bwrap':
        if not bwrap_works():
            return 'backend=bwrap probe=' + _one_line(_bwrap_reason or 'failed')
        if not seccomp_loads():
            return 'backend=bwrap probe=seccomp ' + _one_line(_seccomp_reason or 'failed')
        return None
    return 'backend=%s probe=absent' % backend


def startup_sandbox_error(env=None) -> str | None:
    """One error line for process start, or None when the sandbox can run."""
    problem = sandbox_problem(env)
    if not problem:
        return None
    return 'error: compile sandbox unavailable: ' + problem


def reason_code(message: str) -> str | None:
    """Log code for a learner-facing refusal, or None when this is not one of them."""
    if not message:
        return None
    if message == SANDBOX_MSG:
        return 'infra'
    if message == SCAN_MSG:
        return 'scan'
    if "doesn't have a library called" in message:
        return 'unknown_library'
    if 'outside the project' in message:
        return 'outside'
    if 'assembler include' in message:
        return 'asm'
    if "this builder can't check" in message:
        return 'unsupported'
    return None


def sandbox_refusal(env=None) -> str | None:
    backend = resolve_backend(env)
    if backend == 'off':
        return None
    if backend == 'bwrap' and bwrap_works() and seccomp_loads():
        return None
    return SANDBOX_MSG


def describe(env=None) -> str:
    backend = resolve_backend(env)
    if backend == 'off':
        return 'off'
    if backend == 'bwrap' and bwrap_works() and seccomp_loads():
        return 'bwrap'
    return 'unavailable'


def _existing(paths) -> list[Path]:
    out = []
    for raw in paths:
        path = Path(raw)
        if path.exists():
            out.append(path)
    return out


def _covered(path: Path, parents: list[Path]) -> bool:
    try:
        resolved = path.resolve()
    except OSError:
        return False
    for parent in parents:
        try:
            resolved.relative_to(parent.resolve())
        except (ValueError, OSError):
            continue
        return True
    return False


def _ro_for(work: Path) -> list[Path]:
    """Toolchain and libraries the compiler may read. Never the caller's home or /etc/hostname."""
    paths = []
    data = arduino_data_dir()
    if data is not None and data.exists() and not _covered(data, [work]):
        paths.append(data)
    try:
        tc = resolve_xtensa()
    except ToolchainError:
        tc = None
    if tc is not None:
        root = Path(tc['root'])
        if root.exists() and not _covered(root, paths) and not _covered(root, [Path(work)]):
            paths.append(root)
    for path in library_roots():
        if path.exists() and not _covered(path, paths) and not _covered(path, [Path(work)]):
            paths.append(path)
    return paths


def _rw_for(work: Path) -> list[Path]:
    cache = diskkeep.arduino_build_cache_dir()
    try:
        cache.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass
    paths = [Path(work)]
    if cache.exists() and not _covered(cache, [work]):
        paths.append(cache)
    net = diskkeep.netstack_root_from_env()
    try:
        net.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass
    if net.exists() and not _covered(net, paths):
        paths.append(net)
    return paths


def _env_args() -> list[str]:
    home = str(Path.home())
    args = [
        '--clearenv',
        '--setenv', 'PATH', '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        '--setenv', 'HOME', home,
        '--setenv', 'LANG', 'C',
        '--setenv', 'LC_ALL', 'C',
        '--setenv', 'TMPDIR', '/tmp',
    ]
    lib = dynconfig_library_dir()
    if lib:
        args.extend(('--setenv', 'LD_LIBRARY_PATH', lib))
    for key in _PASS_ENV:
        value = os.environ.get(key)
        if value:
            args.extend(('--setenv', key, value))
    return args


def bwrap_argv(cmd: list[str], *, work: Path, read_only: list[Path], read_write: list[Path]) -> list[str]:
    """bubblewrap argv. Host ``/etc/hostname`` and host ``/proc`` are not mounted.

    No ``--proc /proc``: Docker refuses that mount (``Can't mount proc on /proc``).
    No ``--ro-bind /proc /proc`` either: that would let the compile read
    ``/proc/<server pid>/environ``. The real ``xtensa-esp-elf-g++`` (and host
    g++, when no toolchain is installed) preprocesses and compiles with no
    ``/proc`` at all, so nothing is mounted there. ``--unshare-pid`` stays.
    """
    argv = [
        'bwrap', '--die-with-parent', '--unshare-net', '--unshare-pid', '--new-session',
    ]
    for dev in ('/dev/null', '/dev/zero', '/dev/urandom', '/dev/random'):
        if Path(dev).exists():
            argv.extend(('--dev-bind', dev, dev))
    # Tmpfs roots first. A toolchain, cache, or work directory under /tmp,
    # /home, /opt, /etc, or /root would be hidden if its bind came first.
    argv.extend(('--tmpfs', '/tmp', '--tmpfs', '/home', '--tmpfs', '/etc', '--tmpfs', '/root', '--tmpfs', '/opt'))
    bound: list[Path] = []
    for path in _existing(_SYSTEM_RO):
        argv.extend(('--ro-bind', str(path), str(path)))
        bound.append(path)
    for path in _existing(_ETC_FILES):
        argv.extend(('--ro-bind', str(path), str(path)))
    for path in _existing(_ETC_DIRS):
        argv.extend(('--ro-bind', str(path), str(path)))
    ro_paths = []
    for raw in list(read_only) + _binary_dirs(cmd):
        path = Path(raw)
        if not path.exists() or _covered(path, bound) or _covered(path, [Path(work)]):
            continue
        ro_paths.append(path)
    # Longer paths first would not matter; skip a path already covered by an earlier ro bind.
    mounted_ro: list[Path] = []
    for path in ro_paths:
        if _covered(path, mounted_ro):
            continue
        argv.extend(('--ro-bind', str(path), str(path)))
        mounted_ro.append(path)
    for raw in read_write:
        path = Path(raw)
        try:
            path.mkdir(parents=True, exist_ok=True)
        except OSError:
            if not path.exists():
                continue
        argv.extend(('--bind', str(path), str(path)))
    argv.extend(('--chdir', str(work)))
    argv.extend(_env_args())
    argv.append('--')
    argv.extend(cmd)
    return argv


def _binary_dirs(cmd: list[str]) -> list[Path]:
    if not cmd:
        return []
    exe = cmd[0]
    found = exe if os.path.isabs(exe) else (shutil.which(exe) or '')
    if not found:
        return []
    return [Path(found).resolve().parent]


def docker_argv(cmd: list[str], *, work: Path, read_only: list[Path], read_write: list[Path],
                image: str) -> list[str]:
    """Unused. Bubblewrap is the only sandbox; ``resolve_backend`` never returns docker.

    Kept so the old ``docker run`` shape is visible. ``SIM_COMPILE_SANDBOX_IMAGE``
    does not select it.
    """
    argv = [
        'docker', 'run', '--rm', '--network', 'none', '--read-only',
        '--user', f'{os.getuid()}:{os.getgid()}',
        '--entrypoint', cmd[0],
    ]
    # Tmpfs roots before any bind. A later --tmpfs hides a -v under that root.
    argv.extend(('--tmpfs', '/tmp', '--tmpfs', '/home', '--tmpfs', '/root'))
    for path in _existing(_SYSTEM_RO):
        argv.extend(('-v', f'{path}:{path}:ro'))
    for path in _existing(_ETC_FILES + _ETC_DIRS):
        mode = 'ro'
        argv.extend(('-v', f'{path}:{path}:{mode}'))
    for raw in list(read_only) + _binary_dirs(cmd):
        path = Path(raw)
        if path.exists():
            argv.extend(('-v', f'{path}:{path}:ro'))
    for raw in read_write:
        path = Path(raw)
        argv.extend(('-v', f'{path}:{path}'))
    argv.extend(('-w', str(work), '-e', 'HOME=' + str(Path.home()), '-e', 'LANG=C', '-e', 'TMPDIR=/tmp'))
    lib = dynconfig_library_dir()
    if lib:
        argv.extend(('-e', 'LD_LIBRARY_PATH=' + lib))
    for key in _PASS_ENV:
        value = os.environ.get(key)
        if value:
            argv.extend(('-e', f'{key}={value}'))
    argv.append(image)
    argv.extend(cmd[1:])
    return argv


def wrap_command(cmd: list[str], *, work: Path, read_only: list[Path] | None = None,
                 read_write: list[Path] | None = None, env=None) -> tuple[list[str] | None, str | None]:
    """Return ``(argv, None)`` or ``(None, message)``. Flag off returns ``cmd`` unchanged."""
    backend = resolve_backend(env)
    if backend == 'off':
        return list(cmd), None
    refusal = sandbox_refusal(env)
    if refusal:
        return None, refusal
    work = Path(work)
    ro = list(read_only or [])
    rw = list(read_write or [work])
    if backend == 'bwrap':
        return bwrap_argv(cmd, work=work, read_only=ro, read_write=rw), None
    # docker_argv is not selected. A missing bwrap is a refusal, not another runtime.
    return None, SANDBOX_MSG
