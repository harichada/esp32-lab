"""Bound disk use for /api/compile and QEMU runs.

arduino-cli 1.5.1 (the version the lab image installs) writes each sketch build to
``<cache>/sketches/<md5 of the sketch path>`` and compiled cores to ``<cache>/cores``.
The default cache is ``~/.cache/arduino``. Its own purge still targets ``$TMP/arduino``
(the pre-1.0 location) and, even there, only drops entries older than 30 days after
every 10th compile. Sketch trees therefore accumulate for as long as the process
lives. This module deletes the per-request build directory and that sketch tree,
and only size/age-caps the core and library archives the next compile reuses.
The QemuEth/lwIP objects are a separate archive under ``<cache>/netstack/<key>/``.
Sketch deletion and the orphan sweep keep that directory; it has its own size and age cap.

Installed cores and libraries (``~/.arduino15``, ``~/Arduino``, or the
``ARDUINO_DIRECTORIES_*`` overrides) are never touched.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path

SKETCH_DIRS = ('sketches', 'sketch')
# Compiled archives only. Installed library sources live outside this cache.
CORE_DIRS = ('cores', 'core', 'libraries')
# Prebuilt QemuEth + lwIP shim archive. Not a sketch tree and not an orphan prefix, so the
# per-compile sketch wipe and the startup orphan sweep leave it in place. Capped on its own.
NETSTACK_DIR = 'netstack'
ORPHAN_PREFIXES = ('esp32build-', 'esp32run-', 'arduino-sketch-')
IMAGE_KEEP = ('flash.bin', 'log.txt', 'net.txt')
_YAML_KEY = re.compile(r'^([A-Za-z0-9_.-]+)\s*:\s*$')
_YAML_PATH = re.compile(r'^\s+path:\s*(.*?)\s*$')
_COMPILE_LINE = re.compile(r'^\[(\d+(?:\.\d+)?)s\] compile(.*)$', re.M)
_NETSTACK_KEY = re.compile(r'^[0-9a-f]{16,64}$')
# Same filter /api/compile applies to the defines array the browser posts.
_DEFINE_RE = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*(=[A-Za-z0-9_."]*)?$')
_REMOTE_DEFINES = re.compile(
    r"Wi-Fi/IR TV Remote[\s\S]{0,2000}?defines\s*:\s*\[([^\]]*)\]")


class LowDisk(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


@dataclass
class Entry:
    path: Path
    kind: str  # 'sketch' or 'core'
    size: int
    used: float


@dataclass
class EvictResult:
    removed: list[Path] = field(default_factory=list)
    freed: int = 0


def dir_size(path: Path) -> int:
    """Apparent byte size of a file or directory. Symlinks count as the link, not the target."""
    path = Path(path)
    try:
        st = path.lstat()
    except OSError:
        return 0
    if not path.is_dir() or path.is_symlink():
        return st.st_size
    total = 0
    for root, dirnames, filenames in os.walk(path, followlinks=False):
        # Don't descend through symlinked directories.
        dirnames[:] = [d for d in dirnames if not (Path(root) / d).is_symlink()]
        for name in filenames:
            fp = Path(root) / name
            try:
                fst = fp.lstat()
            except OSError:
                continue
            if not fp.is_symlink():
                total += fst.st_size
    return total


def last_used(path: Path) -> float:
    """arduino-cli stamps ``.last-used`` on each cache entry. Fall back to the directory mtime."""
    stamp = path / '.last-used'
    try:
        if stamp.is_file():
            return stamp.stat().st_mtime
        return path.stat().st_mtime
    except OSError:
        return 0.0


def disk_stat(path: Path) -> tuple[int, int]:
    """``(free, total)`` bytes for the filesystem that holds ``path``."""
    probe = Path(path)
    while not probe.exists() and probe != probe.parent:
        probe = probe.parent
    usage = shutil.disk_usage(probe)
    return usage.free, usage.total


def free_bytes(path: Path) -> int:
    return disk_stat(path)[0]


def cache_entries(root: Path) -> list[Entry]:
    root = Path(root)
    if not root.is_dir():
        return []
    found: list[Entry] = []
    for name in SKETCH_DIRS:
        found.extend(_children(root / name, 'sketch'))
    for name in CORE_DIRS:
        found.extend(_children(root / name, 'core'))
    return found


def _children(directory: Path, kind: str) -> list[Entry]:
    if not directory.is_dir():
        return []
    out = []
    for child in directory.iterdir():
        if child.is_dir() and not child.is_symlink():
            out.append(Entry(child, kind, dir_size(child), last_used(child)))
    return out


def _rmtree(path: Path) -> bool:
    shutil.rmtree(path, ignore_errors=True)
    return not path.exists()


def evict_entries(entries: list[Entry], *, max_bytes: int, max_age_s: float, now: float,
                  keep_newest: int = 0, drop_oversize_newest: bool = False) -> EvictResult:
    """Drop oldest entries that are past ``max_age_s`` or that push the total over ``max_bytes``.

    ``keep_newest`` entries (by last-used time) are kept even when they are old or the
    total is over the cap. When ``drop_oversize_newest`` is set, those protected entries
    are removed too if they alone still exceed ``max_bytes`` — used for sketch trees,
    which are not worth a slow compile. Core archives pass ``drop_oversize_newest=False``
    so the newest core.a survives a tight cap.
    """
    result = EvictResult()
    if not entries:
        return result
    ordered = sorted(entries, key=lambda e: (e.used, str(e.path)))
    protected = {e.path for e in ordered[-keep_newest:]} if keep_newest > 0 else set()
    remaining = list(ordered)

    def drop(entry: Entry) -> None:
        if _rmtree(entry.path):
            result.removed.append(entry.path)
            result.freed += entry.size
            remaining.remove(entry)

    for entry in list(remaining):
        if entry.path in protected:
            continue
        if max_age_s >= 0 and now - entry.used > max_age_s:
            drop(entry)
    if max_bytes <= 0:
        # A zero cap means "keep nothing" (sketch trees). An empty .last-used file has
        # size 0, which would otherwise look like it already fits.
        for entry in list(remaining):
            if entry.path in protected and not drop_oversize_newest:
                continue
            drop(entry)
        return result
    total = sum(e.size for e in remaining)
    for entry in list(remaining):
        if total <= max_bytes:
            break
        if entry.path in protected:
            continue
        total -= entry.size
        drop(entry)
    if drop_oversize_newest:
        for entry in list(remaining):
            if total <= max_bytes:
                break
            total -= entry.size
            drop(entry)
    return result


def evict_build_cache(roots, *, sketch_max_bytes: int, sketch_max_age_s: float,
                      core_max_bytes: int, core_max_age_s: float, now: float | None = None,
                      keep_newest_cores: int = 1) -> EvictResult:
    """Cap every build-cache root. Sketch trees go first; the newest core archive stays."""
    now = time.time() if now is None else now
    combined = EvictResult()
    for root in roots:
        entries = cache_entries(root)
        sketches = [e for e in entries if e.kind == 'sketch']
        cores = [e for e in entries if e.kind == 'core']
        for part in (
            evict_entries(sketches, max_bytes=max(0, sketch_max_bytes), max_age_s=sketch_max_age_s,
                          now=now, keep_newest=0, drop_oversize_newest=True),
            evict_entries(cores, max_bytes=max(0, core_max_bytes), max_age_s=core_max_age_s,
                          now=now, keep_newest=max(0, keep_newest_cores), drop_oversize_newest=False),
        ):
            combined.removed.extend(part.removed)
            combined.freed += part.freed
    return combined


def forget_sketch_builds_since(roots, started: float) -> EvictResult:
    """Delete sketch trees touched at or after ``started``. Does not touch cores or libraries.

    arduino-cli keys the sketch directory by the sketch *path*. The server's sketch path
    is a fresh temp directory, so the tree is never reused; leaving it is the per-compile leak.
    The network-stack archive (``netstack/<key>/``) is not a sketch tree and is not deleted here.
    """
    result = EvictResult()
    for root in roots:
        for entry in cache_entries(root):
            if entry.kind != 'sketch' or entry.used < started:
                continue
            if preserves_netstack(entry.path):
                continue
            if _rmtree(entry.path):
                result.removed.append(entry.path)
                result.freed += entry.size
    return result


def request_sketch_hash(sketch_dir: Path) -> str:
    """Same key arduino-cli 1.5.1 uses: uppercase MD5 of the absolute sketch path."""
    return hashlib.md5(str(Path(sketch_dir).resolve()).encode()).hexdigest().upper()


@contextmanager
def request_build_dir(parent: Path | None = None):
    """Per-request scratch (sources + arduino-cli ``--output-dir``). Always removed."""
    path = Path(tempfile.mkdtemp(prefix='esp32build-', dir=str(parent) if parent else None))
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)


def reclaim_firmware_tree(builds: Path) -> EvictResult:
    """Drop leftover compiler output from older servers and delete failed builds.

    A successful entry keeps ``flash.bin``, ``log.txt`` and ``net.txt``. ``out/`` (the old
    ``--output-dir``, including the padded merged image) and ``sketch/`` are the leak.
    A directory with no ``flash.bin`` is a failed or half-written compile and is removed.
    Files sitting directly in ``builds`` (``qemu-last.log``) are left alone.
    """
    result = EvictResult()
    builds = Path(builds)
    if not builds.is_dir():
        return result
    for child in list(builds.iterdir()):
        if not child.is_dir() or child.is_symlink():
            continue
        if preserves_netstack(child):
            continue
        image = child / 'flash.bin'
        if not image.is_file():
            size = dir_size(child)
            if _rmtree(child):
                result.removed.append(child)
                result.freed += size
            continue
        for name in ('out', 'sketch', 'flash.bin.partial'):
            extra = child / name
            if not extra.exists():
                continue
            size = dir_size(extra)
            if extra.is_dir() and not extra.is_symlink():
                ok = _rmtree(extra)
            else:
                try:
                    extra.unlink()
                    ok = not extra.exists()
                except OSError:
                    ok = False
            if ok:
                result.removed.append(extra)
                result.freed += size
    return result


def firmware_entries(builds: Path) -> list[Entry]:
    builds = Path(builds)
    if not builds.is_dir():
        return []
    out = []
    for child in builds.iterdir():
        if child.is_dir() and not child.is_symlink() and (child / 'flash.bin').is_file():
            out.append(Entry(child, 'image', dir_size(child), last_used_image(child)))
    return out


def last_used_image(entry: Path) -> float:
    img = entry / 'flash.bin'
    try:
        return img.stat().st_mtime
    except OSError:
        return last_used(entry)


def evict_firmware(builds: Path, *, max_bytes: int, max_age_s: float, keep: set[str] | None = None,
                   now: float | None = None) -> EvictResult:
    """LRU-cap published firmware images. ``keep`` holds directory names that a live QEMU run is using."""
    now = time.time() if now is None else now
    keep = keep or set()
    entries = firmware_entries(builds)
    # In-use images count against the cap but are never deleted (QEMU has its own copy,
    # and a reconnect still looks the build id up here).
    kept_size = sum(e.size for e in entries if e.path.name in keep)
    eligible = [e for e in entries if e.path.name not in keep]
    budget = max(0, max_bytes - kept_size)
    return evict_entries(eligible, max_bytes=budget, max_age_s=max_age_s, now=now,
                         keep_newest=0, drop_oversize_newest=True)


def touch_firmware(image: Path) -> None:
    now = time.time()
    os.utime(image, (now, now))
    try:
        os.utime(image.parent, (now, now))
    except OSError:
        pass


def publish_firmware(entry: Path, image: Path, log: str, net: str) -> Path:
    """Publish flash.bin last, so a crash cannot look like a cache hit on a partial image."""
    entry = Path(entry)
    entry.mkdir(parents=True, exist_ok=True)
    partial = entry / 'flash.bin.partial'
    shutil.copyfile(image, partial)
    (entry / 'log.txt').write_text(log)
    (entry / 'net.txt').write_text(net or '')
    partial.replace(entry / 'flash.bin')
    return entry / 'flash.bin'


def sweep_orphans(roots, *, max_age_s: float, now: float | None = None,
                  prefixes: tuple[str, ...] = ORPHAN_PREFIXES) -> list[Path]:
    """Delete abandoned temp directories older than ``max_age_s``. Call this at process start.

    A live QEMU run keeps its ``esp32run-*`` directory for the whole session (hours, if the
    resume grace says so). Sweeping only at startup means a long run is never deleted out
    from under qemu, and a directory left by a dead process is.
    """
    now = time.time() if now is None else now
    removed: list[Path] = []
    seen: set[str] = set()
    for root in roots:
        root = Path(root)
        if not root.is_dir():
            continue
        for child in list(root.iterdir()):
            if not child.is_dir() or child.is_symlink():
                continue
            if preserves_netstack(child):
                continue
            if not child.name.startswith(prefixes):
                continue
            key = str(child)
            if key in seen:
                continue
            seen.add(key)
            try:
                age = now - child.stat().st_mtime
            except OSError:
                continue
            if age < max_age_s:
                continue
            if _rmtree(child):
                removed.append(child)
    return removed


def guard_free_space(paths, min_free_bytes: int, evict, stat=None) -> int:
    """If a filesystem we are about to write is under ``min_free_bytes``, call ``evict`` once.

    A filesystem smaller than the floor (a little tmpfs for ``/tmp``) cannot meet it; that
    one only has to keep 32 MB free so the per-request output directory still fits. The
    persistent build and cache disks keep the full floor. Raises LowDisk when space is still
    short, so the caller does not start a compile that would fail halfway through the objects.
    ``stat`` is a ``path -> (free, total)`` hook for tests.
    """
    stat = stat or disk_stat
    modest = 32 * 1024 * 1024

    def requirement(total: int) -> int:
        if total >= min_free_bytes:
            return min_free_bytes
        return min(modest, max(0, total // 2))

    def shortfall():
        worst = None
        for path in paths:
            try:
                free, total = stat(Path(path))
                free, total = int(free), int(total)
            except OSError:
                continue
            need = requirement(total)
            if free < need and (worst is None or need - free > worst[1] - worst[0]):
                worst = (free, need)
        return worst

    def large_free() -> int:
        frees = []
        for path in paths:
            try:
                free, total = stat(Path(path))
            except OSError:
                continue
            if int(total) >= min_free_bytes:
                frees.append(int(free))
        return min(frees) if frees else 0

    if shortfall() is None:
        return large_free()
    evict()
    bad = shortfall()
    if bad is not None:
        have = bad[0] // (1024 * 1024)
        need = bad[1] // (1024 * 1024)
        raise LowDisk(
            f'low disk: {have} MB free after clearing firmware images and old build caches '
            f'(need {need} MB). The installed ESP32 core and the newest compiled core archive were kept. '
            f'Compile was not started.'
        )
    return large_free()


def _env_float(env, name: str, default: float) -> float:
    raw = env.get(name)
    if raw is None or str(raw).strip() == '':
        return default
    try:
        return float(raw)
    except ValueError:
        return default


@dataclass(frozen=True)
class Limits:
    min_free_bytes: int = 300 * 1024 * 1024
    orphan_max_age_s: float = 3600
    image_max_bytes: int = 128 * 1024 * 1024
    image_max_age_s: float = 7 * 24 * 3600
    sketch_max_bytes: int = 0
    sketch_max_age_s: float = 3600
    core_max_bytes: int = 512 * 1024 * 1024
    core_max_age_s: float = 30 * 24 * 3600
    # One QemuEth/lwIP archive is about 2.6 MB. A few keys (defines, FQBN, core) fit under 64 MB.
    netstack_max_bytes: int = 64 * 1024 * 1024
    netstack_max_age_s: float = 30 * 24 * 3600

    @classmethod
    def from_env(cls, env=None) -> 'Limits':
        env = os.environ if env is None else env

        def mib(name: str, default_mib: int) -> int:
            return int(_env_float(env, name, default_mib) * 1024 * 1024)

        return cls(
            min_free_bytes=mib('SIM_MIN_FREE_MB', 300),
            orphan_max_age_s=_env_float(env, 'SIM_ORPHAN_MAX_AGE_S', 3600),
            image_max_bytes=mib('SIM_IMAGE_CACHE_MAX_MB', 128),
            image_max_age_s=_env_float(env, 'SIM_IMAGE_CACHE_MAX_AGE_S', 7 * 24 * 3600),
            sketch_max_bytes=mib('SIM_SKETCH_CACHE_MAX_MB', 0),
            sketch_max_age_s=_env_float(env, 'SIM_SKETCH_CACHE_MAX_AGE_S', 3600),
            core_max_bytes=mib('SIM_CORE_CACHE_MAX_MB', 512),
            core_max_age_s=_env_float(env, 'SIM_CORE_CACHE_MAX_AGE_S', 30 * 24 * 3600),
            netstack_max_bytes=mib('SIM_NETSTACK_CACHE_MAX_MB', 64),
            netstack_max_age_s=_env_float(env, 'SIM_NETSTACK_CACHE_MAX_AGE_S', 30 * 24 * 3600),
        )


def build_cache_path_from_yaml(text: str) -> str | None:
    """Read ``build_cache.path`` from an arduino-cli.yaml document. Empty means unset."""
    in_block = False
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith('#'):
            continue
        if not line.startswith((' ', '\t')):
            match = _YAML_KEY.match(stripped)
            in_block = bool(match and match.group(1) == 'build_cache')
            continue
        if not in_block:
            continue
        match = _YAML_PATH.match(line)
        if not match:
            continue
        value = match.group(1).strip().strip('"').strip("'")
        return value or None
    return None


def cache_roots_from_env(env=None, home: Path | None = None, tmp: Path | None = None,
                         yaml_text: str | None = None) -> list[Path]:
    """Every directory arduino-cli might be writing sketch and core builds into.

    Always includes the legacy ``$TMP/arduino`` location, because 1.5.1's purge still
    looks there and an older CLI on the same host may have filled it.
    """
    env = os.environ if env is None else env
    home = Path.home() if home is None else Path(home)
    tmp = Path(tempfile.gettempdir()) if tmp is None else Path(tmp)
    roots: list[Path] = []

    def add(path) -> None:
        if not path:
            return
        path = Path(path)
        if path not in roots:
            roots.append(path)

    add(env.get('SIM_BUILD_CACHE_DIR'))
    add(env.get('ARDUINO_BUILD_CACHE_PATH'))
    if yaml_text is None:
        yaml_text = _read_cli_yaml(env, home)
    if yaml_text:
        add(build_cache_path_from_yaml(yaml_text))
    cache_home = env.get('XDG_CACHE_HOME')
    add(Path(cache_home) / 'arduino' if cache_home else home / '.cache' / 'arduino')
    add(tmp / 'arduino')
    return roots


def _read_cli_yaml(env, home: Path) -> str | None:
    candidates = []
    for key in ('ARDUINO_DIRECTORIES_DATA', 'ARDUINO_DATA_DIR'):
        if env.get(key):
            candidates.append(Path(env[key]) / 'arduino-cli.yaml')
    candidates.append(home / '.arduino15' / 'arduino-cli.yaml')
    for path in candidates:
        try:
            if path.is_file():
                return path.read_text(errors='replace')
        except OSError:
            continue
    return None


def preserves_netstack(path: Path) -> bool:
    """True for the network-stack cache and for an entry that holds ``libnetstack.a``.

    Sketch-tree deletion, firmware reclaim, and the orphan sweep all call this so a
    directory that is the netstack cache — or was named like a temp build but already
    holds the archive — is not removed. Size and age limits go through ``evict_netstack``.
    """
    path = Path(path)
    if path.name == NETSTACK_DIR:
        return True
    try:
        return (path / 'libnetstack.a').is_file()
    except OSError:
        return False


def netstack_entries(root: Path | None) -> list[Entry]:
    root = Path(root) if root is not None else None
    if root is None or not root.is_dir():
        return []
    out = []
    for child in root.iterdir():
        if child.is_dir() and not child.is_symlink() and (child / 'libnetstack.a').is_file():
            out.append(Entry(child, 'netstack', dir_size(child), last_used(child)))
    return out


def evict_netstack(root, *, max_bytes: int, max_age_s: float, now: float | None = None,
                   keep_newest: int = 1) -> EvictResult:
    """Cap ``netstack/<key>/`` entries. The newest archive survives a tight cap, same as core.a."""
    now = time.time() if now is None else now
    if root is None:
        return EvictResult()
    return evict_entries(
        netstack_entries(root), max_bytes=max(0, max_bytes), max_age_s=max_age_s, now=now,
        keep_newest=max(0, keep_newest), drop_oversize_newest=False)


def netstack_key(*, toolchain: str, core: str, shim_hash: str, fqbn: str, defines=()) -> str:
    """Cache key for one prebuilt network stack.

    ``shim_hash`` is the QemuEth source hash. ``toolchain`` is the compiler version (and path,
    so a relocated install misses). ``core`` is the esp32 platform version. ``defines`` are the
    ``-D`` flags applied to every translation unit. ``SIM_NO_LAN_REMAP`` changes ``qemu_eth.cpp``,
    so a different define list is a different archive.
    """
    parts = [toolchain.strip(), core.strip(), shim_hash.strip(), fqbn.strip(), *sorted(defines)]
    return hashlib.sha256('\n'.join(parts).encode()).hexdigest()[:24]


def sanitize_defines(raw) -> list[str]:
    """Keep the ``-D`` tokens ``/api/compile`` will actually pass to the compiler."""
    if not raw:
        return []
    return [d for d in raw if isinstance(d, str) and _DEFINE_RE.fullmatch(d)]


def defines_from_examples_js(text: str) -> list[str]:
    """Defines the Wi-Fi remote example posts.

    ``web/js/examples.js`` is what the page loads. The remote example is the network
    sketch, and its ``defines`` array is the body field ``/api/compile`` sanitizes.
    """
    match = _REMOTE_DEFINES.search(text or '')
    if not match:
        return []
    raw = re.findall(r"""['"]([^'"]*)['"]""", match.group(1))
    return sanitize_defines(raw)


def netstack_warm_enabled(env=None) -> bool:
    """Prebuild the browser's network archive at startup. Default on; ``SIM_NETSTACK_WARM=0`` turns it off."""
    env = os.environ if env is None else env
    return env.get('SIM_NETSTACK_WARM', '1') == '1'


