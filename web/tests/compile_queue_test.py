"""FIFO compile queue: different tabs wait, the same tab is still limited, cache hits do not wait."""
import asyncio, io, json, os, shutil, sys, tempfile, unittest
from contextlib import contextmanager, redirect_stdout
from pathlib import Path

os.environ.setdefault('SIM_PREWARM', '0')
os.environ.setdefault('SIM_NETSTACK_WARM', '0')
os.environ['SIM_COMPILE_QUEUE'] = '1'
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import diskkeep
import server
from starlette.requests import Request


def _sketch(tag):
    return {'sketch': 'void setup(){}\nvoid loop(){}\n// ' + tag, 'files': {}}


def _request(client_id):
    scope = {
        'type': 'http', 'asgi': {'version': '3.0'}, 'http_version': '1.1', 'method': 'GET',
        'scheme': 'http', 'path': '/api/compile/progress', 'raw_path': b'/api/compile/progress',
        'query_string': b'', 'headers': [(b'x-client-id', client_id.encode())],
        'client': ('127.0.0.1', 1), 'server': ('127.0.0.1', 80),
    }
    return Request(scope)


def _unpack(resp):
    if isinstance(resp, dict):
        return 200, resp
    return resp.status_code, json.loads(resp.body.decode())


@contextmanager
def _scratch():
    path = Path(tempfile.mkdtemp(prefix='esp32q-'))
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)


