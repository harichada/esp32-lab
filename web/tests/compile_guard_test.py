"""Include bypasses, define-flag smuggling, the compile sandbox, and QEMU restrict.

Runnable without a network. The dependency cases shell out to the xtensa g++ when
the ESP32 core is installed, otherwise to the host g++, and skip if neither exists.
They do not contact the live lab host.
"""
import asyncio
import contextlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

os.environ.setdefault('SIM_PREWARM', '0')
os.environ.setdefault('SIM_NETSTACK_WARM', '0')
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
try:
    import compileguard
except ImportError:
    compileguard = None
import diskkeep
import server

CANARY = 'CANARY_SECRET_CONTENT_XYZ'
HOSTILE = '/etc/hostname'


def _rejected_log(test, resp):
    """Log of a refused plan. A compiled plan (a dict) fails the test."""
    test.assertFalse(isinstance(resp, dict), 'compile was allowed')
    body = json.loads(resp.body.decode())
    test.assertFalse(body.get('ok', True))
    return body['log']


class IncludeFastTests(unittest.TestCase):
    def test_comment_include_is_outside(self):
        src = '#/**/include "/etc/hostname"\nvoid setup(){}\n'
        log = _rejected_log(self, server._compile_plan({'sketch': src, 'files': {}}))
        self.assertIn('outside the project', log)
        self.assertNotIn(HOSTILE, log)
        self.assertNotIn(CANARY, log)

    def test_line_continuation_include_is_outside(self):
        src = '#inc\\\nlude "/etc/hostname"\nvoid setup(){}\n'
        log = _rejected_log(self, server._compile_plan({'sketch': src, 'files': {}}))
        self.assertIn('outside the project', log)
        self.assertNotIn(HOSTILE, log)
        self.assertNotIn(CANARY, log)

    def test_asm_incbin_is_rejected(self):
        src = 'void f(){ asm(".incbin \\"/etc/hostname\\""); }\nvoid setup(){}\n'
        log = _rejected_log(self, server._compile_plan({'sketch': src, 'files': {}}))
        self.assertIn('.incbin', log)
        self.assertNotIn(CANARY, log)

    def test_asm_include_and_case_and_whitespace(self):
        for src in (
            'void f(){ asm(".include \\"/etc/hostname\\""); }\n',
            'void f(){ asm(".INCBIN \\"/etc/hostname\\""); }\n',
            'void f(){ asm(".inc bin \\"/etc/hostname\\""); }\n',
            'void f(){ asm(".inc\\x62in \\"/etc/hostname\\""); }\n',
        ):
            log = _rejected_log(self, server._compile_plan({'sketch': src + 'void setup(){}\n', 'files': {}}))
            self.assertIn('assembler include', log)
            self.assertNotIn(CANARY, log)

    def test_normal_sketch_passes_the_fast_checks(self):
        src = '#include <WiFi.h>\n#include "local.h"\nvoid setup(){}\nvoid loop(){}\n'
        files = {'local.h': '#pragma once\nint v;\n'}
        self.assertIsNone(server.check_sources([src, files['local.h']], set(files)))
        if compileguard is not None:
            self.assertIsNone(compileguard.fast_error(src, files))
            self.assertFalse(compileguard.needs_dependency_scan(src, files))
        plan = server._compile_plan({'sketch': src, 'files': files})
        self.assertIsInstance(plan, dict)
        self.assertIn('key', plan)

    def test_plan_rejects_macro_and_has_include(self):
        cases = [
            '#define P "/etc/hostname"\n#include P\nvoid setup(){}\n',
            '#if __has_include("/etc/hostname")\n#endif\nvoid setup(){}\n',
            '#if __has_include(</etc/hostname>)\n#endif\nvoid setup(){}\n',
            '#define P "/etc/hostname"\n#if __has_include(P)\n#endif\nvoid setup(){}\n',
        ]
        for src in cases:
            log = _rejected_log(self, server._compile_plan({'sketch': src, 'files': {}}))
            self.assertIn('outside the project', log, log)
            self.assertNotIn(HOSTILE, log)
            self.assertNotIn(CANARY, log)

    def test_remote_example_still_passes_the_fast_checks(self):
        root = Path(__file__).resolve().parents[1] / 'examples' / 'remote'
        sketch = (root / 'remote.ino').read_text(encoding='utf-8')
        header = (root / 'remote_logic.h').read_text(encoding='utf-8')
        files = {'remote_logic.h': header}
        # Core headers such as esp_sleep.h are allow-listed only when the ESP32
        # core is installed. Either way the example must not look like an escape.
        err = server.check_sources([sketch, header], set(files))
        if err:
            self.assertTrue(err.startswith('include not in allowlist'), err)
        if compileguard is None:
            return
        self.assertIsNone(compileguard.fast_error(sketch, files))
        self.assertFalse(compileguard.needs_dependency_scan(sketch, files))
        compiler = compileguard.find_preprocessor()
        if compiler:
            with tempfile.TemporaryDirectory(prefix='esp32sk-') as tmp:
                sketch_dir = Path(tmp) / 'sketch'
                sketch_dir.mkdir()
                (sketch_dir / 'sketch.ino').write_text(sketch)
                (sketch_dir / 'remote_logic.h').write_text(header)
                err = compileguard.scan_sketch_dir(sketch_dir, compiler=compiler, sandbox=False)
            self.assertIsNone(err, err)


class DependencyScanTests(unittest.TestCase):
    def setUp(self):
        if compileguard is None:
            self.skipTest('compileguard missing')
        self.compiler = compileguard.find_preprocessor()
        if not self.compiler:
            self.skipTest('no C preprocessor')

    def _deps(self, src, files=None):
        return compileguard.dependency_paths(src, files or {}, compiler=self.compiler, sandbox=False)

    def test_real_preprocessor_lists_the_bypasses(self):
        cases = {
            'comment': '#/**/include "/etc/hostname"\n',
            'cont': '#inc\\\nlude "/etc/hostname"\n',
            'macro': '#define P "/etc/hostname"\n#include P\n',
            'has': '#if __has_include("/etc/hostname")\nint x;\n#endif\n',
            'hasang': '#if __has_include(</etc/hostname>)\nint x;\n#endif\n',
            'hasmacro': '#define P "/etc/hostname"\n#if __has_include(P)\nint x;\n#endif\n',
        }
        for name, src in cases.items():
            deps = self._deps(src)
            self.assertTrue(any(path == HOSTILE for path in deps), (name, deps))

    def test_macro_include_message_names_the_path_not_the_contents(self):
        secret = Path(tempfile.mkdtemp(prefix='esp32sec-'))
        try:
            target = secret / 'secret.txt'
            target.write_text(CANARY + '\n')
            src = '#define P "%s"\n#include P\nvoid setup(){}\n' % target
            err = compileguard.audit_texts(src, {}, compiler=self.compiler, sandbox=False)
            self.assertIsNotNone(err)
            self.assertIn('outside the project', err)
            self.assertNotIn(str(target), err)
            self.assertNotIn(CANARY, err)
        finally:
            shutil.rmtree(secret, ignore_errors=True)

    def test_normal_library_and_local_header_pass_the_scan(self):
        src = '#include <WiFi.h>\n#include "local.h"\nvoid setup(){}\nvoid loop(){}\n'
        files = {'local.h': '#pragma once\nint v;\n'}
        with tempfile.TemporaryDirectory(prefix='esp32sk-') as tmp:
            sketch = Path(tmp) / 'sketch'
            sketch.mkdir()
            (sketch / 'sketch.ino').write_text(src)
            (sketch / 'local.h').write_text(files['local.h'])
            err = compileguard.scan_sketch_dir(sketch, compiler=self.compiler, sandbox=False)
        self.assertIsNone(err, err)

    def test_blink_scan_passes(self):
        with tempfile.TemporaryDirectory(prefix='esp32sk-') as tmp:
            sketch = Path(tmp) / 'sketch'
            sketch.mkdir()
            (sketch / 'sketch.ino').write_text('void setup(){}\nvoid loop(){}\n')
            err = compileguard.scan_sketch_dir(sketch, compiler=self.compiler, sandbox=False)
        self.assertIsNone(err, err)

    def test_symlink_escape_is_outside(self):
        secret = Path(tempfile.mkdtemp(prefix='esp32link-'))
        try:
            target = secret / 'secret.txt'
            target.write_text(CANARY + '\n')
            with tempfile.TemporaryDirectory(prefix='esp32sk-') as tmp:
                sketch = Path(tmp) / 'sketch'
                sketch.mkdir()
                (sketch / 'sketch.ino').write_text('#include "evil.h"\nvoid setup(){}\n')
                os.symlink(target, sketch / 'evil.h')
                err = compileguard.scan_sketch_dir(sketch, compiler=self.compiler, sandbox=False, roots=[sketch])
            self.assertIsNotNone(err)
            self.assertIn('outside the project', err)
            self.assertNotIn(CANARY, err)
        finally:
            shutil.rmtree(secret, ignore_errors=True)

    def test_quoted_define_include_is_scanned(self):
        """An accepted quoted address used as #include still hits the dependency scan.

        ``SIM_X="<x>"`` is not a legal Defines value, so it never becomes a ``-D``.
        A hostname that resolves outside the sketch is refused by the same scan.
        """
        secret = Path(tempfile.mkdtemp(prefix='esp32host-'))
        try:
            target = secret / 'secret.txt'
            target.write_text(CANARY + '\n')
            with tempfile.TemporaryDirectory(prefix='esp32sk-') as tmp:
                sketch = Path(tmp) / 'sketch'
                sketch.mkdir()
                (sketch / 'sketch.ino').write_text('#include SIM_X\nvoid setup(){}\n')
                os.symlink(target, sketch / 'hostname')
                err = compileguard.scan_sketch_dir(
                    sketch, compiler=self.compiler, defines=['SIM_X="hostname"'],
                    sandbox=False, roots=[sketch])
            self.assertIsNotNone(err)
            self.assertIn('outside the project', err)
            self.assertNotIn(CANARY, err)
            deps = compileguard.dependency_paths(
                '#include SIM_X\n', compiler=self.compiler, sandbox=False,
                defines=['SIM_X="hostname"'])
            self.assertTrue(deps)
        finally:
            shutil.rmtree(secret, ignore_errors=True)
        self.assertFalse(diskkeep.quoted_define_ok('SIM_X="<x>"'))
        self.assertFalse(diskkeep.flags_are_safe(['SIM_X="<x>"']))
        # The angle-bracket shape is dropped before gcc, so it cannot open a file.
        self.assertEqual(compileguard._define_args(['SIM_X="<x>"', 'SIM_X="hostname"']),
                         ['-DSIM_X="hostname"'])

    def test_macro_asm_is_caught_in_the_preprocessed_output(self):
        src = '#define A ".inc"\n#define B "bin \\"/etc/hostname\\""\nvoid f(){ asm(A B); }\nvoid setup(){}\n'
        err = compileguard.audit_texts(src, {}, compiler=self.compiler, sandbox=False)
        self.assertIsNotNone(err)
        self.assertIn('assembler include', err)
        self.assertNotIn(CANARY, err)

    def test_split_asm_across_a_local_header(self):
        src = '#include "hid.h"\nvoid f(){ asm(A B); }\nvoid setup(){}\n'
        files = {'hid.h': '#define A ".inc"\n#define B "bin \\"/etc/hostname\\""\n'}
        err = compileguard.audit_texts(src, files, compiler=self.compiler, sandbox=False)
        self.assertIsNotNone(err)
        self.assertIn('assembler include', err)


