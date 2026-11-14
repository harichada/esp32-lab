"""A compile that overruns its deadline returns 504, frees the slot, and leaves no children."""
import asyncio, json, os, signal, sys, tempfile, time, unittest, uuid
from pathlib import Path

os.environ.setdefault('SIM_PREWARM', '0')
os.environ.setdefault('SIM_NETSTACK_WARM', '0')
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import diskkeep
import server

STUB = r'''#!/usr/bin/env python3
import os, signal, sys, time
from pathlib import Path

mode = os.environ.get("COMPILE_STUB_MODE", "sleep")
if mode == "ok":
    args = sys.argv
    out = Path(args[args.index("--output-dir") + 1])
    out.mkdir(parents=True, exist_ok=True)
    (out / "sketch.ino.merged.bin").write_bytes(bytes([0xE9]) + b"\xff" * 32)
    raise SystemExit(0)

signal.signal(signal.SIGTERM, signal.SIG_IGN)
child = os.fork()
if child == 0:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    time.sleep(300)
    os._exit(0)
pidfile = os.environ.get("COMPILE_STUB_PIDFILE", "")
if pidfile:
    Path(pidfile).write_text("%d %d\n" % (os.getpid(), child))
sys.stdout.write("stub sleeping\n")
sys.stdout.flush()
time.sleep(300)
'''

KEEP_HEALTH = ('ok', 'qemu', 'arduino_cli', 'fqbn', 'runs', 'notes')


def _sketch(tag):
    return {'sketch': 'void setup(){}\nvoid loop(){}\n// ' + tag, 'files': {}}


def _unpack(resp):
    if isinstance(resp, dict):
        return 200, resp
    return resp.status_code, json.loads(resp.body.decode())


def _proc_state(pid):
    try:
        raw = Path('/proc/%d/stat' % pid).read_text()
    except OSError:
        return None
    cut = raw.rfind(')')
    if cut < 0:
        return None
    fields = raw[cut + 2:].split()
    return fields[0] if fields else None


def _group_members(pgid):
    found = []
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            raw = (entry / 'stat').read_text()
        except OSError:
            continue
        cut = raw.rfind(')')
        if cut < 0:
            continue
        fields = raw[cut + 2:].split()
        try:
            if int(fields[2]) == pgid:
                found.append(int(entry.name))
        except (IndexError, ValueError):
            continue
    return found