class CompileQueueTests(unittest.TestCase):
    def setUp(self):
        self._env = dict(os.environ)
        os.environ['SIM_COMPILE_QUEUE'] = '1'
        os.environ['SIM_COMPILE_QUEUE_MAX'] = '4'
        os.environ['SIM_COMPILE_QUEUE_TIMEOUT_S'] = '120'
        self._compile_in = server._compile_in
        self._prepare = diskkeep.prepare_for_compile
        self._forget = diskkeep.forget_sketch_builds_since
        self._work = diskkeep.request_build_dir
        diskkeep.prepare_for_compile = lambda **_k: None
        diskkeep.forget_sketch_builds_since = lambda *_a, **_k: None
        diskkeep.request_build_dir = _scratch
        self.gates = {}
        self.entered = []

        async def fake(_work, _bdir, key, sketch, _files, _defines, _net, _netmode, _simlibs):
            tag = sketch.rsplit('// ', 1)[-1].strip()
            self.entered.append(tag)
            await self.gates[tag].wait()
            return {'ok': True, 'id': key, 'log': tag}

        server._compile_in = fake

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._env)
        server._compile_in = self._compile_in
        diskkeep.prepare_for_compile = self._prepare
        diskkeep.forget_sketch_builds_since = self._forget
        diskkeep.request_build_dir = self._work
        server._netstack_warm_task = None
        server._lock_owner = None
        server._legacy_warm.clear()

    def _run(self, coro):
        async def wrapped():
            server._install_queue()
            server._legacy_warm.clear()
            server._netstack_warm_task = None
            server._lock_owner = None
            return await coro
        return asyncio.run(wrapped())

    def test_two_clients_the_same_tab_the_cap_and_a_cache_hit(self):
        self.gates = {'A': asyncio.Event(), 'B': asyncio.Event(), 'C': asyncio.Event(), 'HIT': asyncio.Event()}

        async def scenario():
            buf = io.StringIO()
            with redirect_stdout(buf):
                a = asyncio.create_task(server._compile_request(_sketch('A'), client_id='tab-a'))
                await self._until(lambda: self.entered == ['A'])
                b = asyncio.create_task(server._compile_request(_sketch('B'), client_id='tab-b'))
                await self._until(lambda: len(server._cqueue.waiters) == 1)
                view = await server.compile_progress(_request('tab-b'))
                self.assertEqual(view['wait']['reason'], 'build')
                self.assertEqual(view['wait']['position'], 1)
                self.assertIn('Waiting for another build to finish…', view['wait']['message'])
                self.assertIn('(position 1)', view['wait']['message'])
                rate_status, rate_body = _unpack(await server._compile_request(_sketch('A2'), client_id='tab-a'))
                self.assertEqual(rate_status, 429)
                self.assertEqual(rate_body['reason'], 'rate')
                self.assertEqual(rate_body['log'], 'another compile is running, retry shortly')
                os.environ['SIM_COMPILE_QUEUE_MAX'] = '1'
                full_status, full_body = _unpack(await server._compile_request(_sketch('C'), client_id='tab-c'))
                self.assertEqual(full_status, 429)
                self.assertEqual(full_body['reason'], 'full')
                self.assertEqual(full_body['log'], 'Server busy, 1 builds queued — try again shortly')
                os.environ['SIM_COMPILE_QUEUE_MAX'] = '4'
                hit = _sketch('HIT')
                plan = server._compile_plan(hit)
                plan['img'].parent.mkdir(parents=True, exist_ok=True)
                plan['img'].write_bytes(b'cached')
                cached_status, cached_body = _unpack(await server._compile_request(hit, client_id='tab-d'))
                self.assertEqual(cached_status, 200)
                self.assertTrue(cached_body['cached'])
                self.assertEqual(self.entered, ['A'])
                await asyncio.sleep(0.08)
                self.gates['A'].set()
                a_status, a_body = _unpack(await a)
                self.assertEqual(a_status, 200)
                self.assertEqual(a_body['log'], 'A')
                await self._until(lambda: self.entered == ['A', 'B'])
                self.gates['B'].set()
                b_status, b_body = _unpack(await b)
                self.assertEqual(b_status, 200)
                self.assertEqual(b_body['log'], 'B')
            self.assertIn('waited ', buf.getvalue())
            self.assertIn(' for build', buf.getvalue())

        self._run(scenario())

    def test_queue_timeout_and_warmup_wait(self):
        self.gates = {'HOLD': asyncio.Event(), 'WARM': asyncio.Event(), 'USER': asyncio.Event()}
        os.environ['SIM_COMPILE_QUEUE_TIMEOUT_S'] = '0.3'

        async def scenario():
            buf = io.StringIO()
            with redirect_stdout(buf):
                hold = asyncio.create_task(server._compile_request(_sketch('HOLD'), client_id='tab-hold'))
                await self._until(lambda: self.entered == ['HOLD'])
                timed = asyncio.create_task(server._compile_request(_sketch('LATE'), client_id='tab-late'))
                status, body = _unpack(await asyncio.wait_for(timed, 2))
                self.assertEqual(status, 429)
                self.assertEqual(body['reason'], 'timeout')
                self.assertIn('Timed out waiting for a build slot', body['log'])
                self.assertIn(' for build', buf.getvalue())
                self.gates['HOLD'].set()
                await hold

                async def warm():
                    server._netstack_warm_task = asyncio.current_task()
                    try:
                        return await server._compile_request(_sketch('WARM'), queue=True)
                    finally:
                        server._netstack_warm_task = None
                        await server._cqueue.kick()

                warm_task = asyncio.create_task(warm())
                await self._until(lambda: 'WARM' in self.entered)
                user = asyncio.create_task(server._compile_request(_sketch('USER'), client_id='learner'))
                await self._until(lambda: any(w['id'] == 'learner' for w in server._cqueue.waiters))
                progress = await server.compile_progress(_request('learner'))
                self.assertEqual(progress['wait']['reason'], 'warm-up')
                self.assertEqual(progress['wait']['message'],
                                 'Preparing network stack (first run after restart), about 40 s…')
                await asyncio.sleep(0.08)
                self.gates['WARM'].set()
                await warm_task
                await self._until(lambda: 'USER' in self.entered)
                self.gates['USER'].set()
                user_status, user_body = _unpack(await user)
                self.assertEqual(user_status, 200)
                self.assertEqual(user_body['log'], 'USER')
            self.assertIn(' for warm-up', buf.getvalue())

        self._run(scenario())

    def test_flag_off_restores_the_429(self):
        os.environ['SIM_COMPILE_QUEUE'] = '0'
        self.gates = {'ONE': asyncio.Event()}

        async def scenario():
            first = asyncio.create_task(server._compile_request(_sketch('ONE'), client_id='tab-a'))
            await self._until(lambda: self.entered == ['ONE'])
            status, body = _unpack(await server._compile_request(_sketch('TWO'), client_id='tab-b'))
            self.assertEqual(status, 429)
            self.assertEqual(body['log'], 'another compile is running, retry shortly')
            self.assertNotIn('wait', body)
            self.gates['ONE'].set()
            await first

        self._run(scenario())

    async def _until(self, pred):
        for _ in range(100):
            if pred():
                return
            await asyncio.sleep(0.01)
        self.fail('condition was not met')


if __name__ == '__main__':
    unittest.main()