class DefineFlagTests(unittest.TestCase):
    def test_flags_and_quotes_are_rejected(self):
        samples = [
            '-I/etc',
            '-I',
            '/etc/hostname',
            '-include /etc/hostname',
            '-iquote /tmp/x',
            '-isystem /tmp/x',
            '-imacros /etc/hostname',
            '--sysroot=/',
            '-B/tmp',
            '-specs=evil.specs',
            '@/tmp/rsp',
            'FOO="-I/etc"',
            'P="/etc/hostname"',
            '-isysroot /tmp',
            '--include /etc/hostname',
            'FOO=1 -I/etc',
        ]
        for raw in samples:
            log = _rejected_log(self, server._compile_plan(
                {'sketch': 'void setup(){}\nvoid loop(){}\n', 'defines': [raw]}))
            self.assertIn('Defines box', log, raw)
            self.assertNotIn(CANARY, log)
            self.assertNotIn(HOSTILE, log, raw)

    def test_build_opt_and_build_properties_are_rejected(self):
        log = _rejected_log(self, server._compile_plan({
            'sketch': 'void setup(){}\n',
            'files': {'build_opt.h': '-include /etc/hostname\n'},
        }))
        self.assertIn('Defines box', log)
        self.assertNotIn(HOSTILE, log)
        log = _rejected_log(self, server._compile_plan({
            'sketch': 'void setup(){}\n',
            'build_properties': ['compiler.cpp.extra_flags=-I/etc'],
        }))
        self.assertIn('Defines box', log)

    def test_quoted_addresses_pass_as_one_recipe_token(self):
        ip = 'SIM_SONY_HOST="192.168.1.50"'
        host = 'SIM_SONY_HOST="host.sim.internal"'
        port = 'SIM_ROKU_HOST="host.sim.internal:8080"'
        wide = 'H="' + ('a' * 64) + '"'
        for raw in (ip, host, port, wide, 'SIM_SONY_HOST="h"'):
            self.assertTrue(diskkeep.quoted_define_ok(raw), raw)
            self.assertFalse(diskkeep.define_is_dangerous(raw), raw)
            self.assertIsNone(diskkeep.blocked_define_reason([raw]))
        kept = diskkeep.sanitize_defines(['SIM', 'bad define', ip, host])
        self.assertEqual(kept, ['SIM', ip, host])
        plan = server._compile_plan({
            'sketch': 'void setup(){}\nvoid loop(){}\n',
            'defines': ['SIM', ip, host],
        })
        self.assertIsInstance(plan, dict)
        self.assertEqual(plan['defines'], ['SIM', ip, host])
        # arduino-cli SplitQuotedString keeps a quote that is not the first
        # character of a token, so the address reaches gcc as one argument.
        self.assertEqual(
            diskkeep.split_quoted_string("""This 'is an' "Hello World!" example""", "'\"", False),
            ['This', 'is an', 'Hello World!', 'example'])
        args = diskkeep.recipe_define_args(['SIM', ip, host])
        self.assertEqual(args, ['-DSIM', '-D' + ip, '-D' + host])
        self.assertEqual(len(args), 3)
        self.assertIn('"192.168.1.50"', args[1])

    def test_bad_quoted_defines_are_rejected(self):
        samples = [
            'HOST="a b"',
            'HOST="a/b"',
            'HOST="-Ietc"',
            'HOST="-I/etc"',
            'HOST="x\\"y"',
            "HOST='single'",
            "'single'",
            'HOST="abc',
            'HOST=abc"',
            'HOST=""',
            'HOST=""abc""',
            'H="' + ('a' * 65) + '"',
            'SIM_X="<x>"',
            'SIM_X="<hostname>"',
        ]
        for raw in samples:
            self.assertFalse(diskkeep.quoted_define_ok(raw), raw)
            self.assertTrue(diskkeep.define_is_dangerous(raw), raw)
            log = _rejected_log(self, server._compile_plan(
                {'sketch': 'void setup(){}\nvoid loop(){}\n', 'defines': [raw]}))
            self.assertIn('Defines box', log, raw)
            self.assertNotIn(raw, log, raw)
            self.assertNotIn(CANARY, log)

    def test_rejection_line_names_the_reason_not_the_sketch(self):
        marker = 'SKETCH_MARKER_zz91'
        sketch = 'void setup(){ ' + marker + ' }\nvoid loop(){}\n'
        good = 'SIM_SONY_HOST="192.168.1.50"'
        bad = 'BAD="/etc/passwd"'
        buf = io.StringIO()
        token = server._reject_client.set('learner-1')
        try:
            with contextlib.redirect_stdout(buf):
                log = _rejected_log(self, server._compile_plan(
                    {'sketch': sketch, 'defines': [good, bad]}))
        finally:
            server._reject_client.reset(token)
        logged = buf.getvalue()
        self.assertIn('reason=flag', logged)
        self.assertIn('client=learner-1', logged)
        self.assertNotIn(marker, logged)
        self.assertNotIn(good, logged)
        self.assertNotIn(bad, logged)
        self.assertNotIn('192.168.1.50', logged)
        self.assertNotIn('/etc/passwd', logged)
        self.assertIn('Defines box', log)
        self.assertNotIn(marker, log)
        outside = '#include SIM_X\nvoid setup(){ ' + marker + ' }\n'
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            log = _rejected_log(self, server._compile_plan(
                {'sketch': outside, 'defines': ['SIM_X=".."']}))
        logged = buf.getvalue()
        self.assertIn('reason=outside', logged)
        self.assertIn('client=anon', logged)
        self.assertNotIn(marker, logged)
        self.assertNotIn('SIM_X=".."', logged)
        self.assertIn('outside the project', log)

    def test_plain_defines_still_pass(self):
        self.assertEqual(diskkeep.sanitize_defines(['SIM', 'SIM_NO_LAN_REMAP', 'LEVEL=3']),
                         ['SIM', 'SIM_NO_LAN_REMAP', 'LEVEL=3'])
        if hasattr(diskkeep, 'blocked_define_reason'):
            self.assertIsNone(diskkeep.blocked_define_reason(['SIM', 'FEATURE=1']))
            self.assertTrue(diskkeep.flags_are_safe(['SIM', 'FEATURE=1']))
            js = (Path(__file__).resolve().parents[1] / 'js' / 'examples.js').read_text(encoding='utf-8')
            self.assertEqual(diskkeep.defines_from_examples_js(js), ['SIM'])

    def test_sandbox_flag_does_not_change_the_cache_key(self):
        body = {'sketch': 'void setup(){}\nvoid loop(){}\n', 'files': {}}
        saved = os.environ.get('SIM_COMPILE_SANDBOX')
        try:
            os.environ['SIM_COMPILE_SANDBOX'] = '1'
            first = server._compile_plan(body)
            os.environ['SIM_COMPILE_SANDBOX'] = 'off'
            second = server._compile_plan(body)
        finally:
            if saved is None:
                os.environ.pop('SIM_COMPILE_SANDBOX', None)
            else:
                os.environ['SIM_COMPILE_SANDBOX'] = saved
        self.assertIsInstance(first, dict)
        self.assertEqual(first['key'], second['key'])


