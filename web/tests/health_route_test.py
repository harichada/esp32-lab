"""GET /api/health is a cached snapshot. It does not touch disk or the toolchain."""
import os
import sys
import unittest
from pathlib import Path

os.environ.setdefault('SIM_PREWARM', '0')
os.environ.setdefault('SIM_NETSTACK_WARM', '0')
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import server
from starlette.testclient import TestClient


class HealthRouteTests(unittest.TestCase):
    def test_health_route_is_cheap_and_not_stored(self):
        hits = []
        orig_health = server.health
        orig_qemu = server.qemu_ready
        orig_sand = server.compileguard.sandbox_ok
        orig_exists = Path.exists

        def health():
            hits.append('health')
            return orig_health()

        def qemu_ready():
            hits.append('qemu')
            return orig_qemu()

        def sandbox_ok():
            hits.append('sandbox')
            return orig_sand()

        def exists(self, *args, **kwargs):
            hits.append('exists:' + self.name)
            return orig_exists(self, *args, **kwargs)

        server.health = health
        server.qemu_ready = qemu_ready
        server.compileguard.sandbox_ok = sandbox_ok
        Path.exists = exists
        try:
            resp = TestClient(server.app).get('/api/health')
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(resp.headers.get('cache-control'), 'no-store')
            self.assertIn('ok', resp.json())
            self.assertNotIn('health', hits)
            self.assertNotIn('qemu', hits)
            self.assertNotIn('sandbox', hits)
            disk = [hit for hit in hits if hit.startswith('exists:')]
            self.assertEqual(disk, [])
        finally:
            server.health = orig_health
            server.qemu_ready = orig_qemu
            server.compileguard.sandbox_ok = orig_sand
            Path.exists = orig_exists


if __name__ == '__main__':
    unittest.main()
