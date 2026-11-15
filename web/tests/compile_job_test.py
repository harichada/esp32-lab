"""Each compile keeps its own output.

stdout and stderr are read as separate pipes, so a GCC diagnostic stays a whole
line instead of being spliced into arduino-cli's FQBN banner. A line is kept
only while its progress record is still current.
"""
import asyncio
import os
import sys
import unittest
from pathlib import Path

os.environ.setdefault('SIM_PREWARM', '0')
os.environ.setdefault('SIM_NETSTACK_WARM', '0')
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import server

ERR = "sketch.ino.cpp:4:3: error: 'led' was not declared in this scope\n"
FQBN = 'FQBN: esp32:esp32:esp32doit-devkit-v1\n'
SUMMARY = 'Compilation error: exit status 1\n'


class FakeStream:
    def __init__(self, lines):
        self.lines = [ln if isinstance(ln, bytes) else ln.encode() for ln in lines]

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self.lines:
            raise StopAsyncIteration
        return self.lines.pop(0)


class CompileJobTests(unittest.TestCase):
    def setUp(self):
        self.ids = []

    def tearDown(self):
        for pid in self.ids:
            server._drop_progress(pid)

    def _record(self, client):
        rec = server._new_progress(client, '')
        self.ids.append(rec['id'])
        return rec

    def test_same_undeclared_error_twenty_times(self):
        stdout_orders = [
            [FQBN, SUMMARY],
            [SUMMARY, FQBN],
            [FQBN, 'Used library Version\n'],
            ['Compiling sketch...\n', FQBN, SUMMARY],
        ]
        stderr_orders = [
            [ERR],
            [ERR, SUMMARY],
            [SUMMARY, ERR],
            [ERR],
        ]

        async def once(i):
            rec = self._record('undeclared%02dxx' % i)
            token = server._progress_ctx.set(rec)
            captured = server.compileguard.OutputCap(200000)
            try:
                await asyncio.gather(
                    server._absorb_compile_stream(FakeStream(stdout_orders[i % 4]), captured, ''),
                    server._absorb_compile_stream(FakeStream(stderr_orders[i % 4]), captured, ''),
                )
            finally:
                server._progress_ctx.reset(token)
            return captured.text()

        async def each():
            out = []
            for i in range(20):
                out.append(await once(i))
            return out

        logs = asyncio.run(each())
        self.assertEqual(len(logs), 20)
        for text in logs:
            diags = [ln for ln in text.splitlines() if ': error:' in ln]
            self.assertEqual(diags, ["sketch.ino.cpp:4:3: error: 'led' was not declared in this scope"])
            self.assertFalse(any(ln.startswith('FQBN:') and 'error:' in ln for ln in text.splitlines()))

    def test_overlapping_compiles_keep_their_own_sketch(self):
        err_a = "sketch.ino.cpp:4:3: error: 'ledA' was not declared in this scope\n"
        err_b = "sketch.ino.cpp:8:5: error: 'ledB' was not declared in this scope\n"

        async def go():
            rec_a = self._record('client-a-aaaa')
            rec_b = self._record('client-b-bbbb')
            cap_a = server.compileguard.OutputCap(200000)
            cap_b = server.compileguard.OutputCap(200000)
            token = server._progress_ctx.set(rec_a)
            try:
                await server._absorb_compile_stream(FakeStream([FQBN, err_a]), cap_a, '')
            finally:
                server._progress_ctx.reset(token)
            token = server._progress_ctx.set(rec_b)
            try:
                await server._absorb_compile_stream(FakeStream([SUMMARY, err_b]), cap_b, '')
            finally:
                server._progress_ctx.reset(token)
            late = "sketch.ino.cpp:9:1: error: 'lateLine' was not declared in this scope\n"

            class SwitchStream(FakeStream):
                def __init__(self):
                    super().__init__([err_a, late])
                    self.n = 0

                async def __anext__(self):
                    if self.n == 1:
                        server._progress_ctx.set(rec_b)
                    self.n += 1
                    return await super().__anext__()

            token = server._progress_ctx.set(rec_a)
            try:
                await server._absorb_compile_stream(SwitchStream(), cap_a, '')
            finally:
                server._progress_ctx.reset(token)
            return cap_a.text(), cap_b.text(), rec_a, rec_b

        text_a, text_b, rec_a, rec_b = asyncio.run(go())
        self.assertIn("'ledA'", text_a)
        self.assertNotIn('lateLine', text_a)
        self.assertNotIn("'ledB'", text_a)
        self.assertIn("'ledB'", text_b)
        self.assertNotIn("'ledA'", text_b)
        body_a = server._progress_body(rec_a, 0)
        body_b = server._progress_body(rec_b, 0)
        self.assertTrue(body_a['log'].startswith('# job %s\n' % rec_a['id']))
        self.assertIn('FQBN', body_a['log'])
        self.assertNotIn('ledB', body_a['log'])
        self.assertIn('ledB', body_b['log'])
        self.assertNotIn('ledA', body_b['log'])
        self.assertNotEqual(body_a['compile_id'], body_b['compile_id'])


if __name__ == '__main__':
    unittest.main()