class SandboxTests(unittest.TestCase):
    def setUp(self):
        if compileguard is None:
            self.skipTest('compileguard missing')
        self._override = compileguard._backend_override
        self._saved = os.environ.get('SIM_COMPILE_SANDBOX')
        self._alias = os.environ.get('SIM_SANDBOX')

    def tearDown(self):
        compileguard._backend_override = self._override
        if self._saved is None:
            os.environ.pop('SIM_COMPILE_SANDBOX', None)
        else:
            os.environ['SIM_COMPILE_SANDBOX'] = self._saved
        if self._alias is None:
            os.environ.pop('SIM_SANDBOX', None)
        else:
            os.environ['SIM_SANDBOX'] = self._alias

    def test_flag_off_is_the_old_command(self):
        os.environ['SIM_COMPILE_SANDBOX'] = 'off'
        compileguard._backend_override = None
        work = Path(tempfile.mkdtemp(prefix='esp32box-'))
        try:
            argv, err = compileguard.wrap_command(['arduino-cli', 'compile', 'sketch'], work=work)
        finally:
            shutil.rmtree(work, ignore_errors=True)
        self.assertIsNone(err)
        self.assertEqual(argv, ['arduino-cli', 'compile', 'sketch'])

    def test_missing_sandbox_refuses(self):
        os.environ['SIM_COMPILE_SANDBOX'] = '1'
        compileguard._backend_override = 'missing'
        work = Path(tempfile.mkdtemp(prefix='esp32box-'))
        try:
            argv, err = compileguard.wrap_command(['arduino-cli', 'compile'], work=work, read_write=[work])
        finally:
            shutil.rmtree(work, ignore_errors=True)
        self.assertIsNone(argv)
        self.assertEqual(err, compileguard.SANDBOX_MSG)
        self.assertIn("wasn't the cause", err)
        self.assertNotIn('#include lines', err)
        self.assertNotIn('bwrap', err)
        self.assertNotIn('probe', err)
        self.assertNotIn('backend', err)
        line = compileguard.startup_sandbox_error()
        self.assertIsNotNone(line)
        self.assertTrue(line.startswith('error: compile sandbox unavailable:'))
        self.assertIn('backend=missing', line)
        self.assertIn('probe=absent', line)
        self.assertNotIn(compileguard.SANDBOX_MSG, line)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            resp = server._reject(compileguard.SANDBOX_MSG)
        logged = buf.getvalue()
        self.assertIn('reason=infra', logged)
        self.assertNotIn('reason=sandbox', logged)
        self.assertNotIn('reason=scan', logged)
        self.assertIn('client=anon', logged)
        self.assertIn('backend=missing', logged)
        self.assertNotIn('void setup', logged)
        body = json.loads(resp.body.decode())
        self.assertEqual(body['reason'], 'infra')
        self.assertEqual(body['log'], compileguard.SANDBOX_MSG)
        self.assertNotIn('backend', body['log'])
        self.assertNotIn('probe', body['log'])
        # A compile while the sandbox is unavailable is the same sentence and reason=infra.
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            log = _rejected_log(self, server._compile_plan({
                'sketch': '#include SIM_X\nvoid setup(){}\n',
                'files': {},
                'defines': ['SIM_X="hostname"'],
            }))
        self.assertEqual(log, compileguard.SANDBOX_MSG)
        self.assertNotIn('#include lines', log)
        compile_log = buf.getvalue()
        self.assertIn('reason=infra', compile_log)
        self.assertNotIn('reason=sandbox', compile_log)
        self.assertNotIn('reason=scan', compile_log)

    def test_bwrap_argv_hides_host_files_and_keeps_the_work_dir(self):
        compileguard._backend_override = 'bwrap'
        os.environ['SIM_COMPILE_SANDBOX'] = '1'
        work = Path(tempfile.mkdtemp(prefix='esp32box-'))
        try:
            argv = compileguard.bwrap_argv(
                ['arduino-cli', 'compile'], work=work, read_only=[], read_write=[work])
        finally:
            shutil.rmtree(work, ignore_errors=True)
        self.assertEqual(argv[0], 'bwrap')
        self.assertIn('--unshare-net', argv)
        self.assertIn('--ro-bind', argv)
        self.assertIn('--bind', argv)
        joined = '\n'.join(argv)
        self.assertNotIn('/etc/hostname', joined)
        self.assertNotIn('--proc', argv)
        self.assertNotIn('/proc', argv)
        self.assertNotIn('--bind / /', ' '.join(argv))
        self.assertNotIn('--ro-bind / /', ' '.join(argv))
        # The work directory is read-write at the same absolute path, and the
        # tmpfs is mounted before that bind so a work dir under /tmp stays visible.
        self.assertIn(str(work), argv)
        self.assertLess(argv.index('--tmpfs'), argv.index(str(work)))

    def test_readonly_under_tmp_stays_visible(self):
        """A read-only tree under the temp dir is bound after --tmpfs /tmp."""
        if not shutil.which('bwrap'):
            self.skipTest('bwrap is not on PATH')
        root = Path(tempfile.mkdtemp(prefix='esp32ro-'))
        marker = root / 'marker.txt'
        marker.write_text('ro-visible\n')
        work = Path(tempfile.mkdtemp(prefix='esp32work-'))
        try:
            code = 'print(open(%r).read().strip())' % str(marker)
            argv = compileguard.bwrap_argv(
                [sys.executable, '-c', code], work=work, read_only=[root], read_write=[work])
            self.assertLess(argv.index('--tmpfs'), argv.index(str(root)))
            proc = subprocess.run(
                argv, capture_output=True, text=True, timeout=20,
                env=compileguard.host_sandbox_env())
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
            self.assertIn('ro-visible', proc.stdout)
        finally:
            shutil.rmtree(root, ignore_errors=True)
            shutil.rmtree(work, ignore_errors=True)

    def test_startup_probe_is_the_compile_argv(self):
        built = compileguard._probe_argv()
        self.assertIsNotNone(built)
        wrapped, work = built
        try:
            commands = compileguard._probe_commands(work)
            ro = compileguard._ro_for(work)
            rw = compileguard._rw_for(work)
            self.assertEqual(len(wrapped), 2)
            flags = []
            for (argv, _same), cmd in zip(wrapped, commands):
                again = compileguard.bwrap_argv(cmd, work=work, read_only=ro, read_write=rw)
                self.assertEqual(argv, again)
                self.assertNotIn('--proc', argv)
                self.assertNotIn('/proc', argv)
                flags.append(cmd[cmd.index('-E') if '-E' in cmd else cmd.index('-c')])
            self.assertEqual(flags, ['-E', '-c'])
        finally:
            shutil.rmtree(work, ignore_errors=True)

    def test_host_sandbox_env_keeps_only_path_lang_and_library_path(self):
        saved = {key: os.environ.get(key) for key in (
            'PATH', 'LANG', 'LD_LIBRARY_PATH', 'SIM_TOKEN', 'SIM_ACCESS_TOKEN', 'SIM_PROC_CANARY')}
        os.environ['PATH'] = os.environ.get('PATH') or '/usr/bin'
        os.environ['LANG'] = 'C'
        os.environ['LD_LIBRARY_PATH'] = '/evil'
        os.environ['SIM_TOKEN'] = 'token-secret-value'
        os.environ['SIM_ACCESS_TOKEN'] = 'access-secret-value'
        os.environ['SIM_PROC_CANARY'] = 'CANARY_ENV_PROC_991'
        try:
            got = compileguard.host_sandbox_env()
            self.assertEqual(set(got), {'PATH', 'LANG', 'LD_LIBRARY_PATH'})
            self.assertEqual(got['PATH'], os.environ['PATH'])
            self.assertEqual(got['LANG'], 'C')
            self.assertEqual(got['LD_LIBRARY_PATH'], '/evil')
            lib = compileguard.dynconfig_library_dir()
            if lib:
                self.assertNotIn(lib, got['LD_LIBRARY_PATH'])
            blob = '\n'.join(f'{key}={value}' for key, value in got.items())
            self.assertNotIn('token-secret-value', blob)
            self.assertNotIn('access-secret-value', blob)
            self.assertNotIn('CANARY_ENV_PROC_991', blob)
            self.assertNotIn('SIM_TOKEN', blob)
            self.assertNotIn('SIM_ACCESS_TOKEN', blob)
        finally:
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

    def test_bwrap_process_environ_hides_server_secrets(self):
        if not shutil.which('bwrap'):
            self.skipTest('bwrap (bubblewrap) is not on PATH')
        saved = {key: os.environ.get(key) for key in (
            'PATH', 'LANG', 'LD_LIBRARY_PATH', 'SIM_TOKEN', 'SIM_ACCESS_TOKEN', 'SIM_PROC_CANARY')}
        os.environ['PATH'] = os.environ.get('PATH') or '/usr/bin'
        os.environ['LANG'] = os.environ.get('LANG') or 'C'
        os.environ['LD_LIBRARY_PATH'] = '/evil'
        os.environ['SIM_TOKEN'] = 'token-secret-value'
        os.environ['SIM_ACCESS_TOKEN'] = 'access-secret-value'
        os.environ['SIM_PROC_CANARY'] = 'CANARY_ENV_PROC_991'
        work = Path(tempfile.mkdtemp(prefix='esp32env-'))
        marker = work / 'ldpath'
        proc = None
        try:
            argv = compileguard.bwrap_argv(
                ['/bin/sh', '-c', 'printf %s "$LD_LIBRARY_PATH" > "$1"; sleep 2', 'sh', str(marker)],
                work=work, read_only=compileguard._ro_for(work), read_write=compileguard._rw_for(work))
            proc = subprocess.Popen(argv, env=compileguard.host_sandbox_env(), stderr=subprocess.PIPE)
            host = Path('/proc') / str(proc.pid) / 'environ'
            deadline = time.time() + 1.5
            raw = b''
            while time.time() < deadline:
                try:
                    raw = host.read_bytes()
                    break
                except FileNotFoundError:
                    time.sleep(0.05)
            self.assertTrue(raw, 'bwrap exited before /proc/<pid>/environ could be read')
            text = raw.decode('utf-8', 'replace')
            self.assertNotIn('token-secret-value', text)
            self.assertNotIn('access-secret-value', text)
            self.assertNotIn('CANARY_ENV_PROC_991', text)
            self.assertNotIn('SIM_TOKEN', text)
            self.assertNotIn('SIM_ACCESS_TOKEN', text)
            pairs = {}
            for item in raw.split(b'\0'):
                if not item or b'=' not in item:
                    continue
                key, value = item.split(b'=', 1)
                pairs[key.decode()] = value.decode()
            self.assertEqual(set(pairs), {'PATH', 'LANG', 'LD_LIBRARY_PATH'})
            self.assertEqual(pairs['LD_LIBRARY_PATH'], '/evil')
            lib = compileguard.dynconfig_library_dir()
            if lib:
                self.assertNotIn(lib, pairs['LD_LIBRARY_PATH'])
            inside = ''
            deadline = time.time() + 1.5
            while time.time() < deadline and not marker.is_file():
                time.sleep(0.05)
            self.assertTrue(marker.is_file(), 'sandbox did not report LD_LIBRARY_PATH')
            inside = marker.read_text()
            self.assertEqual(inside, lib or '')
            if lib:
                self.assertNotIn(os.pathsep, inside)
                self.assertNotIn('/evil', inside)
        finally:
            if proc is not None:
                try:
                    if proc.poll() is None:
                        proc.wait(timeout=5)
                    else:
                        proc.wait(timeout=5)
                finally:
                    if proc.stderr is not None:
                        proc.stderr.close()
            shutil.rmtree(work, ignore_errors=True)
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

    def test_real_bwrap_cannot_read_hostname(self):
        if not shutil.which('bwrap') or not compileguard.bwrap_works():
            self.skipTest('bwrap unavailable')
        compileguard._backend_override = None
        os.environ['SIM_COMPILE_SANDBOX'] = '1'
        work = Path(tempfile.mkdtemp(prefix='esp32box-'))
        try:
            argv, err = compileguard.wrap_command(
                ['/bin/sh', '-c', 'test ! -e /etc/hostname && test ! -e /etc/hosts'],
                work=work, read_only=[], read_write=[work])
            self.assertIsNone(err, err)
            proc = subprocess.run(argv, capture_output=True, text=True, timeout=20,
                                  env=compileguard.host_sandbox_env())
            self.assertEqual(proc.returncode, 0, proc.stderr[-400:])
        finally:
            shutil.rmtree(work, ignore_errors=True)

    def test_sandboxed_scan_rejects_without_echoing_the_file(self):
        if not shutil.which('bwrap') or not compileguard.bwrap_works():
            self.skipTest('bwrap unavailable')
        compiler = compileguard.find_preprocessor()
        if not compiler:
            self.skipTest('no C preprocessor')
        secret = Path(tempfile.mkdtemp(prefix='esp32sec-'))
        try:
            target = secret / 'secret.txt'
            target.write_text(CANARY + '\n')
            src = '#define P "%s"\n#include P\nvoid setup(){}\n' % target
            err = compileguard.audit_texts(src, {}, compiler=compiler, sandbox=True)
            self.assertIsNotNone(err)
            self.assertIn('outside the project', err)
            self.assertNotIn(CANARY, err)
        finally:
            shutil.rmtree(secret, ignore_errors=True)


class QemuNetTests(unittest.TestCase):
    def _forwards(self):
        return [
            f'guestfwd=tcp:10.0.2.100:{port}-cmd:/usr/bin/python3 /opt/relay.py /tmp/http{port}.sock'
            for port in (8080, 8060, 80)
        ]

    def test_restrict_on_keeps_only_the_guestfwd(self):
        if not hasattr(server, 'lwip_nic_args'):
            self.fail('qemu user-net is not restricted')
        fw = self._forwards()
        args = server.lwip_nic_args(
            fw, '/run/qemu.dgram', '/run/srv.dgram', env={'SIM_QEMU_NET_RESTRICT': '1'})
        text = ' '.join(args)
        self.assertIn('restrict=on', text)
        self.assertNotIn('hostfwd', text)
        self.assertNotIn('127.0.0.1', text)
        user = next(part for part in args if part.startswith('user'))
        pieces = user.split(',')
        forwards = [piece for piece in pieces if 'fwd' in piece]
        self.assertEqual(forwards, fw)
        for piece in forwards:
            self.assertRegex(piece, r'^guestfwd=tcp:10\.0\.2\.100:(8080|8060|80)-cmd:')
        self.assertIn(
            'dgram,id=tap0,local.type=unix,local.path=/run/qemu.dgram,remote.type=unix,remote.path=/run/srv.dgram',
            args)
        self.assertIn('hubport,id=tap0hub,hubid=0,netdev=tap0', args)

    def test_flag_off_is_the_old_user_net(self):
        if not hasattr(server, 'user_net_arg'):
            self.fail('qemu user-net is not restricted')
        fw = self._forwards()
        old = 'user,' + ','.join(fw)
        self.assertEqual(server.user_net_arg(fw, env={'SIM_QEMU_NET_RESTRICT': '0'}), old)
        args = server.lwip_nic_args(fw, '/run/qemu.dgram', '/run/srv.dgram', env={'SIM_QEMU_NET_RESTRICT': '0'})
        self.assertNotIn('restrict', ' '.join(args))
        self.assertNotIn('hostfwd', ' '.join(args))


