#!/usr/bin/env python3
"""Unit tests for compile/QEMU disk bounds. No arduino-cli, no server.

    python3 tests/diskkeep_test.py
"""
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import diskkeep


def _stamp(path: Path, when: float) -> None:
    os.utime(path, (when, when))


def _entry(root: Path, rel: str, size: int, used: float) -> Path:
    path = root / rel
    path.mkdir(parents=True)
    blob = path / 'payload'
    blob.write_bytes(b'x' * size)
    (path / '.last-used').write_bytes(b'')
    _stamp(path / '.last-used', used)
    _stamp(blob, used)
    _stamp(path, used - 10)
    return path


class EvictTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.now = 1_000_000.0

    def tearDown(self):
        self.tmp.cleanup()

    def test_sketch_lru_keeps_the_newest_tree_that_fits(self):
        old = _entry(self.root, 'sketches/old', 400, self.now - 100)
        new = _entry(self.root, 'sketches/new', 400, self.now - 10)
        result = diskkeep.evict_build_cache(
            [self.root], sketch_max_bytes=500, sketch_max_age_s=10_000,
            core_max_bytes=10_000, core_max_age_s=10_000, now=self.now)
        self.assertFalse(old.exists())
        self.assertTrue(new.exists())
        self.assertGreaterEqual(result.freed, 400)

    def test_single_oversize_sketch_tree_is_removed(self):
        huge = _entry(self.root, 'sketches/huge', 5000, self.now - 1)
        diskkeep.evict_build_cache(
            [self.root], sketch_max_bytes=500, sketch_max_age_s=10_000,
            core_max_bytes=10_000, core_max_age_s=10_000, now=self.now)
        self.assertFalse(huge.exists())

    def test_zero_sketch_cap_removes_empty_last_used_dir(self):
        empty = self.root / 'sketches' / 'empty'
        empty.mkdir(parents=True)
        (empty / '.last-used').write_bytes(b'')
        _stamp(empty / '.last-used', self.now)
        diskkeep.evict_build_cache(
            [self.root], sketch_max_bytes=0, sketch_max_age_s=10_000,
            core_max_bytes=10_000, core_max_age_s=10_000, now=self.now)
        self.assertFalse(empty.exists())

    def test_newest_core_survives_age_and_size_cap(self):
        old = _entry(self.root, 'cores/old-fqbn', 800, self.now - 100_000)
        (old / 'core.a').write_bytes(b'a' * 800)
        new = _entry(self.root, 'cores/new-fqbn', 800, self.now - 5)
        (new / 'core.a').write_bytes(b'b' * 800)
        lib = _entry(self.root, 'libraries/Wire', 100, self.now - 50_000)
        diskkeep.evict_build_cache(
            [self.root], sketch_max_bytes=0, sketch_max_age_s=0,
            core_max_bytes=500, core_max_age_s=1000, now=self.now, keep_newest_cores=1)
        self.assertFalse(old.exists())
        self.assertFalse(lib.exists())
        self.assertTrue(new.exists())
        self.assertTrue((new / 'core.a').is_file())

    def test_forget_since_skips_cores_and_older_sketches(self):
        fresh = _entry(self.root, 'sketches/THIS', 50, self.now)
        old = _entry(self.root, 'sketches/PREV', 50, self.now - 100)
        core = _entry(self.root, 'cores/esp32', 50, self.now)
        legacy = _entry(self.root / 'also', 'sketch/LEGACY', 20, self.now)
        result = diskkeep.forget_sketch_builds_since([self.root, self.root / 'also'], self.now - 2)
        self.assertFalse(fresh.exists())
        self.assertFalse(legacy.exists())
        self.assertTrue(old.exists())
        self.assertTrue(core.exists())
        self.assertGreaterEqual(result.freed, 70)

    def test_last_used_wins_over_directory_mtime(self):
        path = _entry(self.root, 'sketches/stamped', 10, self.now - 5)
        _stamp(path, self.now - 10_000)  # directory looks ancient; .last-used does not
        entries = diskkeep.cache_entries(self.root)
        self.assertEqual(len(entries), 1)
        self.assertAlmostEqual(entries[0].used, self.now - 5, places=3)

    def test_does_not_touch_installed_core_or_unknown_cache_dirs(self):
        installed = self.root / 'arduino15' / 'packages' / 'esp32'
        installed.mkdir(parents=True)
        (installed / 'platform.txt').write_text('core')
        (self.root / 'cache' / 'not-a-build').mkdir(parents=True)
        (self.root / 'cache' / 'not-a-build' / 'keep').write_bytes(b'y')
        _entry(self.root / 'cache', 'sketches/gone', 10, self.now)
        diskkeep.evict_build_cache(
            [self.root / 'cache'], sketch_max_bytes=0, sketch_max_age_s=0,
            core_max_bytes=0, core_max_age_s=0, now=self.now)
        self.assertTrue((installed / 'platform.txt').is_file())
        self.assertTrue((self.root / 'cache' / 'not-a-build' / 'keep').is_file())


class FirmwareAndOrphanTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.builds = Path(self.tmp.name) / 'builds'
        self.builds.mkdir()
        self.now = 2_000_000.0

    def tearDown(self):
        self.tmp.cleanup()

    def _image(self, name: str, size: int, used: float, with_leak: bool = False) -> Path:
        entry = self.builds / name
        entry.mkdir()
        (entry / 'flash.bin').write_bytes(b'f' * size)
        (entry / 'log.txt').write_text('log')
        (entry / 'net.txt').write_text('lwip')
        _stamp(entry / 'flash.bin', used)
        if with_leak:
            out = entry / 'out'
            out.mkdir()
            (out / 'sketch.ino.elf').write_bytes(b'e' * 1000)
            (out / 'sketch.ino.merged.bin').write_bytes(b'm' * 1000)
            (entry / 'sketch').mkdir()
            (entry / 'sketch' / 'sketch.ino').write_text('void setup(){}')
        return entry

    def test_reclaim_strips_compiler_output_and_failed_dirs(self):
        good = self._image('a' * 16, 100, self.now, with_leak=True)
        failed = self.builds / ('b' * 16)
        failed.mkdir()
        (failed / 'out').mkdir()
        (failed / 'out' / 'sketch.ino.elf').write_bytes(b'e' * 500)
        (failed / 'log.txt').write_text('error')
        (self.builds / 'qemu-last.log').write_bytes(b'q' * 20)
        result = diskkeep.reclaim_firmware_tree(self.builds)
        self.assertTrue((good / 'flash.bin').is_file())
        self.assertTrue((good / 'log.txt').is_file())
        self.assertTrue((good / 'net.txt').is_file())
        self.assertFalse((good / 'out').exists())
        self.assertFalse((good / 'sketch').exists())
        self.assertFalse(failed.exists())
        self.assertTrue((self.builds / 'qemu-last.log').is_file())
        self.assertGreaterEqual(result.freed, 1500)

    def test_firmware_lru_respects_age_size_and_live_runs(self):
        live = self._image('1' * 16, 100, self.now - 10_000)
        ancient = self._image('4' * 16, 10, self.now - 5000)
        old = self._image('2' * 16, 100, self.now - 100)
        new = self._image('3' * 16, 100, self.now - 10)
        # Live image counts against the cap. Budget fits the newer idle image and not both.
        diskkeep.evict_firmware(self.builds, max_bytes=220, max_age_s=1000, keep={live.name}, now=self.now)
        self.assertTrue((live / 'flash.bin').is_file())
        self.assertFalse(ancient.exists())  # idle and past the age, even though it is small
        self.assertFalse(old.exists())
        self.assertTrue((new / 'flash.bin').is_file())

    def test_publish_hides_partial_image(self):
        src = self.builds / 'src.bin'
        src.write_bytes(b'flash')
        entry = self.builds / ('c' * 16)
        image = diskkeep.publish_firmware(entry, src, 'built', '')
        self.assertEqual(image.read_bytes(), b'flash')
        self.assertFalse((entry / 'flash.bin.partial').exists())
        self.assertEqual((entry / 'log.txt').read_text(), 'built')
        self.assertEqual((entry / 'net.txt').read_text(), '')

    def test_request_dir_removed_on_success_and_failure(self):
        with diskkeep.request_build_dir(self.builds) as work:
            self.assertTrue(work.name.startswith('esp32build-'))
            (work / 'out').mkdir()
            (work / 'out' / 'sketch.ino.elf').write_bytes(b'e' * 100)
            seen = work
        self.assertFalse(seen.exists())
        with self.assertRaises(RuntimeError):
            with diskkeep.request_build_dir(self.builds) as work:
                seen = work
                raise RuntimeError('compile failed')
        self.assertFalse(seen.exists())

    def test_startup_sweeps_only_old_orphans(self):
        temp = Path(self.tmp.name) / 'tmp'
        temp.mkdir()
        old_run = temp / 'esp32run-deadbeef'
        old_build = temp / 'esp32build-aaaa'
        old_cli = temp / 'arduino-sketch-ABCD'
        young = temp / 'esp32run-live'
        other = temp / 'keep-me'
        for path in (old_run, old_build, old_cli, young, other):
            path.mkdir()
            (path / 'flash.bin').write_bytes(b'x' * 10)
        _stamp(old_run, self.now - 7200)
        _stamp(old_build, self.now - 7200)
        _stamp(old_cli, self.now - 7200)
        _stamp(young, self.now - 10)
        limits = diskkeep.Limits(orphan_max_age_s=3600, image_max_bytes=10**9, image_max_age_s=10**9,
                                 sketch_max_bytes=0, core_max_bytes=10**9, core_max_age_s=10**9)
        # A leaked compiler directory inside an old firmware id, plus an orphan beside it.
        leaked = self._image('d' * 16, 20, self.now, with_leak=True)
        summary = diskkeep.startup(builds=self.builds, cache_roots=[], temp_roots=[temp],
                                   limits=limits, now=self.now)
        self.assertFalse(old_run.exists())
        self.assertFalse(old_build.exists())
        self.assertFalse(old_cli.exists())
        self.assertTrue(young.exists())
        self.assertTrue(other.exists())
        self.assertTrue((leaked / 'flash.bin').is_file())
        self.assertFalse((leaked / 'out').exists())
        self.assertEqual(len(summary['orphans']), 3)