def compile_gate(*, locked: bool, queue: bool, warm_running: bool) -> str:
    """How ``/api/compile`` treats a busy compiler.

    ``wait`` — the startup network warm-up holds the lock. The request blocks on that
    lock and does not answer 429, so the page does not show the "please wait" message.
    ``retry`` — another user compile holds the lock. Answer 429 with ``Retry-After``.
    ``go`` — the lock is free, or this caller is the warm-up and may queue for it.
    """
    if queue or not locked:
        return 'go'
    if warm_running:
        return 'wait'
    return 'retry'


def plan_netstack_warm(env, example_js, *, cache_present: bool, toolchain: str, core: str,
                       shim_hash: str, fqbn: str) -> dict:
    """What a startup warm does with the defines a browser compile of the remote example posts.

    ``action`` is ``off`` (flag), ``missing`` (the example has no defines), ``skip`` (archive
    already there), or ``build``. ``key`` is the archive a later compile looks up for those defines.
    """
    if not netstack_warm_enabled(env):
        return {'action': 'off', 'defines': (), 'key': None}
    defines = tuple(defines_from_examples_js(example_js))
    if not defines:
        return {'action': 'missing', 'defines': (), 'key': None}
    key = netstack_key(toolchain=toolchain, core=core, shim_hash=shim_hash, fqbn=fqbn, defines=defines)
    return {'action': 'skip' if cache_present else 'build', 'defines': defines, 'key': key}


