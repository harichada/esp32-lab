"""A blocked connect returns within 6 s and the caller keeps going.

The ESP32 guest is not executed here: this machine has no qemu-system-xtensa and
no ESP32 toolchain. The C program is the same 3 s non-blocking cap the QemuEth
shim uses, aimed at 192.0.2.1:80 (an address that does not answer).
"""
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / 'failfast_connect.c'
SHIM = ROOT.parents[0] / 'server' / 'shims' / 'QemuEth' / 'src' / 'qemu_eth.cpp'
PROBE = ROOT / 'sketches' / 'egress_probe' / 'egress_probe.ino'


class ConnectFailFastTests(unittest.TestCase):
    def test_shim_caps_every_connect(self):
        text = SHIM.read_text(encoding='utf-8')
        self.assertIn('kConnectFailFastSec = 3', text)
        self.assertIn('connect_failfast', text)
        wrap = text.split('__wrap_lwip_connect', 1)[1]
        self.assertNotIn('__real_lwip_connect', wrap)
        self.assertEqual(wrap.count('connect_failfast'), 2)

    def test_blocked_connect_fails_within_six_seconds_and_continues(self):
        binary = ROOT / 'failfast_connect'
        build = subprocess.run(
            ['gcc', '-O2', '-Wall', '-Wextra', '-o', str(binary), str(SRC)],
            capture_output=True, text=True, timeout=30)
        self.assertEqual(build.returncode, 0, build.stderr)
        try:
            proc = subprocess.run([str(binary)], capture_output=True, text=True, timeout=6)
        finally:
            binary.unlink(missing_ok=True)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn('BLOCKED', proc.stdout)
        self.assertIn('CONTINUE', proc.stdout)
        self.assertIn('STILL_RUNNING', proc.stdout)
        self.assertNotIn('OPEN', proc.stdout)
        elapsed = next(int(line.split()[1]) for line in proc.stdout.splitlines() if line.startswith('ELAPSED_MS'))
        self.assertLess(elapsed, 6000)
        self.assertGreaterEqual(elapsed, 0)

    def test_egress_probe_lists_five_targets(self):
        text = PROBE.read_text(encoding='utf-8')
        for target in ('169.254.169.254', '10.0.2.2', '192.168.1.1', '1.1.1.1', 'SIM_EGRESS_HOST'):
            self.assertIn(target, text)
        self.assertIn('EGRESS DONE', text)
        self.assertIn('BLOCKED', text)
        self.assertIn('SIM_NO_LAN_REMAP', text)
        self.assertIn('WiFi.begin("SIM-GUEST"', text)


if __name__ == '__main__':
    unittest.main()
