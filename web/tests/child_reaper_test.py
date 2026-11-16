"""Orphaned sandbox children are collected, and a real subprocess keeps its exit code.

bwrap's intermediate process exits and the sandbox child is reparented to
PID 1. In the container that PID is this server, so the child stays defunct
unless we wait for it. The reaper must not be the thing that collects a
Popen or asyncio child: that would throw the exit status away.
"""
import os
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path

os.environ['SIM_PREWARM'] = '0'
os.environ['SIM_NETSTACK_WARM'] = '0'
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))

import server

ORPHAN = textwrap.dedent(r'''
    import os, sys, time
    path = sys.argv[1]
    child = os.fork()
    if child == 0:
        grand = os.fork()
        if grand == 0:
            with open(path, 'w') as fh:
                fh.write(str(os.getpid()))
            time.sleep(0.4)
            os._exit(0)
        os._exit(0)
    os.waitpid(child, 0)
''')


def _state(pid):
    stat = Path('/proc') / str(pid) / 'stat'
    try:
        text = stat.read_text()
    except OSError:
        return ''
    # The comm field is in parentheses and may contain spaces. State follows it.
    return text.rsplit(')', 1)[-1].split()[0]


class ChildReaperTests(unittest.TestCase):
    def test_a_subprocess_exit_code_survives_the_reaper(self):
        proc = subprocess.run(
            [sys.executable, '-c', 'import time, sys; time.sleep(0.8); sys.exit(3)'],
            timeout=5)
        self.assertEqual(proc.returncode, 3)
        failed = subprocess.Popen([sys.executable, '-c', 'import sys; sys.exit(5)'])
        self.assertEqual(failed.wait(timeout=5), 5)

    def test_an_orphaned_grandchild_does_not_stay_defunct(self):
        root = Path(tempfile.mkdtemp(prefix='esp32reap-'))
        pidfile = root / 'grand.pid'
        proc = subprocess.run([sys.executable, '-c', ORPHAN, str(pidfile)], timeout=5)
        self.assertEqual(proc.returncode, 0, 'the parent of the orphan did not exit')
        self.assertTrue(pidfile.exists(), 'the grandchild never wrote its pid')
        pid = int(pidfile.read_text().strip())
        deadline = time.monotonic() + 3
        state = _state(pid)
        while time.monotonic() < deadline:
            server.reap_orphans()
            state = _state(pid)
            if state != 'Z':
                break
            time.sleep(0.1)
        self.assertNotEqual(state, 'Z', 'pid %s is still defunct' % pid)


if __name__ == '__main__':
    unittest.main()