class LibraryAndDirectiveTests(unittest.TestCase):
    def _message(self, header):
        err = 'include not in allowlist: ' + header
        return compileguard.present_include_error(err)

    def test_unknown_library_names_and_rejects_unsafe_text(self):
        normal = self._message('NotARealLib.h')
        self.assertIn('NotARealLib.h', normal)
        self.assertNotIn('this library', normal)
        self.assertEqual(compileguard.reason_code(normal), 'unknown_library')
        self.assertEqual(compileguard.library_log_from_message(normal), 'NotARealLib.h')
        shown = self._message('vendor/Foo.h')
        self.assertIn('Foo.h', shown)
        self.assertNotIn('vendor/', shown)
        long_name = 'A' * 65
        for header in (
            'bad<name>.h',
            'bad\nname.h',
            'bad\tname.h',
            'bad name.h',
            'bad$name.h',
            long_name,
        ):
            msg = self._message(header)
            self.assertIn('this library', msg, repr(header))
            self.assertNotIn(header, msg, repr(header))
            self.assertNotIn(long_name[:64], msg) if header == long_name else None
            self.assertEqual(compileguard.library_log_from_message(msg), 'invalid', repr(header))
        plan_msg = _rejected_log(self, server._compile_plan(
            {'sketch': '#include "NotARealLib.h"\nvoid setup(){}\n', 'files': {}}))
        self.assertIn("doesn't have a library called NotARealLib.h", plan_msg)
        for src in (
            '#include "bad name.h"\nvoid setup(){}\n',
            '#include "bad$name.h"\nvoid setup(){}\n',
            '#include "' + long_name + '"\nvoid setup(){}\n',
        ):
            log = _rejected_log(self, server._compile_plan({'sketch': src, 'files': {}}))
            self.assertIn('this library', log)
            self.assertNotIn(long_name, log)

    def test_unknown_library_log_line_hides_the_sketch(self):
        marker = 'SKETCH_MARKER_lib77'
        buf = io.StringIO()
        token = server._reject_client.set('learner-lib')
        try:
            with contextlib.redirect_stdout(buf):
                log = _rejected_log(self, server._compile_plan(
                    {'sketch': '#include "bad<name>.h"\nvoid setup(){ ' + marker + ' }\n', 'files': {}}))
        finally:
            server._reject_client.reset(token)
        logged = buf.getvalue()
        # The angle bracket never reaches the allow-list parser, so this shape is unsupported.
        # The library sentence itself is what must stay free of the raw name.
        raw = 'bad<name>.h'
        msg = compileguard.library_message(raw)
        self.assertIn('this library', msg)
        self.assertNotIn('<', msg)
        code_buf = io.StringIO()
        with contextlib.redirect_stdout(code_buf):
            server._reject(msg)
        line = code_buf.getvalue()
        self.assertIn('reason=unknown_library', line)
        self.assertIn('lib=invalid', line)
        self.assertNotIn(raw, line)
        self.assertNotIn(marker, line)
        self.assertNotIn(marker, logged)

    def test_include_next_and_import_are_unsupported_not_asm(self):
        for src, needle in (
            ('#include_next <WiFi.h>\nvoid setup(){}\n', 'include_next'),
            ('#import "WiFi.h"\nvoid setup(){}\n', 'import'),
        ):
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                log = _rejected_log(self, server._compile_plan({'sketch': src, 'files': {}}))
            self.assertIn("this builder can't check", log)
            self.assertNotIn('assembler', log)
            self.assertNotIn('incbin', log.lower())
            self.assertIn('reason=unsupported', buf.getvalue())
            self.assertNotIn(needle, log)
        asm = _rejected_log(self, server._compile_plan(
            {'sketch': 'void f(){ asm(".incbin \\"/etc/hostname\\""); }\nvoid setup(){}\n', 'files': {}}))
        self.assertIn('assembler include', asm)
        self.assertNotIn(HOSTILE, asm)

    def test_scan_fault_is_a_server_problem_not_the_sketch(self):
        previous = os.environ.get('SIM_COMPILE_SANDBOX')
        os.environ['SIM_COMPILE_SANDBOX'] = 'off'
        compileguard._scan_fault = 'injected'
        marker = 'SKETCH_MARKER_scan88'
        try:
            buf = io.StringIO()
            token = server._reject_client.set('learner-scan')
            try:
                with contextlib.redirect_stdout(buf):
                    log = _rejected_log(self, server._compile_plan({
                        'sketch': '#include SIM_X\nvoid setup(){ ' + marker + ' }\n',
                        'files': {},
                        'defines': ['SIM_X="hostname"'],
                    }))
            finally:
                server._reject_client.reset(token)
        finally:
            compileguard._scan_fault = None
            if previous is None:
                os.environ.pop('SIM_COMPILE_SANDBOX', None)
            else:
                os.environ['SIM_COMPILE_SANDBOX'] = previous
        self.assertEqual(log, compileguard.SANDBOX_MSG)
        self.assertNotIn('#include lines', log)
        logged = buf.getvalue()
        self.assertIn('reason=infra', logged)
        self.assertNotIn('reason=sandbox', logged)
        self.assertNotIn('reason=scan', logged)
        self.assertIn('client=learner-scan', logged)
        self.assertNotIn(marker, logged)
        self.assertNotIn('hostname', logged)
        self.assertNotIn('SIM_X', logged)

    def test_bwrap_mount_error_is_sandbox_not_scan(self):
        previous = os.environ.get('SIM_COMPILE_SANDBOX')
        os.environ['SIM_COMPILE_SANDBOX'] = 'off'
        real_run = subprocess.run

        def mount_fail(argv, *args, **kwargs):
            if '-M' in argv:
                return subprocess.CompletedProcess(
                    argv, 1, '', "bwrap: Can't mount proc on /proc: Operation not permitted")
            return real_run(argv, *args, **kwargs)

        marker = 'SKETCH_MARKER_mount'
        subprocess.run = mount_fail
        try:
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                log = _rejected_log(self, server._compile_plan({
                    'sketch': '#include SIM_X\nvoid setup(){ ' + marker + ' }\n',
                    'files': {},
                    'defines': ['SIM_X="hostname"'],
                }))
        finally:
            subprocess.run = real_run
            if previous is None:
                os.environ.pop('SIM_COMPILE_SANDBOX', None)
            else:
                os.environ['SIM_COMPILE_SANDBOX'] = previous
        self.assertEqual(log, compileguard.SANDBOX_MSG)
        self.assertNotIn('#include lines', log)
        self.assertNotIn(marker, log)
        self.assertIn('reason=infra', buf.getvalue())
        self.assertNotIn('reason=sandbox', buf.getvalue())
        self.assertNotIn('reason=scan', buf.getvalue())

    def test_missing_file_naming_an_outside_path_is_outside(self):
        """A compiler that only says 'No such file' for an absolute path is reason=outside.

        The sketch itself spells a relative name, so this is the diagnostic, not the textual check.
        """
        previous = os.environ.get('SIM_COMPILE_SANDBOX')
        os.environ['SIM_COMPILE_SANDBOX'] = '1'
        compileguard._backend_override = 'bwrap'
        real_run = subprocess.run
        named = {'path': '/etc/hostname'}

        def missing(argv, *args, **kwargs):
            if '-M' in argv:
                return subprocess.CompletedProcess(
                    argv, 1, '',
                    'unit.cpp:1:10: fatal error: %s: No such file or directory' % named['path'])
            return real_run(argv, *args, **kwargs)

        subprocess.run = missing
        try:
            for path in ('/etc/hostname', '/proc/self/environ', '/proc/1/environ', '/proc/1/cmdline', '..'):
                named['path'] = path
                buf = io.StringIO()
                with contextlib.redirect_stdout(buf):
                    log = _rejected_log(self, server._compile_plan({
                        'sketch': '#include SIM_X\nvoid setup(){}\n',
                        'files': {},
                        'defines': ['SIM_X="hostname"'],
                    }))
                self.assertEqual(log, compileguard.OUTSIDE_MSG, path)
                self.assertNotIn('#include lines', log)
                self.assertNotIn(path, log)
                logged = buf.getvalue()
                self.assertIn('reason=outside', logged, path)
                self.assertNotIn('reason=scan', logged, path)
                self.assertNotIn('reason=infra', logged, path)
                self.assertNotIn('reason=sandbox', logged, path)
        finally:
            subprocess.run = real_run
            compileguard._backend_override = None
            if previous is None:
                os.environ.pop('SIM_COMPILE_SANDBOX', None)
            else:
                os.environ['SIM_COMPILE_SANDBOX'] = previous

    def test_rust_wrapper_panic_is_infra(self):
        previous = os.environ.get('SIM_COMPILE_SANDBOX')
        os.environ['SIM_COMPILE_SANDBOX'] = 'off'
        real_run = subprocess.run
        panic = (
            "thread 'main' panicked at src/main.rs:1:1:\n"
            "no /proc/self/exe available. Is /proc mounted?\n"
        )

        def wrapper(argv, *args, **kwargs):
            if '-M' in argv:
                return subprocess.CompletedProcess(argv, 101, '', panic)
            return real_run(argv, *args, **kwargs)

        subprocess.run = wrapper
        try:
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                log = _rejected_log(self, server._compile_plan({
                    'sketch': '#include SIM_X\nvoid setup(){}\n',
                    'files': {},
                    'defines': ['SIM_X="hostname"'],
                }))
        finally:
            subprocess.run = real_run
            if previous is None:
                os.environ.pop('SIM_COMPILE_SANDBOX', None)
            else:
                os.environ['SIM_COMPILE_SANDBOX'] = previous
        self.assertEqual(log, compileguard.SANDBOX_MSG)
        self.assertNotIn('#include lines', log)
        logged = buf.getvalue()
        self.assertIn('reason=infra', logged)
        self.assertNotIn('reason=scan', logged)
        self.assertNotIn('reason=sandbox', logged)

    def test_real_compiler_recipe_and_scan_argv(self):
        root = Path(tempfile.mkdtemp(prefix='esp32tc-'))
        bindir = root / 'bin'
        bindir.mkdir()
        dyn = root / 'lib' / 'xtensa_esp32.so'
        dyn.parent.mkdir()
        dyn.write_bytes(b'\x7fELF')
        for name in ('xtensa-esp-elf-g++', 'xtensa-esp-elf-gcc', 'xtensa-esp-elf-gcc-ar', 'xtensa-esp-elf-size'):
            path = bindir / name
            path.write_text('#!/bin/sh\nexit 0\n')
            path.chmod(0o755)
        saved = {key: os.environ.get(key) for key in ('SIM_XTENSA_CC_REAL', 'SIM_XTENSA_DYNCONFIG', 'SIM_TOOLCHAIN_DIR')}
        os.environ['SIM_XTENSA_CC_REAL'] = str(bindir / 'xtensa-esp-elf-g++')
        os.environ['SIM_XTENSA_DYNCONFIG'] = str(dyn)
        os.environ.pop('SIM_TOOLCHAIN_DIR', None)
        try:
            props = dict(compileguard.toolchain_recipe(
                c_flags='-DFEATURE=1', cpp_flags='-DFEATURE=1', elf_flags='-Wl,--wrap=lwip_connect'))
            self.assertEqual(props['compiler.path'], str(bindir) + '/')
            self.assertEqual(props['compiler.c.cmd'], 'xtensa-esp-elf-gcc')
            self.assertEqual(props['compiler.cpp.cmd'], 'xtensa-esp-elf-g++')
            self.assertEqual(props['compiler.S.cmd'], 'xtensa-esp-elf-gcc')
            self.assertEqual(props['compiler.c.elf.cmd'], 'xtensa-esp-elf-g++')
            self.assertEqual(props['compiler.ar.cmd'], 'xtensa-esp-elf-gcc-ar')
            self.assertEqual(props['compiler.size.cmd'], 'xtensa-esp-elf-size')
            self.assertTrue(props['compiler.cpp.extra_flags'].startswith('-mdynconfig=xtensa_esp32.so'))
            self.assertNotIn(str(dyn), props['compiler.cpp.extra_flags'])
            self.assertIn('-DFEATURE=1', props['compiler.cpp.extra_flags'])
            self.assertIn('-Wl,--wrap=lwip_connect', props['compiler.c.elf.extra_flags'])
            self.assertNotIn('xtensa-esp32-elf', ' '.join(props.values()))
            prefix = compileguard.preprocessor_command()
            self.assertEqual(prefix[0], str(bindir / 'xtensa-esp-elf-g++'))
            self.assertIn('-mdynconfig=xtensa_esp32.so', prefix)
            work = Path(tempfile.mkdtemp(prefix='esp32argv-'))
            try:
                argv = compileguard.bwrap_argv(
                    prefix + ['-E', '-M', str(work / 'unit.cpp')],
                    work=work, read_only=[root], read_write=[work])
            finally:
                shutil.rmtree(work, ignore_errors=True)
            self.assertNotIn('--proc', argv)
            self.assertIn(str(bindir / 'xtensa-esp-elf-g++'), argv)
            self.assertIn('-mdynconfig=xtensa_esp32.so', argv)
            self.assertNotIn('xtensa-esp32-elf-g++', argv)
            os.environ.pop('SIM_XTENSA_CC_REAL', None)
            os.environ['SIM_TOOLCHAIN_DIR'] = str(root / 'missing')
            with self.assertRaises(compileguard.ToolchainError):
                compileguard.resolve_xtensa()
        finally:
            shutil.rmtree(root, ignore_errors=True)
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

    def test_user_preprocessor_error_stays_scan(self):
        previous = os.environ.get('SIM_COMPILE_SANDBOX')
        os.environ['SIM_COMPILE_SANDBOX'] = 'off'
        real_run = subprocess.run

        def user_fail(argv, *args, **kwargs):
            if '-M' in argv:
                return subprocess.CompletedProcess(
                    argv, 1, '', 'unit.cpp:1:10: fatal error: not-a-header.h: No such file or directory')
            return real_run(argv, *args, **kwargs)

        subprocess.run = user_fail
        try:
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                log = _rejected_log(self, server._compile_plan({
                    'sketch': '#include SIM_X\nvoid setup(){}\n',
                    'files': {},
                    'defines': ['SIM_X="hostname"'],
                }))
        finally:
            subprocess.run = real_run
            if previous is None:
                os.environ.pop('SIM_COMPILE_SANDBOX', None)
            else:
                os.environ['SIM_COMPILE_SANDBOX'] = previous
        self.assertEqual(log, compileguard.SCAN_MSG)
        self.assertIn('reason=scan', buf.getvalue())
        self.assertNotIn('reason=infra', buf.getvalue())
        self.assertNotIn('reason=sandbox', buf.getvalue())

    def test_proc_includes_do_not_leak_environment(self):
        saved = {key: os.environ.get(key) for key in ('SIM_TOKEN', 'SIM_ACCESS_TOKEN', 'SIM_PROC_CANARY')}
        os.environ['SIM_TOKEN'] = 'token-secret-value'
        os.environ['SIM_ACCESS_TOKEN'] = 'access-secret-value'
        os.environ['SIM_PROC_CANARY'] = 'CANARY_ENV_PROC_991'
        secrets = ('token-secret-value', 'access-secret-value', 'CANARY_ENV_PROC_991')
        sketches = []
        for path in ('/proc/self/environ', '/proc/1/environ', '/proc/self/cmdline', '/proc/1/cmdline'):
            sketches.append('#include "%s"\nvoid setup(){}\n' % path)
            sketches.append('#include <%s>\nvoid setup(){}\n' % path)
        try:
            for src in sketches:
                buf = io.StringIO()
                with contextlib.redirect_stdout(buf):
                    log = _rejected_log(self, server._compile_plan({'sketch': src, 'files': {}}))
                self.assertIn('outside the project', log)
                self.assertNotIn('#include lines', log)
                self.assertIn('reason=outside', buf.getvalue())
                self.assertNotIn('reason=scan', buf.getvalue())
                self.assertNotIn('reason=infra', buf.getvalue())
                blob = log + '\n' + buf.getvalue()
                for secret in secrets:
                    self.assertNotIn(secret, blob, src)
                self.assertNotIn('SIM_ACCESS_TOKEN', blob)
        finally:
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

    def test_net_blocked_notice_is_true_for_wifi_and_false_for_blink(self):
        wifi = '#include <WiFi.h>\nvoid setup(){}\n'
        http = '#include <HTTPClient.h>\nvoid setup(){}\n'
        client = '#include <WiFiClientSecure.h>\nvoid setup(){}\n'
        blink = 'void setup(){ pinMode(2, OUTPUT); }\nvoid loop(){}\n'
        comment = '// #include <WiFi.h>\nvoid setup(){}\n'
        self.assertTrue(compileguard.net_blocked_notice(wifi, {}))
        self.assertTrue(compileguard.net_blocked_notice(http, {}))
        self.assertTrue(compileguard.net_blocked_notice(client, {}))
        self.assertFalse(compileguard.net_blocked_notice(blink, {}))
        self.assertFalse(compileguard.net_blocked_notice(comment, {}))
        previous = os.environ.get('SIM_NET_NOTICE')
        os.environ['SIM_NET_NOTICE'] = '0'
        try:
            self.assertFalse(compileguard.net_blocked_notice(wifi, {}))
        finally:
            if previous is None:
                os.environ.pop('SIM_NET_NOTICE', None)
            else:
                os.environ['SIM_NET_NOTICE'] = previous
        body = server._attach_notice({'ok': True, 'id': 'k', 'log': ''}, wifi, {})
        self.assertIs(body['net_blocked_notice'], True)
        quiet = server._attach_notice({'ok': True, 'id': 'k', 'log': ''}, blink, {})
        self.assertIs(quiet['net_blocked_notice'], False)