def source_tree_hash(root: Path) -> str:
    """Stable short hash of every file under ``root``. Symlinks are ignored."""
    digest = hashlib.sha256()
    root = Path(root)
    if not root.is_dir():
        return digest.hexdigest()[:16]
    files = [p for p in root.rglob('*') if p.is_file() and not p.is_symlink()]
    for path in sorted(files, key=lambda p: p.relative_to(root).as_posix()):
        digest.update(path.relative_to(root).as_posix().encode())
        digest.update(b'\0')
        digest.update(path.read_bytes())
        digest.update(b'\0')
    return digest.hexdigest()[:16]


def publish_netstack(root: Path, key: str, archive: Path, libraries_cache: bytes, manifest: dict) -> Path:
    """Publish one archive. The directory appears only after ``libnetstack.a`` is in place."""
    if not _NETSTACK_KEY.fullmatch(key):
        raise ValueError('bad netstack key')
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    tmp = root / f'.{key}.partial'
    if tmp.exists():
        shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    shutil.copyfile(archive, tmp / 'libnetstack.a')
    (tmp / 'libraries.cache').write_bytes(libraries_cache)
    (tmp / 'manifest.json').write_text(json.dumps(manifest, sort_keys=True))
    (tmp / '.last-used').write_bytes(b'')
    dest = root / key
    if dest.exists():
        shutil.rmtree(dest, ignore_errors=True)
    tmp.rename(dest)
    return dest


