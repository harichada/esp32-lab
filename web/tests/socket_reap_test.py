"""A dropped run socket must kill and reap that run's QEMU process group."""
import asyncio
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
from fastapi import WebSocketDisconnect


def _alive(pid):
    stat = Path(f'/proc/{pid}/stat')
    if not stat.exists():
        return False
    # A zombie is already dead; init reaps it after the parent is gone.
    state = stat.read_text().rsplit(')', 1)[-1].split()[0]
    return state not in ('Z', 'X')


class SocketCloseReapsQemuTests(unittest.TestCase):
    def _group(self):
        child_file = tempfile.NamedTemporaryFile('r', delete=False)
        child_file.close()
        code = textwrap.dedent('''
            import subprocess, sys, time
            child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
            open(sys.argv[1], "w").write(str(child.pid))
            time.sleep(60)
        ''')
        proc = subprocess.Popen(
            [sys.executable, '-c', code, child_file.name],
            start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 3
        grandchild = 0
        while time.monotonic() < deadline:
            text = Path(child_file.name).read_text() or ''
            if text.strip().isdigit():
                grandchild = int(text.strip())
                if _alive(grandchild):
                    break
            time.sleep(0.02)
        self.assertGreater(grandchild, 0)
        return proc, grandchild, child_file.name

    def _wrap(self, proc):
        link = server.Link('reap-test')
        link.qemu = server._QemuProc(proc)
        return link

    def test_close_1001_kills_and_reaps_the_group(self):
        proc, grandchild, path = self._group()
        link = self._wrap(proc)

        class Closing:
            async def receive_json(self):
                raise WebSocketDisconnect(code=1001)

        ws = Closing()
        link.ws = ws
        try:
            asyncio.run(link.read(ws))
            self.assertIsNotNone(proc.poll())
            self.assertFalse(_alive(grandchild))
            self.assertFalse(_alive(proc.pid))
        finally:
            Path(path).unlink(missing_ok=True)
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=2)

    def test_socket_error_kills_the_group(self):
        proc, grandchild, path = self._group()
        link = self._wrap(proc)

        class Broken:
            async def receive_json(self):
                raise ConnectionResetError('reset')

        ws = Broken()
        link.ws = ws
        try:
            asyncio.run(link.read(ws))
            self.assertIsNotNone(proc.poll())
            self.assertFalse(_alive(grandchild))
        finally:
            Path(path).unlink(missing_ok=True)
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=2)

    def test_a_replaced_socket_does_not_kill_the_run(self):
        proc, grandchild, path = self._group()
        link = self._wrap(proc)
        link.ws = object()

        class Closing:
            async def receive_json(self):
                raise WebSocketDisconnect(code=1001)

        try:
            asyncio.run(link.read(Closing()))
            self.assertIsNone(proc.poll())
            self.assertTrue(_alive(grandchild))
        finally:
            Path(path).unlink(missing_ok=True)
            link.reap_qemu  # attribute exists
            asyncio.run(link.reap_qemu())
