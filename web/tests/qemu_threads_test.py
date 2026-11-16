"""QEMU's worker pool must stay under a low process limit.

The bundled QEMU is 9.2, whose main-loop object takes thread-pool-max. The
default pool is 64, the same as SIM_SANDBOX_NPROC, so one extra thread aborts
with qemu_thread_create: Resource temporarily unavailable (exit 134). This
stand-in reads the cap the server puts on the command line and creates that
many threads under a real RLIMIT_NPROC just above the threads already running.
"""
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

os.environ['SIM_PREWARM'] = '0'
os.environ['SIM_NETSTACK_WARM'] = '0'
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))

import server

SCRIPT = textwrap.dedent(r'''
    import os, sys, threading, resource
    if '--version' in sys.argv:
        sys.stdout.write('QEMU emulator version 9.2.2\n')
        raise SystemExit(0)
    if '-object' in sys.argv and 'help' in sys.argv:
        sys.stdout.write('main-loop\nthread-pool-max\n')
        raise SystemExit(0)
    text = ' '.join(sys.argv)
    cap = 64
    key = 'thread-pool-max='
    if key in text:
        cap = int(text.split(key, 1)[1].split(',', 1)[0].split()[0])
    def user_tasks():
        # RLIMIT_NPROC counts this uid's tasks on the whole host. Counting
        # every task we can see in /proc made the limit higher than this
        # user's usage, so a 64-thread pool still fitted.
        uid = os.getuid()
        total = 0
        for name in os.listdir('/proc'):
            if not name.isdigit():
                continue
            try:
                if os.stat('/proc/' + name).st_uid != uid:
                    continue
                total += len(os.listdir('/proc/' + name + '/task'))
            except OSError:
                continue
        return total
    n = user_tasks()
    # Room for the capped pool (8) and a little noise. The old default of 64
    # does not fit, which is the abort this cap exists to stop.
    headroom = 40
    limit = n + headroom
    _soft, hard = resource.getrlimit(resource.RLIMIT_NPROC)
    if hard != resource.RLIM_INFINITY and limit > hard:
        limit = hard
    resource.setrlimit(resource.RLIMIT_NPROC, (limit, hard))
    if cap <= 8:
        live = user_tasks()
        if limit < live + cap + 4:
            want = live + headroom
            if hard == resource.RLIM_INFINITY or want <= hard:
                resource.setrlimit(resource.RLIMIT_NPROC, (want, hard))
    def hold():
        threading.Event().wait(30)
    try:
        threads = []
        for _ in range(cap):
            t = threading.Thread(target=hold, daemon=True)
            t.start()
            threads.append(t)
    except (RuntimeError, OSError):
        sys.stderr.write('qemu_thread_create: Resource temporarily unavailable\n')
        raise SystemExit(134)
    if len(threads) < cap:
        sys.stderr.write('qemu_thread_create: Resource temporarily unavailable\n')
        raise SystemExit(134)
    sys.stdout.write('ok cap=%d limit=%d\n' % (cap, limit))
    raise SystemExit(0)
''')


class QemuThreadPoolTests(unittest.TestCase):
    def test_main_loop_cap_passes_under_a_low_process_limit(self):
        root = Path(tempfile.mkdtemp(prefix='esp32qthread-'))
        script = root / 'qemu-system-xtensa'
        script.write_text('#!/usr/bin/env python3\n' + SCRIPT)
        script.chmod(0o755)
        server._thread_pool_kind.pop(str(script), None)
        kind = server.qemu_thread_pool_kind(str(script))
        self.assertEqual(kind, 'main-loop')
        extra = server.qemu_thread_pool_args(str(script))
        self.assertEqual(extra, ['-object', 'main-loop,id=ml,thread-pool-max=8'])
        capped = subprocess.run(
            [sys.executable, str(script), *extra, '-display', 'none'],
            capture_output=True, text=True, timeout=20)
        self.assertEqual(capped.returncode, 0, capped.stderr)
        self.assertNotIn('Resource temporarily unavailable', capped.stderr)
        self.assertIn('cap=8', capped.stdout)
        hostile = subprocess.run(
            [sys.executable, str(script), '-display', 'none'],
            capture_output=True, text=True, timeout=20)
        self.assertEqual(hostile.returncode, 134, hostile.stdout + hostile.stderr)
        self.assertIn('Resource temporarily unavailable', hostile.stderr)


if __name__ == '__main__':
    unittest.main()