class _QuietOut:
    def __aiter__(self):
        return self

    async def __anext__(self):
        raise StopAsyncIteration


class _FakeCompile:
    def __init__(self):
        self.returncode = None
        self.stdout = _QuietOut()

    async def wait(self):
        self.returncode = 0
        return 0

    def kill(self):
        self.returncode = -9


def _plant_firmware(argv):
    args = [str(part) for part in argv]
    out = Path(args[args.index('--output-dir') + 1])
    out.mkdir(parents=True, exist_ok=True)
    (out / 'sketch.ino.elf').write_bytes(b'\x7fELF' + b'\x00' * 64)
    (out / 'sketch.ino.merged.bin').write_bytes(b'\xff' * 64)


def _refused_compile(resp):
    body = json.loads(resp.body.decode())
    return body


class BuildIdTests(unittest.TestCase):
    def setUp(self):
        self._override = compileguard._backend_override
        self._scan = compileguard.scan_sketch_dir
        self._recipe = compileguard.toolchain_recipe
        self._exec = server.asyncio.create_subprocess_exec
        self._saved = os.environ.get('SIM_COMPILE_SANDBOX')
        self._alias = os.environ.get('SIM_SANDBOX')
        compileguard.scan_sketch_dir = lambda *args, **kwargs: None
        compileguard.toolchain_recipe = lambda **kwargs: [
            ('compiler.path', '/tmp/xtensa/bin/'),
            ('compiler.c.elf.extra_flags', '-mdynconfig=xtensa_esp32.so'),
        ]

    def tearDown(self):
        compileguard._backend_override = self._override
        compileguard.scan_sketch_dir = self._scan
        compileguard.toolchain_recipe = self._recipe
        server.asyncio.create_subprocess_exec = self._exec
        if self._saved is None:
            os.environ.pop('SIM_COMPILE_SANDBOX', None)
        else:
            os.environ['SIM_COMPILE_SANDBOX'] = self._saved
        if self._alias is None:
            os.environ.pop('SIM_SANDBOX', None)
        else:
            os.environ['SIM_SANDBOX'] = self._alias

    async def _compile(self, seen):
        sketch = 'void setup(){}\nvoid loop(){}\n// %d\n' % int.from_bytes(os.urandom(3), 'big')
        plan = server._compile_plan({'sketch': sketch, 'files': {}})
        self.assertIsInstance(plan, dict, getattr(plan, 'body', plan))
        shutil.rmtree(plan['bdir'], ignore_errors=True)
        work = Path(tempfile.mkdtemp(prefix='esp32id-'))

        async def fake_exec(*argv, **kwargs):
            seen.append((list(argv), kwargs.get('env')))
            _plant_firmware(argv)
            return _FakeCompile()

        server.asyncio.create_subprocess_exec = fake_exec
        try:
            resp = await server._compile_in(
                work, plan['bdir'], plan['key'], plan['sketch'], plan['files'],
                plan['defines'], plan['net'], plan['netmode'], plan['simlibs'])
        finally:
            shutil.rmtree(work, ignore_errors=True)
        return plan, resp

    def test_fresh_compile_id_is_the_build_hash(self):
        os.environ['SIM_COMPILE_SANDBOX'] = 'off'
        os.environ.pop('SIM_SANDBOX', None)
        compileguard._backend_override = None
        seen = []
        plan, resp = asyncio.run(self._compile(seen))
        try:
            self.assertIsInstance(resp, dict, getattr(resp, 'body', resp))
            self.assertTrue(resp.get('ok'), resp)
            self.assertEqual(resp['id'], plan['key'])
            self.assertNotEqual(resp['id'], 'compiler.c.elf.extra_flags')
            self.assertNotIn('compiler.c.elf', resp['id'])
            safe = re.sub(r'[^0-9a-f]', '', resp['id'])
            img = server.BUILDS / safe / 'flash.bin'
            self.assertTrue(img.is_file(), resp['id'])
            self.assertEqual(img.resolve(), (plan['bdir'] / 'flash.bin').resolve())
            self.assertTrue(seen)
            self.assertNotEqual(Path(seen[0][0][0]).name, 'bwrap')
        finally:
            shutil.rmtree(plan['bdir'], ignore_errors=True)

    def _assert_refused_without_spawn(self, sketch_note):
        calls = []
        real_run = subprocess.run

        def spy_run(*args, **kwargs):
            calls.append('run')
            return real_run(*args, **kwargs)

        async def spy_exec(*args, **kwargs):
            calls.append('exec')
            raise AssertionError('compiler spawned')

        subprocess.run = spy_run
        server.asyncio.create_subprocess_exec = spy_exec
        work = Path(tempfile.mkdtemp(prefix='esp32closed-'))
        bdir = Path(tempfile.mkdtemp(prefix='esp32fw-'))
        try:
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                resp = asyncio.run(server._compile_in(
                    work, bdir, 'abc123def4567890',
                    'void setup(){}\nvoid loop(){}\n', {}, [], False, None, []))
        finally:
            subprocess.run = real_run
            server.asyncio.create_subprocess_exec = self._exec
            shutil.rmtree(work, ignore_errors=True)
            shutil.rmtree(bdir, ignore_errors=True)
        self.assertEqual(calls, [], sketch_note)
        body = _refused_compile(resp)
        self.assertFalse(body.get('ok', True))
        self.assertEqual(body.get('log'), compileguard.SANDBOX_MSG)
        self.assertEqual(body.get('reason'), 'infra')
        self.assertIn('reason=infra', buf.getvalue())
        self.assertNotIn('reason=scan', buf.getvalue())

    def test_unset_flag_refuses_when_the_sandbox_is_missing(self):
        os.environ.pop('SIM_COMPILE_SANDBOX', None)
        os.environ.pop('SIM_SANDBOX', None)
        compileguard._backend_override = 'missing'
        self.assertEqual(compileguard.sandbox_choice(), 'on')
        self.assertNotIn('OFF (unsafe', compileguard.startup_banner())
        self._assert_refused_without_spawn('unset')

    def test_unknown_sandbox_value_fails_closed(self):
        os.environ.pop('SIM_SANDBOX', None)
        compileguard._backend_override = 'missing'
        for value in ('auto', '0', 'maybe', ''):
            os.environ['SIM_COMPILE_SANDBOX'] = value
            self.assertEqual(compileguard.sandbox_choice(), 'on', value)
            self.assertNotIn('OFF (unsafe', compileguard.startup_banner())
            self._assert_refused_without_spawn(value)

    def test_explicit_off_compiles_without_server_secrets(self):
        compileguard._backend_override = None
        names = (
            'PATH', 'LANG', 'LD_LIBRARY_PATH', 'SIM_TOKEN', 'SIM_ACCESS_TOKEN',
            'SIM_PROC_CANARY', 'ARDUINO_BUILD_CACHE_PATH', 'SIM_COMPILE_SANDBOX', 'SIM_SANDBOX')
        saved = {key: os.environ.get(key) for key in names}
        os.environ['PATH'] = os.environ.get('PATH') or '/usr/bin'
        os.environ['LANG'] = 'C'
        os.environ['LD_LIBRARY_PATH'] = '/evil'
        os.environ['SIM_TOKEN'] = 'token-secret-value'
        os.environ['SIM_ACCESS_TOKEN'] = 'access-secret-value'
        os.environ['SIM_PROC_CANARY'] = 'CANARY_ENV_PROC_991'
        os.environ['ARDUINO_BUILD_CACHE_PATH'] = '/cache-from-pass-env'
        dirs = []
        try:
            for primary, alias in (('off', None), (None, 'off')):
                if primary is None:
                    os.environ.pop('SIM_COMPILE_SANDBOX', None)
                else:
                    os.environ['SIM_COMPILE_SANDBOX'] = primary
                if alias is None:
                    os.environ.pop('SIM_SANDBOX', None)
                else:
                    os.environ['SIM_SANDBOX'] = alias
                self.assertEqual(compileguard.sandbox_choice(), 'off')
                self.assertEqual(
                    compileguard.startup_banner(),
                    'compile sandbox OFF (unsafe, dev only)')
                seen = []
                plan, resp = asyncio.run(self._compile(seen))
                dirs.append(plan['bdir'])
                self.assertTrue(resp.get('ok'), resp)
                self.assertEqual(resp['id'], plan['key'])
                self.assertTrue(seen)
                argv, env = seen[0]
                self.assertNotIn(Path(argv[0]).name, {'bwrap', 'docker'})
                self.assertIsInstance(env, dict)
                self.assertEqual(env, compileguard._direct_compiler_env())
                allowed = {'PATH', 'LANG', 'LD_LIBRARY_PATH', *compileguard._PASS_ENV}
                self.assertTrue(set(env) <= allowed, sorted(set(env) - allowed))
                blob = '\n'.join('%s=%s' % (key, value) for key, value in env.items())
                self.assertNotIn('token-secret-value', blob)
                self.assertNotIn('access-secret-value', blob)
                self.assertNotIn('CANARY_ENV_PROC_991', blob)
                self.assertNotIn('SIM_TOKEN', env)
                self.assertNotIn('SIM_ACCESS_TOKEN', env)
                self.assertNotIn('SIM_PROC_CANARY', env)
                self.assertEqual(env.get('ARDUINO_BUILD_CACHE_PATH'), '/cache-from-pass-env')
                lib = compileguard.dynconfig_library_dir()
                if lib:
                    self.assertTrue(env['LD_LIBRARY_PATH'].startswith(lib + os.pathsep))
                    self.assertIn('/evil', env['LD_LIBRARY_PATH'].split(os.pathsep))
                else:
                    self.assertEqual(env['LD_LIBRARY_PATH'], '/evil')
            os.environ['SIM_COMPILE_SANDBOX'] = '1'
            os.environ['SIM_SANDBOX'] = 'off'
            self.assertEqual(compileguard.sandbox_choice(), 'on')
        finally:
            for path in dirs:
                shutil.rmtree(path, ignore_errors=True)
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

    def test_unknown_build_id_tells_the_learner_to_press_run(self):
        class FakeWS:
            def __init__(self):
                self.sent = []
                self.query_params = {}
                self.cookies = {}

            async def accept(self):
                self.accepted = True

            async def send_json(self, payload):
                self.sent.append(payload)

            async def close(self, code=1000):
                self.closed = code

        ws = FakeWS()
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            asyncio.run(server.run(ws, '0123456789abcdef'))
        self.assertTrue(ws.accepted)
        self.assertEqual(len(ws.sent), 1)
        msg = ws.sent[0]
        self.assertEqual(msg.get('t'), 'error')
        self.assertEqual(msg.get('reason'), 'unknown')
        self.assertEqual(msg.get('msg'), 'This build has expired. Press Run to build it again.')
        self.assertNotIn('unknown build id', msg.get('msg', ''))
        logged = buf.getvalue()
        self.assertIn('reason=unknown', logged)
        self.assertNotIn('This build has expired', logged)