def find_netstack(root: Path, key: str) -> Path | None:
    """Return the archive directory for ``key``, or None. A hit refreshes ``.last-used``."""
    if not _NETSTACK_KEY.fullmatch(key or ''):
        return None
    dest = Path(root) / key
    if not (dest / 'libnetstack.a').is_file() or not (dest / 'libraries.cache').is_file():
        return None
    now = time.time()
    stamp = dest / '.last-used'
    try:
        if not stamp.exists():
            stamp.write_bytes(b'')
        os.utime(stamp, (now, now))
        os.utime(dest, (now, now))
    except OSError:
        pass
    return dest


def arduino_build_cache_dir(env=None, home: Path | None = None, tmp: Path | None = None,
                            yaml_text: str | None = None) -> Path:
    """The build cache arduino-cli 1.5.1 writes, skipping the legacy ``$TMP/arduino`` scan path."""
    env = os.environ if env is None else env
    tmp = Path(tempfile.gettempdir()) if tmp is None else Path(tmp)
    legacy = tmp / 'arduino'
    for root in cache_roots_from_env(env, home=home, tmp=tmp, yaml_text=yaml_text):
        if root != legacy:
            return root
    return legacy


def netstack_root_from_env(env=None, home: Path | None = None, tmp: Path | None = None,
                           yaml_text: str | None = None) -> Path:
    """Directory of ``<key>/libnetstack.a`` entries. ``SIM_NETSTACK_CACHE_DIR`` overrides it."""
    env = os.environ if env is None else env
    override = env.get('SIM_NETSTACK_CACHE_DIR')
    if override:
        return Path(override)
    return arduino_build_cache_dir(env, home=home, tmp=tmp, yaml_text=yaml_text) / NETSTACK_DIR