class GuardTests(unittest.TestCase):
    def test_enough_space_does_not_evict(self):
        calls = []

        def stat(_path):
            return (400 * 1024 * 1024, 8 * 1024 * 1024 * 1024)

        free = diskkeep.guard_free_space([Path('/builds')], 300 * 1024 * 1024, lambda: calls.append(1), stat=stat)
        self.assertEqual(calls, [])
        self.assertEqual(free, 400 * 1024 * 1024)

    def test_evict_then_compile_when_space_returns(self):
        state = {'free': 100 * 1024 * 1024}

        def stat(_path):
            return (state['free'], 8 * 1024 * 1024 * 1024)

        def evict():
            state['free'] = 700 * 1024 * 1024

        free = diskkeep.guard_free_space([Path('/builds')], 300 * 1024 * 1024, evict, stat=stat)
        self.assertEqual(free, 700 * 1024 * 1024)

    def test_still_low_raises_clear_error(self):
        def stat(_path):
            return (50 * 1024 * 1024, 8 * 1024 * 1024 * 1024)

        with self.assertRaises(diskkeep.LowDisk) as caught:
            diskkeep.guard_free_space([Path('/builds')], 300 * 1024 * 1024, lambda: None, stat=stat)
        message = caught.exception.message
        self.assertIn('low disk', message)
        self.assertIn('50 MB free', message)
        self.assertIn('need 300 MB', message)
        self.assertIn('Compile was not started', message)
        self.assertIn('newest compiled core archive', message)

    def test_small_tmpfs_uses_a_modest_floor(self):
        # A 64 MB tmpfs can never show 300 MB free. It must not block compiles on the big disk.
        def stat(path):
            if 'tmp' in str(path):
                return (40 * 1024 * 1024, 64 * 1024 * 1024)
            return (800 * 1024 * 1024, 8 * 1024 * 1024 * 1024)

        diskkeep.guard_free_space([Path('/tmp'), Path('/home/builds')], 300 * 1024 * 1024,
                                  lambda: self.fail('should not evict'), stat=stat)

    def test_prepare_keeps_newest_core_and_refuses_when_still_low(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        builds = root / 'builds'
        builds.mkdir()
        cache = root / 'cache'
        now = 3_000_000.0
        _entry(cache, 'sketches/leak', 200, now)
        old = _entry(cache, 'cores/old', 200, now - 100)
        new = _entry(cache, 'cores/new', 200, now - 1)
        (builds / ('a' * 16)).mkdir()
        (builds / ('a' * 16) / 'flash.bin').write_bytes(b'f' * 50)
        _stamp(builds / ('a' * 16) / 'flash.bin', now)

        def stat(_path):
            return (10 * 1024 * 1024, 8 * 1024 * 1024 * 1024)

        limits = diskkeep.Limits(min_free_bytes=300 * 1024 * 1024, image_max_bytes=0, image_max_age_s=0,
                                 sketch_max_bytes=0, sketch_max_age_s=0,
                                 core_max_bytes=10**9, core_max_age_s=10**9)
        with self.assertRaises(diskkeep.LowDisk):
            diskkeep.prepare_for_compile(builds=builds, cache_roots=[cache], temp_roots=[root],
                                         limits=limits, now=now, stat=stat)
        self.assertFalse((cache / 'sketches' / 'leak').exists())
        self.assertFalse((builds / ('a' * 16)).exists())
        self.assertFalse(old.exists())  # emergency size cap drops every core but the newest
        self.assertTrue(new.exists())


class ConfigTests(unittest.TestCase):
    def test_yaml_build_cache_path(self):
        text = """
directories:
  data: /home/sim/.arduino15
build_cache:
  compilations_before_purge: 10
  path: "/var/cache/arduino"
sketch:
  always_export_binaries: false
"""
        self.assertEqual(diskkeep.build_cache_path_from_yaml(text), '/var/cache/arduino')
        self.assertIsNone(diskkeep.build_cache_path_from_yaml('build_cache:\n  path:\n'))
        self.assertIsNone(diskkeep.build_cache_path_from_yaml('directories:\n  path: /nope\n'))

    def test_cache_roots_include_legacy_tmp_and_overrides(self):
        home = Path('/home/sim')
        tmp = Path('/tmp')
        env = {'SIM_BUILD_CACHE_DIR': '/opt/cache', 'XDG_CACHE_HOME': '/xdg'}
        roots = diskkeep.cache_roots_from_env(env, home=home, tmp=tmp, yaml_text='build_cache:\n  path: /from/yaml\n')
        self.assertEqual(roots[0], Path('/opt/cache'))
        self.assertIn(Path('/from/yaml'), roots)
        self.assertIn(Path('/xdg/arduino'), roots)
        self.assertIn(tmp / 'arduino', roots)

    def test_limits_from_env_and_fallback(self):
        limits = diskkeep.Limits.from_env({'SIM_MIN_FREE_MB': '300', 'SIM_CORE_CACHE_MAX_MB': '128',
                                           'SIM_SKETCH_CACHE_MAX_MB': '0', 'SIM_ORPHAN_MAX_AGE_S': 'nope'})
        self.assertEqual(limits.min_free_bytes, 300 * 1024 * 1024)
        self.assertEqual(limits.core_max_bytes, 128 * 1024 * 1024)
        self.assertEqual(limits.sketch_max_bytes, 0)
        self.assertEqual(limits.orphan_max_age_s, 3600)
        self.assertEqual(limits.netstack_max_bytes, 64 * 1024 * 1024)
        self.assertEqual(limits.netstack_max_age_s, 30 * 24 * 3600)

    def test_sketch_hash_matches_cli_md5(self):
        import hashlib
        with tempfile.TemporaryDirectory() as tmp:
            sketch = Path(tmp) / 'sketch'
            sketch.mkdir()
            digest = hashlib.md5(str(sketch.resolve()).encode()).hexdigest().upper()
            self.assertEqual(diskkeep.request_sketch_hash(sketch), digest)


class NetstackTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.now = 5_000_000.0

    def tearDown(self):
        self.tmp.cleanup()

    def _publish(self, key: str, size: int, payload: bytes = b'a') -> Path:
        archive = self.root / f'{key}.a'
        archive.write_bytes(payload * size)
        return diskkeep.publish_netstack(
            self.root / 'netstack', key, archive, b'["/include"]',
            {'objects': ['qemu_eth.cpp.o'], 'shim': key})

    def test_archive_survives_sketch_cleanup_orphan_sweep_and_reclaim(self):
        key = 'a' * 24
        entry = self._publish(key, 40, b'N')
        sketch = _entry(self.root / 'cache', 'sketches/THIS', 30, self.now)
        core = _entry(self.root / 'cache', 'cores/esp32', 30, self.now)
        # A temp dir that looks like an abandoned build but already holds the archive.
        held = self.root / 'tmp' / 'esp32build-hold'
        held.mkdir(parents=True)
        (held / 'libnetstack.a').write_bytes(b'kept')
        _stamp(held, self.now - 10_000)
        named = self.root / 'tmp' / 'netstack'
        named.mkdir()
        (named / 'keep.txt').write_bytes(b'k')
        _stamp(named, self.now - 10_000)
        junk = self.root / 'tmp' / 'esp32build-junk'
        junk.mkdir()
        (junk / 'flash.bin').write_bytes(b'x' * 20)
        _stamp(junk, self.now - 10_000)
        # Firmware reclaim must not treat the cache directory as a failed build.
        builds = self.root / 'builds'
        builds.mkdir()
        (builds / 'netstack').mkdir()
        (builds / 'netstack' / 'libnetstack.a').write_bytes(b'image-tree')
        failed = builds / ('b' * 16)
        failed.mkdir()
        (failed / 'out').mkdir()

        diskkeep.forget_sketch_builds_since([self.root / 'cache'], self.now - 2)
        diskkeep.evict_build_cache(
            [self.root / 'cache'], sketch_max_bytes=0, sketch_max_age_s=0,
            core_max_bytes=0, core_max_age_s=0, now=self.now, keep_newest_cores=0)
        removed = diskkeep.sweep_orphans(
            [self.root / 'tmp'], max_age_s=3600, now=self.now, prefixes=('esp32build-', 'net'))
        diskkeep.reclaim_firmware_tree(builds)
        limits = diskkeep.Limits(orphan_max_age_s=3600, image_max_bytes=10**9, image_max_age_s=10**9,
                                 sketch_max_bytes=0, core_max_bytes=0, netstack_max_bytes=10**9,
                                 netstack_max_age_s=10**9)
        diskkeep.startup(builds=builds, cache_roots=[self.root / 'cache'], temp_roots=[self.root / 'tmp'],
                         limits=limits, now=self.now, netstack_root=self.root / 'netstack')

        self.assertFalse(sketch.exists())
        self.assertFalse(core.exists())
        self.assertFalse(junk.exists())
        self.assertFalse(failed.exists())
        self.assertTrue((entry / 'libnetstack.a').is_file())
        self.assertEqual((entry / 'libnetstack.a').read_bytes(), b'N' * 40)
        self.assertTrue((held / 'libnetstack.a').is_file())
        self.assertTrue((named / 'keep.txt').is_file())
        self.assertTrue((builds / 'netstack' / 'libnetstack.a').is_file())
        self.assertNotIn(held, removed)
        self.assertNotIn(named, removed)

    def test_cap_evicts_oldest_and_keeps_newest(self):
        old_key = 'b' * 24
        new_key = 'c' * 24
        old = self._publish(old_key, 1000, b'o')
        new = self._publish(new_key, 1000, b'n')
        _stamp(old / '.last-used', self.now - 500)
        _stamp(new / '.last-used', self.now - 5)
        # Each entry is the archive plus the small sidecars. Cap fits the newer one only.
        old_size = diskkeep.dir_size(old)
        result = diskkeep.evict_netstack(
            self.root / 'netstack', max_bytes=old_size + 50, max_age_s=10_000,
            now=self.now, keep_newest=1)
        self.assertFalse(old.exists())
        self.assertTrue((new / 'libnetstack.a').is_file())
        self.assertGreaterEqual(result.freed, old_size)
        # Age drops an expired entry when nothing is protected.
        _stamp(new / '.last-used', self.now - 5000)
        diskkeep.evict_netstack(
            self.root / 'netstack', max_bytes=10**9, max_age_s=1000, now=self.now, keep_newest=0)
        self.assertFalse(new.exists())

    def test_newest_archive_survives_a_zero_cap(self):
        key = 'd' * 24
        entry = self._publish(key, 80, b'z')
        _stamp(entry / '.last-used', self.now - 10)
        diskkeep.evict_netstack(
            self.root / 'netstack', max_bytes=0, max_age_s=0, now=self.now, keep_newest=1)
        self.assertTrue((entry / 'libnetstack.a').is_file())

    def test_shim_hash_change_misses_and_root_is_not_the_legacy_tmp_cache(self):
        shim = self.root / 'QemuEth'
        (shim / 'src').mkdir(parents=True)
        (shim / 'src' / 'qemu_eth.cpp').write_text('int a = 1;\n')
        common = dict(toolchain='esp32 3.3.12|gcc| /tools/xtensa-esp32-elf-g++', core='3.3.12',
                      fqbn='esp32:esp32:esp32doit-devkit-v1', defines=('SIM',))
        first = diskkeep.source_tree_hash(shim)
        key_a = diskkeep.netstack_key(shim_hash=first, **common)
        (shim / 'src' / 'qemu_eth.cpp').write_text('int a = 2;\n')
        second = diskkeep.source_tree_hash(shim)
        key_b = diskkeep.netstack_key(shim_hash=second, **common)
        self.assertNotEqual(first, second)
        self.assertNotEqual(key_a, key_b)
        # Define order does not matter; a different define does.
        self.assertEqual(key_a, diskkeep.netstack_key(shim_hash=first, **{**common, 'defines': ('SIM',)}))
        self.assertNotEqual(key_a, diskkeep.netstack_key(shim_hash=first, **{**common, 'defines': ('SIM', 'SIM_NO_LAN_REMAP')}))
        entry = self._publish(key_a, 10, b'Q')
        self.assertEqual(diskkeep.find_netstack(self.root / 'netstack', key_a), entry)
        self.assertIsNone(diskkeep.find_netstack(self.root / 'netstack', key_b))
        root = diskkeep.netstack_root_from_env(
            {}, home=Path('/home/sim'), tmp=Path('/tmp'), yaml_text='')
        self.assertEqual(root, Path('/home/sim/.cache/arduino/netstack'))
        self.assertEqual(
            diskkeep.netstack_root_from_env({'SIM_NETSTACK_CACHE_DIR': '/var/lab/netstack'},
                                            home=Path('/home/sim'), tmp=Path('/tmp'), yaml_text=''),
            Path('/var/lab/netstack'))

    def test_cached_build_log_reports_this_request_not_the_original_duration(self):
        stored = (
            'Building network stack (first time, about 40 s)...\n'
            'Using cached network stack...\n'
            'Compiling sketch...\n'
            'Linking...\n'
            '[41.4s] compile (+QemuEth: open_eth + lwIP)\n'
        )
        text = diskkeep.cached_build_log(stored, 0.02)
        self.assertEqual(text, '[0.0s] cached (originally built in 41.4 s) (+QemuEth: open_eth + lwIP)\n')
        self.assertNotIn('[41.4s] compile', text)
        for stage in ('Building network stack', 'Using cached network stack', 'Compiling sketch', 'Linking'):
            self.assertNotIn(stage, text)
        blink = diskkeep.cached_build_log('[5.3s] compile\n', 0.004)
        self.assertEqual(blink, '[0.0s] cached (originally built in 5.3 s)\n')
        self.assertEqual(diskkeep.cached_build_log('no timing\n', 1.24), '[1.2s] cached\n')

    def test_netstack_warm_uses_the_browser_defines(self):
        js = (Path(__file__).resolve().parents[1] / 'js' / 'examples.js').read_text(encoding='utf-8')
        browser = diskkeep.defines_from_examples_js(js)
        self.assertEqual(browser, ['SIM'])
        # /api/compile sanitizes the posted list with the same function. The warm-up
        # key is that list, so a browser compile of the remote example looks up the
        # archive startup builds.
        posted = diskkeep.sanitize_defines(browser)
        self.assertEqual(posted, ['SIM'])
        self.assertEqual(
            diskkeep.sanitize_defines(['SIM', 'bad define', 3, 'SIM_SONY_HOST="h"']),
            ['SIM', 'SIM_SONY_HOST="h"'])
        common = dict(toolchain='esp32 3.3.12|gcc| /tools/xtensa-esp32-elf-g++', core='3.3.12',
                      shim_hash='abc123', fqbn='esp32:esp32:esp32doit-devkit-v1')
        lookup = diskkeep.netstack_key(**common, defines=tuple(posted))
        plan = diskkeep.plan_netstack_warm({}, js, cache_present=False, **common)
        self.assertEqual(plan['action'], 'build')
        self.assertEqual(plan['defines'], ('SIM',))
        self.assertEqual(plan['key'], lookup)
        skipped = diskkeep.plan_netstack_warm({'SIM_NETSTACK_WARM': '1'}, js, cache_present=True, **common)
        self.assertEqual(skipped['action'], 'skip')
        self.assertEqual(skipped['key'], lookup)
        off = diskkeep.plan_netstack_warm({'SIM_NETSTACK_WARM': '0'}, js, cache_present=False, **common)
        self.assertEqual(off['action'], 'off')
        self.assertIsNone(off['key'])
        self.assertTrue(diskkeep.netstack_warm_enabled({}))
        self.assertFalse(diskkeep.netstack_warm_enabled({'SIM_NETSTACK_WARM': '0'}))
        # A second user compile is 429. The startup warm-up holds the same lock, and
        # that request waits instead of answering 429.
        self.assertEqual(diskkeep.compile_gate(locked=True, queue=False, warm_running=False), 'retry')
        self.assertEqual(diskkeep.compile_gate(locked=True, queue=False, warm_running=True), 'wait')
        self.assertEqual(diskkeep.compile_gate(locked=False, queue=False, warm_running=True), 'go')
        self.assertEqual(diskkeep.compile_gate(locked=True, queue=True, warm_running=False), 'go')
        # Toolchain, core, FQBN, and the QemuEth hash still miss. SIM_NO_LAN_REMAP
        # changes qemu_eth.cpp, so user defines stay in the key.
        self.assertNotEqual(lookup, diskkeep.netstack_key(**{**common, 'toolchain': 'other'}, defines=tuple(posted)))
        self.assertNotEqual(lookup, diskkeep.netstack_key(**{**common, 'core': '9.9.9'}, defines=tuple(posted)))
        self.assertNotEqual(lookup, diskkeep.netstack_key(**{**common, 'fqbn': 'esp32:esp32:other'}, defines=tuple(posted)))
        self.assertNotEqual(lookup, diskkeep.netstack_key(**{**common, 'shim_hash': 'fff'}, defines=tuple(posted)))
        self.assertNotEqual(lookup, diskkeep.netstack_key(**common, defines=('SIM', 'SIM_NO_LAN_REMAP')))
        missing = diskkeep.plan_netstack_warm({}, 'no defines here', cache_present=False, **common)
        self.assertEqual(missing['action'], 'missing')


if __name__ == '__main__':
    unittest.main()