class QemuRunTests(unittest.TestCase):
    def _fake_qemu(self, root: Path) -> Path:
        script = root / 'qemu-system-xtensa'
        script.write_text(
            '#!/bin/sh\n'
            'printf \'%s\\n\' "$@"\n'
            'echo --ENV--\n'
            'env\n'
            'echo early-exit >&2\n'
            'exit 1\n')
        script.chmod(0o755)
        return script

    def _run(self, script: Path, rom: Path):
        bid = 'cafebabe12345678'
        image_dir = server.BUILDS / bid
        image_dir.mkdir(parents=True, exist_ok=True)
        image = image_dir / 'flash.bin'
        image.write_bytes(b'\xff' * 64)
        saved_qemu, saved_rom = server.QEMU, server.ROMDIR
        server.QEMU = str(script)
        server.ROMDIR = str(rom)
        link = server.Link('qemu-test')
        buf = io.StringIO()
        try:
            with contextlib.redirect_stdout(buf):
                asyncio.run(server._session_main(link, bid, image))
        finally:
            server.QEMU = saved_qemu
            server.ROMDIR = saved_rom
        messages = []
        for _n, _kind, txt in link.ring:
            messages.append(json.loads(txt))
        return messages, buf.getvalue(), image

    def test_qemu_spawn_env_keeps_home_library_path_and_rom(self):
        root = Path(tempfile.mkdtemp(prefix='esp32qemu-'))
        rom = root / 'rom'
        rom.mkdir()
        (rom / 'esp32-v3-rom.bin').write_bytes(b'rom')
        script = self._fake_qemu(root)
        names = (
            'HOME', 'PATH', 'LANG', 'LD_LIBRARY_PATH', 'LD_PRELOAD', 'LD_AUDIT', 'QEMU_ROM_DIR',
            'SIM_QEMU_LIB_DIRS', 'SIM_TOKEN', 'SIM_ACCESS_TOKEN', 'SIM_PROC_CANARY')
        saved = {key: os.environ.get(key) for key in names}
        os.environ['HOME'] = os.environ.get('HOME') or '/home/learner'
        os.environ['PATH'] = os.environ.get('PATH') or '/usr/bin'
        os.environ['LANG'] = 'C'
        os.environ['LD_LIBRARY_PATH'] = '/opt/qemu-host-libs'
        os.environ['LD_PRELOAD'] = '/tmp/not-qemu-preload.so'
        os.environ['LD_AUDIT'] = '/tmp/not-qemu-audit.so'
        os.environ.pop('SIM_QEMU_LIB_DIRS', None)
        os.environ.pop('QEMU_ROM_DIR', None)
        os.environ['SIM_TOKEN'] = 'token-secret-value'
        os.environ['SIM_ACCESS_TOKEN'] = 'access-secret-value'
        os.environ['SIM_PROC_CANARY'] = 'CANARY_ENV_PROC_991'
        try:
            # The compiler launcher drops HOME and QEMU_ROM_DIR. QEMU must not use it.
            sandbox_env = compileguard.host_sandbox_env()
            self.assertNotIn('HOME', sandbox_env)
            self.assertNotIn('QEMU_ROM_DIR', sandbox_env)
            messages, _logged, image = self._run(script, rom)
            dumped = (server.BUILDS / 'qemu-last.log').read_text(errors='replace')
            argv, env_text = dumped.split('--ENV--\n', 1)
            env = {}
            for line in env_text.splitlines():
                if '=' in line:
                    key, value = line.split('=', 1)
                    env[key] = value
            self.assertIn('HOME', env)
            self.assertEqual(env['HOME'], os.environ['HOME'])
            self.assertIn('PATH', env)
            self.assertEqual(env['LD_LIBRARY_PATH'], '/opt/qemu-host-libs')
            self.assertEqual(env['QEMU_ROM_DIR'], str(rom))
            self.assertNotIn('LD_PRELOAD', env)
            self.assertNotIn('LD_AUDIT', env)
            self.assertNotIn('SIM_TOKEN', env)
            self.assertNotIn('SIM_ACCESS_TOKEN', env)
            self.assertNotIn('CANARY_ENV_PROC_991', env_text)
            self.assertNotIn('token-secret-value', env_text)
            self.assertNotIn('not-qemu-preload.so', env_text)
            self.assertNotIn('not-qemu-audit.so', env_text)
            self.assertIn('-L', argv.splitlines())
            self.assertIn(str(rom), argv)
            drive = next(line for line in argv.splitlines() if line.startswith('file='))
            self.assertIn('esp32run-', drive)
            self.assertNotIn(str(server.BUILDS), drive.split('file=', 1)[1].split(',')[0])
            self.assertTrue(image.is_file())
            self.assertTrue(any(m.get('t') == 'error' for m in messages))
        finally:
            shutil.rmtree(root, ignore_errors=True)
            shutil.rmtree(server.BUILDS / 'cafebabe12345678', ignore_errors=True)
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

    def test_qemu_that_exits_at_once_is_infra(self):
        root = Path(tempfile.mkdtemp(prefix='esp32qemu-'))
        rom = root / 'rom'
        rom.mkdir()
        script = self._fake_qemu(root)
        try:
            messages, logged, _image = self._run(script, rom)
            errors = [m for m in messages if m.get('t') == 'error']
            self.assertEqual(len(errors), 1, messages)
            self.assertEqual(errors[0].get('msg'), server.QEMU_FAIL_MSG)
            self.assertEqual(errors[0].get('reason'), 'infra')
            self.assertEqual(errors[0].get('rc'), 1)
            self.assertIn('reason=infra', logged)
            self.assertNotIn(server.QEMU_FAIL_MSG, logged)
            self.assertNotIn('reason=scan', logged)
            log_path = server.BUILDS / 'qemu-last.log'
            self.assertTrue(log_path.is_file(), log_path)
            self.assertIn(b'early-exit', log_path.read_bytes())
        finally:
            shutil.rmtree(root, ignore_errors=True)
            shutil.rmtree(server.BUILDS / 'cafebabe12345678', ignore_errors=True)

    def _restore_qemu_check(self, saved):
        server._qemu_check.clear()
        server._qemu_check.update(saved)

    def test_qemu_selfcheck_ok_uses_spawn_env(self):
        root = Path(tempfile.mkdtemp(prefix='esp32qemu-'))
        lib = Path('/usr/lib')
        env_file = root / 'env.txt'
        script = root / 'qemu-system-xtensa'
        quoted = "'" + str(env_file).replace("'", "'\\''") + "'"
        script.write_text(
            '#!/bin/sh\n'
            'env > ' + quoted + '\n'
            'if [ "$1" = "--version" ]; then\n'
            '  echo "QEMU emulator version test"\n'
            '  exit 0\n'
            'fi\n'
            'echo should-not-run >&2\n'
            'exit 99\n')
        script.chmod(0o755)
        saved_qemu = server.QEMU
        saved_check = dict(server._qemu_check)
        saved_libs = os.environ.get('SIM_QEMU_LIB_DIRS')
        saved_ld = os.environ.get('LD_LIBRARY_PATH')
        saved_preload = os.environ.get('LD_PRELOAD')
        os.environ['SIM_QEMU_LIB_DIRS'] = str(lib)
        os.environ['LD_LIBRARY_PATH'] = '/opt/qemu-host-libs'
        os.environ['LD_PRELOAD'] = '/tmp/not-qemu-preload.so'
        server.QEMU = str(script)
        buf = io.StringIO()
        try:
            with contextlib.redirect_stdout(buf):
                ok = server.run_qemu_selfcheck(qemu_bin=str(script), romdir=str(root))
            self.assertTrue(ok)
            self.assertNotIn('qemu selfcheck failed', buf.getvalue())
            body = server.health()
            self.assertIs(body['qemu_ok'], True)
            self.assertNotIn('stderr', body)
            dumped = env_file.read_text()
            lib_line = next(line for line in dumped.splitlines() if line.startswith('LD_LIBRARY_PATH='))
            parts = lib_line.split('=', 1)[1].split(os.pathsep)
            self.assertIn(str(lib), parts)
            self.assertLess(parts.index(str(lib)), parts.index('/opt/qemu-host-libs'))
            self.assertNotIn('LD_PRELOAD=', dumped)
            self.assertNotIn('SIM_QEMU_LIB_DIRS=', dumped)
            sandbox_env = compileguard.host_sandbox_env()
            self.assertNotIn(str(lib), sandbox_env.get('LD_LIBRARY_PATH', ''))
        finally:
            server.QEMU = saved_qemu
            self._restore_qemu_check(saved_check)
            if saved_libs is None:
                os.environ.pop('SIM_QEMU_LIB_DIRS', None)
            else:
                os.environ['SIM_QEMU_LIB_DIRS'] = saved_libs
            if saved_ld is None:
                os.environ.pop('LD_LIBRARY_PATH', None)
            else:
                os.environ['LD_LIBRARY_PATH'] = saved_ld
            if saved_preload is None:
                os.environ.pop('LD_PRELOAD', None)
            else:
                os.environ['LD_PRELOAD'] = saved_preload
            shutil.rmtree(root, ignore_errors=True)

    def test_qemu_selfcheck_fail_is_infra_and_hides_stderr(self):
        root = Path(tempfile.mkdtemp(prefix='esp32qemu-'))
        calls = root / 'calls.txt'
        script = root / 'qemu-system-xtensa'
        quoted = "'" + str(calls).replace("'", "'\\''") + "'"
        script.write_text(
            '#!/bin/sh\n'
            'printf \'%s\\n\' "$@" >> ' + quoted + '\n'
            'echo "libslirp.so.0: cannot open shared object file" >&2\n'
            'exit 127\n')
        script.chmod(0o755)
        bid = 'cafebabe12345678'
        image_dir = server.BUILDS / bid
        image_dir.mkdir(parents=True, exist_ok=True)
        (image_dir / 'flash.bin').write_bytes(b'\xff' * 64)
        saved_qemu = server.QEMU
        saved_check = dict(server._qemu_check)
        server.QEMU = str(script)

        class FakeWS:
            def __init__(self):
                self.sent = []
                self.query_params = {}
                self.cookies = {}

            async def accept(self):
                self.accepted = True

            async def send_json(self, payload):
                self.sent.append(payload)

            async def close(self, code=1000):
                self.closed = code

        buf = io.StringIO()
        try:
            with contextlib.redirect_stdout(buf):
                ok = server.run_qemu_selfcheck(qemu_bin=str(script), romdir=str(root))
            self.assertFalse(ok)
            logged = buf.getvalue()
            self.assertIn('ERROR qemu selfcheck failed rc=127 stderr=', logged)
            self.assertIn('libslirp.so.0: cannot open shared object file', logged)
            body = server.health()
            dumped = json.dumps(body)
            self.assertIs(body['qemu_ok'], False)
            self.assertIs(body['ok'], False)
            self.assertIs(body['compile_ok'], bool(server.CLI) and Path(server.CLI).exists())
            self.assertIn('sandbox_ok', body)
            self.assertNotIn('libslirp', dumped)
            self.assertNotIn('cannot open shared object', dumped)
            self.assertNotIn('stderr', body)
            ws = FakeWS()
            with contextlib.redirect_stdout(buf):
                asyncio.run(server.run(ws, bid))
            self.assertEqual(calls.read_text().splitlines(), ['--version', '--version'])
            errors = [m for m in ws.sent if m.get('t') == 'error']
            self.assertEqual(len(errors), 1, ws.sent)
            self.assertEqual(errors[0].get('msg'), server.QEMU_FAIL_MSG)
            self.assertEqual(errors[0].get('reason'), 'infra')
            self.assertEqual(errors[0].get('rc'), 127)
            self.assertIn('run rejected reason=infra qemu rc=127', buf.getvalue())
            self.assertNotIn(server.QEMU_FAIL_MSG, buf.getvalue())
        finally:
            server.QEMU = saved_qemu
            self._restore_qemu_check(saved_check)
            shutil.rmtree(root, ignore_errors=True)
            shutil.rmtree(image_dir, ignore_errors=True)

    def test_qemu_lib_dirs_keeps_only_absolute_existing_dirs(self):
        root = Path(tempfile.mkdtemp(prefix='esp32qemu-'))
        missing = Path('/opt/no-such-esp32-lib')
        accepted = Path('/usr/lib')
        env = {
            'PATH': '/usr/bin',
            'HOME': '/home/learner',
            'LD_LIBRARY_PATH': '/opt/qemu-host-libs',
            'LD_PRELOAD': '/tmp/not-qemu-preload.so',
            'SIM_QEMU_LIB_DIRS': os.pathsep.join(['rel/libs', str(missing), str(accepted), '']),
            'SIM_TOKEN': 'token-secret-value',
        }
        buf = io.StringIO()
        try:
            with contextlib.redirect_stdout(buf):
                spawn = server.qemu_run_env(env=env, romdir=str(root), qemu_bin=str(root / 'qemu'))
            logged = buf.getvalue()
            self.assertIn('reason=not-absolute path=%r' % 'rel/libs', logged)
            self.assertIn('reason=missing path=%r' % str(missing), logged)
            parts = spawn['LD_LIBRARY_PATH'].split(os.pathsep)
            self.assertIn(str(accepted.resolve()), parts)
            self.assertIn('/opt/qemu-host-libs', parts)
            self.assertLess(parts.index(str(accepted.resolve())), parts.index('/opt/qemu-host-libs'))
            self.assertNotIn('rel/libs', parts)
            self.assertNotIn(str(missing), parts)
            self.assertNotIn('LD_PRELOAD', spawn)
            self.assertNotIn('SIM_TOKEN', spawn)
            self.assertNotIn('SIM_QEMU_LIB_DIRS', spawn)
        finally:
            shutil.rmtree(root, ignore_errors=True)