def cached_build_log(log: str, elapsed_s: float) -> str:
    """A firmware-cache hit is one line, not a replay of the build that filled the cache.

    Stage lines from that build (``Building network stack...``, ``Compiling sketch...``,
    ``Linking...``) are dropped. The line uses ``elapsed_s`` for this request and names the
    original duration, for example ``[0.0s] cached (originally built in 41.4 s)``.
    """
    elapsed = f'{max(0.0, float(elapsed_s)):.1f}'
    matches = list(_COMPILE_LINE.finditer(log or ''))
    if not matches:
        return f'[{elapsed}s] cached\n'
    match = matches[-1]
    orig = match.group(1)
    rest = match.group(2).strip()
    header = f'[{elapsed}s] cached (originally built in {orig} s)' + (f' {rest}' if rest else '')
    return header + '\n'


def prepare_for_compile(*, builds: Path, cache_roots, temp_roots, limits: Limits,
                        keep_images: set[str] | None = None, now: float | None = None,
                        stat=None, netstack_root: Path | None = None) -> dict:
    """Apply cache caps, then refuse to compile when free space stays under the floor."""
    now = time.time() if now is None else now
    keep_images = set(keep_images or ())
    reclaimed = reclaim_firmware_tree(builds)
    images = evict_firmware(builds, max_bytes=limits.image_max_bytes, max_age_s=limits.image_max_age_s,
                            keep=keep_images, now=now)
    caches = evict_build_cache(
        cache_roots, sketch_max_bytes=limits.sketch_max_bytes, sketch_max_age_s=limits.sketch_max_age_s,
        core_max_bytes=limits.core_max_bytes, core_max_age_s=limits.core_max_age_s, now=now)
    stacks = evict_netstack(netstack_root, max_bytes=limits.netstack_max_bytes,
                            max_age_s=limits.netstack_max_age_s, now=now, keep_newest=1)

    def emergency() -> None:
        # Firmware images and sketch trees are reproducible. Extra core archives go too.
        # The newest core archive and the newest network-stack archive are kept so the next
        # compile does not rebuild the ESP32 core or the QemuEth/lwIP objects.
        evict_firmware(builds, max_bytes=0, max_age_s=0, keep=keep_images, now=now)
        evict_build_cache(
            cache_roots, sketch_max_bytes=0, sketch_max_age_s=0,
            core_max_bytes=0, core_max_age_s=0, now=now, keep_newest_cores=1)
        evict_netstack(netstack_root, max_bytes=0, max_age_s=0, now=now, keep_newest=1)

    check = [builds, *cache_roots, *temp_roots]
    if netstack_root is not None:
        check.append(netstack_root)
    free = guard_free_space(check, limits.min_free_bytes, emergency, stat=stat)
    return {'reclaimed': reclaimed.freed, 'images': images.freed, 'caches': caches.freed,
            'netstack': stacks.freed, 'free': free}


