"""Bound disk use for /api/compile and QEMU runs.

arduino-cli 1.5.1 (the version the lab image installs) writes each sketch build to
``<cache>/sketches/<md5 of the sketch path>`` and compiled cores to ``<cache>/cores``.
The default cache is ``~/.cache/arduino``. Its own purge still targets ``$TMP/arduino``
(the pre-1.0 location) and, even there, only drops entries older than 30 days after
every 10th compile. Sketch trees therefore accumulate for as long as the process
lives. This module deletes the per-request build directory and that sketch tree,
and only size/age-caps the core and library archives the next compile reuses.

Installed cores and libraries (``~/.arduino15``, ``~/Arduino``, or the
``ARDUINO_DIRECTORIES_*`` overrides) are never touched.
"""

from __future__ import annotations

import hashlib
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
ORPHAN_PREFIXES = ('esp32build-', 'esp32run-', 'arduino-sketch-')
IMAGE_KEEP = ('flash.bin', 'log.txt', 'net.txt')
_YAML_KEY = re.compile(r'^([A-Za-z0-9_.-]+)\s*:\s*$')
_YAML_PATH = re.compile(r'^\s+path:\s*(.*?)\s*$')


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
    """
    result = EvictResult()
    for root in roots:
        for entry in cache_entries(root):
            if entry.kind != 'sketch' or entry.used < started:
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


def prepare_for_compile(*, builds: Path, cache_roots, temp_roots, limits: Limits,
                        keep_images: set[str] | None = None, now: float | None = None,
                        stat=None) -> dict:
    """Apply cache caps, then refuse to compile when free space stays under the floor."""
    now = time.time() if now is None else now
    keep_images = set(keep_images or ())
    reclaimed = reclaim_firmware_tree(builds)
    images = evict_firmware(builds, max_bytes=limits.image_max_bytes, max_age_s=limits.image_max_age_s,
                            keep=keep_images, now=now)
    caches = evict_build_cache(
        cache_roots, sketch_max_bytes=limits.sketch_max_bytes, sketch_max_age_s=limits.sketch_max_age_s,
        core_max_bytes=limits.core_max_bytes, core_max_age_s=limits.core_max_age_s, now=now)

    def emergency() -> None:
        # Firmware images and sketch trees are reproducible. Extra core archives go too.
        # The newest core archive is kept so the next compile does not rebuild the ESP32 core.
        evict_firmware(builds, max_bytes=0, max_age_s=0, keep=keep_images, now=now)
        evict_build_cache(
            cache_roots, sketch_max_bytes=0, sketch_max_age_s=0,
            core_max_bytes=0, core_max_age_s=0, now=now, keep_newest_cores=1)

    check = [builds, *cache_roots, *temp_roots]
    free = guard_free_space(check, limits.min_free_bytes, emergency, stat=stat)
    return {'reclaimed': reclaimed.freed, 'images': images.freed, 'caches': caches.freed, 'free': free}


def startup(*, builds: Path, cache_roots, temp_roots, limits: Limits, now: float | None = None) -> dict:
    """Sweep orphans, strip pre-fix build trees, and apply the same caps a compile would."""
    now = time.time() if now is None else now
    orphans = sweep_orphans(list(temp_roots) + [builds], max_age_s=limits.orphan_max_age_s, now=now)
    reclaimed = reclaim_firmware_tree(builds)
    images = evict_firmware(builds, max_bytes=limits.image_max_bytes, max_age_s=limits.image_max_age_s, now=now)
    caches = evict_build_cache(
        cache_roots, sketch_max_bytes=limits.sketch_max_bytes, sketch_max_age_s=limits.sketch_max_age_s,
        core_max_bytes=limits.core_max_bytes, core_max_age_s=limits.core_max_age_s, now=now)
    return {
        'orphans': [str(p) for p in orphans],
        'reclaimed_bytes': reclaimed.freed,
        'image_bytes': images.freed,
        'cache_bytes': caches.freed,
    }