class CompileTimeoutTests(unittest.TestCase):
    def setUp(self):
        self._env = dict(os.environ)
        self._cli = server.CLI
        self._prepare = diskkeep.prepare_for_compile
        self._forget = diskkeep.forget_sketch_builds_since
        os.environ['SIM_COMPILE_QUEUE'] = '1'
        os.environ['SIM_COMPILE_QUEUE_MAX'] = '4'
        os.environ['SIM_COMPILE_QUEUE_TIMEOUT_S'] = '30'
        os.environ['SIM_COMPILE_ENFORCE_TIMEOUT'] = '1'
        diskkeep.prepare_for_compile = lambda **_k: None
        diskkeep.forget_sketch_builds_since = lambda *_a, **_k: None
        server._compile_worker_clear()
        server._compile_timeout_at = None
        self._pids = []

    def tearDown(self):
        for pid in self._pids:
            if pid <= 0 or pid == os.getpgrp():
                continue
            try:
                os.killpg(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError, OSError):
                try:
                    os.kill(pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError, OSError):
                    pass
        os.environ.clear()
        os.environ.update(self._env)
        server.CLI = self._cli
        diskkeep.prepare_for_compile = self._prepare
        diskkeep.forget_sketch_builds_since = self._forget
        server._compile_worker_clear()
        server._compile_timeout_at = None
        server._netstack_warm_task = None
        server._lock_owner = None
        server._legacy_warm.clear()
        server.PROGRESS['active'] = False

    def _run(self, coro):
        async def wrapped():
            server._install_queue()
            server._legacy_warm.clear()
            server._netstack_warm_task = None
            server._lock_owner = None
            server._compile_worker_clear()
            server._compile_timeout_at = None
            return await coro
        return asyncio.run(wrapped())

    def test_timeout_env_falls_back_to_300(self):
        os.environ.pop('SIM_COMPILE_TIMEOUT', None)
        self.assertEqual(server._compile_timeout_s(), 300.0)
        for bad in ('', 'nope', '-1', '0', 'nan', 'NaN'):
            os.environ['SIM_COMPILE_TIMEOUT'] = bad
            self.assertEqual(server._compile_timeout_s(), 300.0, bad)
        os.environ['SIM_COMPILE_TIMEOUT'] = '12.5'
        self.assertEqual(server._compile_timeout_s(), 12.5)
        os.environ.pop('SIM_COMPILE_KILL_GRACE_S', None)
        self.assertEqual(server._compile_kill_grace_s(), 2.0)
        os.environ['SIM_COMPILE_KILL_GRACE_S'] = '999'
        self.assertEqual(server._compile_kill_grace_s(), 30.0)
        os.environ['SIM_COMPILE_KILL_GRACE_S'] = '-4'
        self.assertEqual(server._compile_kill_grace_s(), 2.0)
        os.environ.pop('SIM_COMPILE_ENFORCE_TIMEOUT', None)
        self.assertTrue(server._compile_timeout_enforced())
        for safe in ('', '1', 'yes', 'true', 'on', '2', 'nope'):
            os.environ['SIM_COMPILE_ENFORCE_TIMEOUT'] = safe
            self.assertTrue(server._compile_timeout_enforced(), safe)
        os.environ['SIM_COMPILE_ENFORCE_TIMEOUT'] = '0'
        self.assertFalse(server._compile_timeout_enforced())
        os.environ['SIM_COMPILE_ENFORCE_TIMEOUT'] = ' 0 '
        self.assertFalse(server._compile_timeout_enforced())

    def test_sleeping_compiler_times_out_frees_the_slot_and_leaves_no_children(self):
        timeout = 0.35
        grace = 0.45
        root = Path(tempfile.mkdtemp(prefix='esp32to-'))
        script = root / 'compiler'
        pidfile = root / 'pids'
        script.write_text(STUB)
        script.chmod(0o755)
        server.CLI = str(script)
        os.environ['SIM_COMPILE_TIMEOUT'] = str(timeout)
        os.environ['SIM_COMPILE_KILL_GRACE_S'] = str(grace)
        os.environ['COMPILE_STUB_MODE'] = 'sleep'
        os.environ['COMPILE_STUB_PIDFILE'] = str(pidfile)

        async def scenario():
            seen = {}

            async def watch():
                for _ in range(400):
                    if server._compile_worker_deadline is not None:
                        break
                    await asyncio.sleep(0.005)
                else:
                    seen['started'] = False
                    return
                seen['started'] = True
                remaining = server._compile_worker_deadline - time.monotonic()
                seen['early'] = server.health()
                seen['early_remaining'] = remaining
                await asyncio.sleep(max(0.0, remaining) + 0.05)
                seen['mid'] = server.health()

            base = server.health()
            watcher = asyncio.create_task(watch())
            t0 = time.monotonic()
            slow = asyncio.create_task(server._compile_request(_sketch('sleep-timeout'), client_id='tab-slow'))
            try:
                status, body = _unpack(await asyncio.wait_for(slow, timeout + grace + 2))
            finally:
                elapsed = time.monotonic() - t0
                await watcher
            after = server.health()
            locked = server._compile_lock.locked()
            granted = server._cqueue.granted
            os.environ['COMPILE_STUB_MODE'] = 'ok'
            # A fresh sketch so a firmware image left on disk cannot answer as a cache hit.
            status2, body2 = _unpack(await asyncio.wait_for(
                server._compile_request(_sketch('ok-next-' + uuid.uuid4().hex), client_id='tab-next'), 5))
            recovered = server.health()
            locked2 = server._compile_lock.locked()
            return {
                'base': base, 'seen': seen, 'status': status, 'body': body, 'elapsed': elapsed,
                'after': after, 'locked': locked, 'granted': granted,
                'status2': status2, 'body2': body2, 'recovered': recovered, 'locked2': locked2,
            }

        result = self._run(scenario())
        base, seen = result['base'], result['seen']
        status, body, elapsed = result['status'], result['body'], result['elapsed']
        self.assertTrue(seen.get('started'), 'compile worker never started')
        self.assertEqual(status, 504, body)
        self.assertFalse(body['ok'])
        self.assertEqual(body['reason'], 'timeout')
        self.assertEqual(body['log'], server.COMPILE_TIMEOUT_USER_MESSAGE)
        self.assertGreaterEqual(elapsed, timeout)
        self.assertLess(elapsed, timeout + grace + 0.6, 'timeout response was not prompt')

        if seen.get('early_remaining', 0) > 0.05:
            self.assertTrue(seen['early']['compile_ok'])
            self.assertFalse(seen['early']['degraded'])
            self.assertIsNone(seen['early']['compile_timeout_at'])
        mid = seen['mid']
        self.assertFalse(mid['compile_ok'])
        self.assertTrue(mid['degraded'])
        self.assertIsInstance(mid['ok'], bool)
        self.assertIsInstance(mid['compile_timeout_at'], float)
        self.assertAlmostEqual(mid['compile_timeout_at'], time.time(), delta=5)
        for key in KEEP_HEALTH:
            self.assertEqual(mid[key], base[key], key)
            self.assertIn(key, base)

        self.assertTrue(pidfile.is_file(), 'sleeper did not record its process group')
        parent_s, child_s = pidfile.read_text().split()
        parent, child = int(parent_s), int(child_s)
        self._pids.extend((parent, child))
        self.assertNotEqual(parent, child)
        deadline = time.time() + 1.0
        running = [parent, child]
        while time.time() < deadline:
            running = [pid for pid in (parent, child) if _proc_state(pid) not in (None, 'Z')]
            running += [pid for pid in _group_members(parent) if _proc_state(pid) not in (None, 'Z')]
            if not running:
                break
            time.sleep(0.02)
        self.assertEqual(running, [], 'orphan compile processes still running')

        after = result['after']
        self.assertTrue(after['compile_ok'])
        self.assertFalse(after['degraded'])
        self.assertEqual(after['compile_timeout_at'], mid['compile_timeout_at'])
        for key in KEEP_HEALTH:
            self.assertEqual(after[key], base[key], key)
        self.assertFalse(result['locked'])
        self.assertIsNone(result['granted'])

        self.assertEqual(result['status2'], 200, result['body2'])
        self.assertTrue(result['body2']['ok'], result['body2'])
        self.assertFalse(result['body2'].get('cached'))
        recovered = result['recovered']
        self.assertTrue(recovered['compile_ok'])
        self.assertFalse(recovered['degraded'])
        self.assertEqual(recovered['compile_timeout_at'], mid['compile_timeout_at'])
        for key in KEEP_HEALTH:
            self.assertEqual(recovered[key], base[key], key)
        self.assertFalse(result['locked2'])


if __name__ == '__main__':
    unittest.main()