def startup(*, builds: Path, cache_roots, temp_roots, limits: Limits, now: float | None = None,
            netstack_root: Path | None = None) -> dict:
    """Sweep orphans, strip pre-fix build trees, and apply the same caps a compile would."""
    now = time.time() if now is None else now
    orphans = sweep_orphans(list(temp_roots) + [builds], max_age_s=limits.orphan_max_age_s, now=now)
    reclaimed = reclaim_firmware_tree(builds)
    images = evict_firmware(builds, max_bytes=limits.image_max_bytes, max_age_s=limits.image_max_age_s, now=now)
    caches = evict_build_cache(
        cache_roots, sketch_max_bytes=limits.sketch_max_bytes, sketch_max_age_s=limits.sketch_max_age_s,
        core_max_bytes=limits.core_max_bytes, core_max_age_s=limits.core_max_age_s, now=now)
    stacks = evict_netstack(netstack_root, max_bytes=limits.netstack_max_bytes,
                            max_age_s=limits.netstack_max_age_s, now=now, keep_newest=1)
    return {
        'orphans': [str(p) for p in orphans],
        'reclaimed_bytes': reclaimed.freed,
        'image_bytes': images.freed,
        'cache_bytes': caches.freed,
        'netstack_bytes': stacks.freed,
    }
