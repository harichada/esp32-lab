"""The QEMU run command caps the block thread pool unless the flag is 0."""
import os
import sys
import unittest
from pathlib import Path

os.environ.setdefault('SIM_PREWARM', '0')
os.environ.setdefault('SIM_NETSTACK_WARM', '0')
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import server


def _run_argv(env):
    """The same splice ``_qemu_session`` uses, with stand-in paths."""
    extra = server.qemu_thread_pool_object(env)
    return [
        'qemu-system-xtensa', '-display', 'none', '-machine', 'esp32', *extra,
        '-drive', 'file=flash.bin,if=mtd,format=raw',
        '-chardev', 'socket,id=ser,path=ser.sock', '-serial', 'chardev:ser',
        '-L', 'rom', '-monitor', 'none',
    ]


class QemuThreadPoolTests(unittest.TestCase):
    def test_default_adds_a_pool_of_8(self):
        env = {}
        self.assertTrue(server.qemu_thread_pool_enabled(env))
        self.assertEqual(server.qemu_thread_pool_max(env), 8)
        argv = _run_argv(env)
        self.assertEqual(
            argv[argv.index('-machine') + 2:argv.index('-machine') + 4],
            ['-object', 'main-loop,id=ml,thread-pool-min=0,thread-pool-max=8'])

    def test_flag_0_is_the_old_command_line(self):
        env = {'QEMU_THREAD_POOL_CAP_ENABLED': '0', 'SIM_QEMU_THREAD_POOL_MAX': '1'}
        self.assertFalse(server.qemu_thread_pool_enabled(env))
        self.assertEqual(server.qemu_thread_pool_object(env), [])
        argv = _run_argv(env)
        self.assertNotIn('-object', argv)
        self.assertNotIn('main-loop', ' '.join(argv))
        self.assertEqual(argv, [
            'qemu-system-xtensa', '-display', 'none', '-machine', 'esp32',
            '-drive', 'file=flash.bin,if=mtd,format=raw',
            '-chardev', 'socket,id=ser,path=ser.sock', '-serial', 'chardev:ser',
            '-L', 'rom', '-monitor', 'none',
        ])

    def test_only_exact_zero_turns_the_cap_off(self):
        for raw in ('', '1', 'on', 'true', '00', 'false', ' 1 '):
            self.assertTrue(
                server.qemu_thread_pool_enabled({'QEMU_THREAD_POOL_CAP_ENABLED': raw}), raw)
        self.assertFalse(server.qemu_thread_pool_enabled({'QEMU_THREAD_POOL_CAP_ENABLED': ' 0 '}))

    def test_max_keeps_1_through_64_and_rejects_the_rest(self):
        self.assertEqual(server.qemu_thread_pool_max({'SIM_QEMU_THREAD_POOL_MAX': '1'}), 1)
        self.assertEqual(server.qemu_thread_pool_max({'SIM_QEMU_THREAD_POOL_MAX': '64'}), 64)
        self.assertEqual(server.qemu_thread_pool_max({'SIM_QEMU_THREAD_POOL_MAX': ' 12 '}), 12)
        for raw in ('0', '65', '-1', '8.5', 'nope', '', '  '):
            self.assertEqual(
                server.qemu_thread_pool_max({'SIM_QEMU_THREAD_POOL_MAX': raw}), 8, raw)
        argv = _run_argv({'SIM_QEMU_THREAD_POOL_MAX': '3'})
        self.assertIn('main-loop,id=ml,thread-pool-min=0,thread-pool-max=3', argv)

    def test_the_session_splices_the_same_object(self):
        text = Path(server.__file__).read_text()
        self.assertIn(
            "*qemu_thread_pool_object()",
            text,
        )
        self.assertIn(
            "'-machine', 'esp32', *qemu_thread_pool_object()",
            text,
        )


if __name__ == '__main__':
    unittest.main()