class RunBuildIdTests(unittest.TestCase):
    def _ws(self):
        class FakeWS:
            def __init__(self):
                self.sent = []
                self.query_params = {}
                self.cookies = {}

            async def accept(self):
                self.accepted = True

            async def send_json(self, payload):
                self.sent.append(payload)

            async def close(self, code=1000):
                self.closed = code

        return FakeWS()

    def _run(self, bid):
        ws = self._ws()
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            asyncio.run(server.run(ws, bid))
        return ws, buf.getvalue()

    def test_bad_ids_are_refused_before_a_path_is_built(self):
        root = Path(tempfile.mkdtemp(prefix='esp32bid-'))
        saved = server.BUILDS
        real = 'abcdef0123456789'
        try:
            server.BUILDS = root
            (root / 'flash.bin').write_bytes(b'canary-root')
            nested = root / real
            nested.mkdir()
            (nested / 'flash.bin').write_bytes(b'canary-real')
            for bid in ('', 'not-a-build', 'abc', 'g' * 16, real.upper(), real + 'a', real[:-1],
                        '../' + real, real + '/../' + real, 'zz' + real, real + '\n'):
                ws, logged = self._run(bid)
                self.assertEqual(ws.sent[0].get('reason'), 'bad_build_id', bid)
                self.assertEqual(ws.sent[0].get('msg'), server.BAD_BUILD_MSG, bid)
                self.assertEqual(ws.closed, 4400, bid)
                self.assertIn('run rejected reason=bad_build_id', logged)
                self.assertNotIn(server.BAD_BUILD_MSG, logged)
                self.assertNotIn('session', [m.get('t') for m in ws.sent])
                self.assertEqual((root / 'flash.bin').read_bytes(), b'canary-root')
                self.assertEqual((nested / 'flash.bin').read_bytes(), b'canary-real')
        finally:
            server.BUILDS = saved
            shutil.rmtree(root, ignore_errors=True)

    def test_symlink_build_dir_cannot_escape(self):
        root = Path(tempfile.mkdtemp(prefix='esp32bid-'))
        outside = Path(tempfile.mkdtemp(prefix='esp32out-'))
        saved = server.BUILDS
        bid = 'abcdef0123456789'
        try:
            server.BUILDS = root
            (outside / 'flash.bin').write_bytes(b'escaped')
            (root / bid).symlink_to(outside)
            ws, logged = self._run(bid)
            self.assertEqual(ws.sent[0].get('reason'), 'bad_build_id')
            self.assertIn('run rejected reason=bad_build_id', logged)
            self.assertNotIn('session', [m.get('t') for m in ws.sent])
            self.assertEqual((outside / 'flash.bin').read_bytes(), b'escaped')
        finally:
            server.BUILDS = saved
            shutil.rmtree(root, ignore_errors=True)
            shutil.rmtree(outside, ignore_errors=True)


class SandboxFailClosedTests(unittest.TestCase):
    def setUp(self):
        self._saved = {
            'backend': compileguard._backend_override,
            'works': compileguard._works_override,
            'seccomp': compileguard._seccomp_override,
        }

    def tearDown(self):
        compileguard._backend_override = self._saved['backend']
        compileguard._works_override = self._saved['works']
        compileguard._seccomp_override = self._saved['seccomp']

    def _refuse(self, which):
        if which == 'missing':
            compileguard._backend_override = 'missing'
        elif which == 'broken':
            compileguard._works_override = False
        elif which == 'seccomp':
            compileguard._works_override = True
            compileguard._seccomp_override = False
        saved_flag = os.environ.get('SIM_COMPILE_SANDBOX')
        os.environ['SIM_COMPILE_SANDBOX'] = '1'
        spawned = []
        real_run = subprocess.run
        real_popen = subprocess.Popen
        real_exec = asyncio.create_subprocess_exec

        def see_run(argv, *args, **kwargs):
            spawned.append(list(argv))
            return real_run(argv, *args, **kwargs)

        def see_popen(argv, *args, **kwargs):
            spawned.append(list(argv))
            raise AssertionError('qemu spawned')

        async def see_exec(*argv, **kwargs):
            spawned.append(list(argv))
            raise AssertionError('compiler spawned')

        subprocess.run = see_run
        subprocess.Popen = see_popen
        asyncio.create_subprocess_exec = see_exec
        root = Path(tempfile.mkdtemp(prefix='esp32box-'))
        bid = 'abcdef0123456789'
        saved_builds = server.BUILDS
        try:
            server.BUILDS = root
            image = root / bid
            image.mkdir()
            (image / 'flash.bin').write_bytes(b'\xff' * 32)
            os.environ['SIM_COMPILE_SANDBOX'] = '1'
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                plan = server._compile_plan({'sketch': 'void setup(){}\nvoid loop(){}\n', 'files': {}})
                self.assertIsInstance(plan, dict, getattr(plan, 'body', plan))
                resp = asyncio.run(server._compile_in(
                    root / 'work', plan['bdir'], plan['key'], plan['sketch'], plan['files'],
                    plan['defines'], plan['net'], plan['netmode'], plan['simlibs']))
            import json as _json
            body = resp if isinstance(resp, dict) else _json.loads(resp.body.decode())
            self.assertFalse(body.get('ok'))
            self.assertEqual(body.get('log'), compileguard.SANDBOX_MSG)
            self.assertEqual(body.get('reason'), 'infra')
            self.assertIn('reason=infra', buf.getvalue())
            self.assertNotIn(compileguard.SANDBOX_MSG, buf.getvalue())

            class FakeWS:
                def __init__(self):
                    self.sent = []
                    self.query_params = {}
                    self.cookies = {}

                async def accept(self):
                    self.accepted = True

                async def send_json(self, payload):
                    self.sent.append(payload)

                async def close(self, code=1000):
                    self.closed = code

            ws = FakeWS()
            with contextlib.redirect_stdout(buf):
                asyncio.run(server.run(ws, bid))
            errors = [m for m in ws.sent if m.get('t') == 'error']
            self.assertEqual(errors[0].get('reason'), 'infra')
            self.assertEqual(errors[0].get('msg'), compileguard.SANDBOX_MSG)
            self.assertNotIn('session', [m.get('t') for m in ws.sent])
            names = [Path(item[0]).name for item in spawned if item]
            self.assertFalse(any(name in {'qemu-system-xtensa', 'bwrap', 'xtensa-esp-elf-g++', 'arduino-cli'}
                                 for name in names), spawned)
        finally:
            subprocess.run = real_run
            subprocess.Popen = real_popen
            asyncio.create_subprocess_exec = real_exec
            server.BUILDS = saved_builds
            shutil.rmtree(root, ignore_errors=True)
            if saved_flag is None:
                os.environ.pop('SIM_COMPILE_SANDBOX', None)
            else:
                os.environ['SIM_COMPILE_SANDBOX'] = saved_flag

    def test_missing_bwrap_spawns_nothing(self):
        self._refuse('missing')

    def test_broken_bwrap_spawns_nothing(self):
        self._refuse('broken')

    def test_seccomp_failure_spawns_nothing(self):
        self._refuse('seccomp')


class QemuLibDirPolicyTests(unittest.TestCase):
    def _env(self, raw):
        return {
            'PATH': '/usr/bin',
            'HOME': '/home/learner',
            'LD_LIBRARY_PATH': '/opt/qemu-host-libs',
            'SIM_QEMU_LIB_DIRS': raw,
        }

    def _spawn(self, raw):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            spawn = server.qemu_run_env(env=self._env(raw), romdir='/usr', qemu_bin='/usr/bin/true')
        return spawn, buf.getvalue()

    def test_root_owned_dir_is_appended_after_qemu_libs(self):
        spawn, logged = self._spawn('/usr/lib')
        self.assertEqual(logged, '')
        parts = spawn['LD_LIBRARY_PATH'].split(os.pathsep)
        self.assertIn('/usr/lib', parts)
        self.assertEqual(parts[-1], '/opt/qemu-host-libs')
        private = [part for part in parts if part not in {'/usr/lib', '/opt/qemu-host-libs'}]
        if private:
            self.assertLess(parts.index(private[0]), parts.index('/usr/lib'))

    def test_tmp_writable_nonroot_and_symlink_are_refused(self):
        home = Path.home() / 'esp32lab-libcheck'
        home.mkdir(exist_ok=True)
        saved_builds, saved_proj = server.BUILDS, server.PROJ_DIR
        server.BUILDS = home / 'builds'
        server.PROJ_DIR = home / 'projects'
        writable = home / 'writable'
        owned = home / 'owned'
        link = home / 'link'
        try:
            writable.mkdir(exist_ok=True)
            writable.chmod(0o777)
            owned.mkdir(exist_ok=True)
            owned.chmod(0o755)
            if link.is_symlink() or link.exists():
                link.unlink()
            link.symlink_to('/usr/lib')
            cases = (
                ('/tmp/esp32-libs', 'under-tmp'),
                ('/var/tmp/esp32-libs', 'under-var-tmp'),
                ('/dev/shm/esp32-libs', 'under-dev-shm'),
                (str(writable), 'writable'),
                (str(owned), 'not-root'),
                (str(link), 'symlink'),
                ('/usr/lib\n/tmp/evil', 'bad-character'),
                (str(server.BUILDS / 'libs'), 'under-builds'),
                (str(server.PROJ_DIR / 'libs'), 'under-projects'),
            )
            for raw, reason in cases:
                spawn, logged = self._spawn(raw)
                self.assertNotIn(raw.split(os.pathsep)[0], spawn.get('LD_LIBRARY_PATH', ''), raw)
                self.assertIn('reason=%s' % reason, logged, raw)
                self.assertEqual(logged.count('\n'), 1, logged)
                if reason == 'bad-character':
                    self.assertIn(repr(raw), logged)
                    self.assertNotIn('\n/tmp', logged)
        finally:
            server.BUILDS = saved_builds
            server.PROJ_DIR = saved_proj
            shutil.rmtree(home, ignore_errors=True)


class QemuSandboxIsolationTests(unittest.TestCase):
    def test_namespace_has_only_lo_and_ptrace_is_eperm(self):
        if not shutil.which('bwrap'):
            self.skipTest('bwrap is not on PATH')
        rundir = Path(tempfile.mkdtemp(prefix='esp32iso-'))
        net = r'''
import socket, struct
s = socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, socket.NETLINK_ROUTE)
s.bind((0, 0))
ifi = struct.pack("=BBHiII", 0, 0, 0, 0, 0, 0)
hdr = struct.pack("=IHHII", 16 + len(ifi), 18, 0x301, 1, 0)
s.send(hdr + ifi)
s.settimeout(1)
names = []
while True:
    try:
        data = s.recv(65535)
    except TimeoutError:
        break
    off = 0
    done = False
    while off + 16 <= len(data):
        nln, typ = struct.unpack_from("=IH", data, off)
        if nln < 16:
            break
        if typ == 3:
            done = True
        if typ == 16:
            attr = off + 32
            end = off + nln
            while attr + 4 <= end:
                alen, atype = struct.unpack_from("=HH", data, attr)
                if alen < 4:
                    break
                if atype == 3:
                    names.append(data[attr+4:attr+alen].split(b"\0", 1)[0].decode())
                attr += (alen + 3) & ~3
        off += (nln + 3) & ~3
    if done:
        break
print("IFACES", " ".join(names))
'''
        ptrace = r'''
import ctypes
libc = ctypes.CDLL(None, use_errno=True)
rc = libc.ptrace(ctypes.c_long(0), ctypes.c_long(0), ctypes.c_void_p(0), ctypes.c_void_p(0))
print("PTRACE", rc, ctypes.get_errno())
'''
        fds = []
        try:
            for code, marker in ((net, 'IFACES lo'), (ptrace, 'PTRACE -1 1')):
                argv, held = server.qemu_sandbox_argv(
                    [sys.executable, '-c', code], {'PATH': '/usr/bin:/bin'}, rundir)
                self.assertIsNotNone(argv)
                fds.extend(held)
                self.assertIn('--unshare-all', argv)
                self.assertNotIn('--proc', argv)
                self.assertNotIn('/proc', argv)
                proc = subprocess.run(
                    argv, pass_fds=tuple(held), capture_output=True, text=True, timeout=20,
                    env=compileguard.host_sandbox_env())
                compileguard.close_fds(held)
                self.assertEqual(proc.returncode, 0, proc.stderr)
                self.assertIn(marker, proc.stdout, proc.stdout + proc.stderr)
                if marker.startswith('IFACES'):
                    names = proc.stdout.strip().split('IFACES', 1)[1].split()
                    self.assertEqual(names, ['lo'])
        finally:
            compileguard.close_fds(fds)
            shutil.rmtree(rundir, ignore_errors=True)

    def test_prefix_and_relay_under_tmp_stay_visible(self):
        """A Python prefix and relay.py under the temp dir survive --tmpfs /tmp."""
        if not shutil.which('bwrap'):
            self.skipTest('bwrap is not on PATH')
        root = Path(tempfile.mkdtemp(prefix='esp32py-'))
        prefix = root / 'venv'
        (prefix / 'lib').mkdir(parents=True)
        marker = prefix / 'lib' / 'marker.txt'
        marker.write_text('prefix-visible\n')
        # A venv python is often a symlink. Binding it before --tmpfs /tmp
        # makes execvp fail with "No such file".
        exe = prefix / 'bin' / 'python'
        exe.parent.mkdir()
        exe.symlink_to(Path(sys.executable).resolve())
        app = root / 'app'
        app.mkdir()
        (app / 'relay.py').write_text('print("relay")\n')
        rundir = root / 'run'
        rundir.mkdir()
        saved_prefix = server.sys.prefix
        saved_exe = server.sys.executable
        saved_here = server.HERE
        fds = []
        try:
            server.sys.prefix = str(prefix)
            server.sys.executable = str(exe)
            server.HERE = app
            code = (
                'import pathlib\n'
                'marker = pathlib.Path(%r)\n'
                'relay = pathlib.Path(%r)\n'
                'print("MARKER", marker.read_text().strip() if marker.is_file() else "missing")\n'
                'print("RELAY", relay.read_text().splitlines()[0] if relay.is_file() else "missing")\n'
            ) % (str(marker), str(app / 'relay.py'))
            argv, held = server.qemu_sandbox_argv(
                [str(exe), '-c', code], {'PATH': '/usr/bin:/bin'}, rundir)
            self.assertIsNotNone(argv)
            fds.extend(held)
            tmpfs_at = argv.index('--tmpfs')
            self.assertLess(tmpfs_at, argv.index(str(prefix)))
            self.assertLess(tmpfs_at, argv.index(str(exe)))
            self.assertLess(tmpfs_at, argv.index(str(app / 'relay.py')))
            proc = subprocess.run(
                argv, pass_fds=tuple(held), capture_output=True, text=True, timeout=20,
                env=compileguard.host_sandbox_env())
            compileguard.close_fds(held)
            fds = []
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
            self.assertIn('MARKER prefix-visible', proc.stdout)
            self.assertIn('RELAY print("relay")', proc.stdout)
        finally:
            compileguard.close_fds(fds)
            server.sys.prefix = saved_prefix
            server.sys.executable = saved_exe
            server.HERE = saved_here
            shutil.rmtree(root, ignore_errors=True)

    def test_request_net_does_not_choose_the_stack(self):
        plan = server._compile_plan({
            'sketch': 'void setup(){}\nvoid loop(){}\n',
            'files': {},
            'net': 'lwip',
            'netShim': True,
        })
        self.assertIsInstance(plan, dict, getattr(plan, 'body', plan))
        self.assertIsNone(plan['netmode'])
        self.assertFalse(plan['net'])
        wifi = server._compile_plan({
            'sketch': '#include <WiFi.h>\nvoid setup(){}\nvoid loop(){}\n',
            'files': {},
            'net': 'shim',
        })
        self.assertEqual(wifi['netmode'], 'lwip')


if __name__ == '__main__':
    unittest.main()
