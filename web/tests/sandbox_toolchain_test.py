"""A fresh sketch compiled inside bubblewrap with the real ESP32 toolchain.

This is the path ``POST /api/compile`` uses (``server._compile_in``), not a
stand-in runner. It skips only when bwrap or the toolchain is absent, and the
skip message names the missing piece. ``SIM_REQUIRE_TOOLCHAIN_TEST=1`` turns
that into a failure.

    cd web && SIM_REQUIRE_TOOLCHAIN_TEST=1 python3 -m unittest tests.sandbox_toolchain_test -v
"""

import asyncio
import contextlib
import io
import os
import shutil
import struct
import sys
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault('SIM_PREWARM', '0')
os.environ.setdefault('SIM_NETSTACK_WARM', '0')
os.environ.setdefault('SIM_COMPILE_TIMEOUT', '900')
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import compileguard
import server

EM_XTENSA = 94


def _arduino_cli() -> Path | None:
    raw = (os.environ.get('ARDUINO_CLI') or '').strip()
    if raw and Path(raw).is_file():
        return Path(raw)
    found = shutil.which('arduino-cli')
    if found:
        return Path(found)
    home = Path.home() / 'bin' / 'arduino-cli'
    return home if home.is_file() else None


def _missing_pieces() -> list[str]:
    missing = []
    if not shutil.which('bwrap'):
        missing.append('bwrap (bubblewrap) is not on PATH')
    if _arduino_cli() is None:
        missing.append('arduino-cli is not on PATH (set ARDUINO_CLI)')
    try:
        tc = compileguard.resolve_xtensa()
    except compileguard.ToolchainError as exc:
        raise AssertionError('ESP32 toolchain is installed but unusable: ' + exc.reason) from exc
    if tc is None:
        missing.append('ESP32 toolchain was not found (set SIM_TOOLCHAIN_DIR to the esp-x32 directory)')
    return missing


def _require_or_skip(test):
    try:
        missing = _missing_pieces()
    except AssertionError:
        raise
    if not missing:
        return
    message = 'missing ' + '; '.join(missing)
    if os.environ.get('SIM_REQUIRE_TOOLCHAIN_TEST') == '1':
        test.fail(message)
    test.skipTest(message)


def _elf_machine(path: Path) -> int:
    data = path.read_bytes()
    if data[:4] != b'\x7fELF':
        raise AssertionError(path.name + ' does not start with ELF magic')
    endian = '<' if data[5] == 1 else '>'
    return struct.unpack_from(endian + 'H', data, 18)[0]


class FreshSandboxCompileTests(unittest.TestCase):
    def test_fresh_sketch_is_an_xtensa_elf(self):
        _require_or_skip(self)
        token = secrets_token()
        sketch = (
            'void setup(){ pinMode(2, OUTPUT); digitalWrite(2, %d & 1); }\n'
            'void loop(){}\n' % (token % 2)
        )
        # The constant is part of the source, so the firmware cache key cannot hit.
        sketch = sketch.replace('void loop(){}', 'void loop(){ /* %d */ }' % token)
        saved = {
            key: os.environ.get(key)
            for key in ('SIM_COMPILE_SANDBOX', 'ARDUINO_BUILD_CACHE_PATH', 'SIM_BUILD_CACHE_DIR',
                        'XDG_CACHE_HOME', 'SIM_ARDUINO_CONFIG_FILE')
        }
        cache = Path(tempfile.mkdtemp(prefix='esp32cache-'))
        xdg = Path(tempfile.mkdtemp(prefix='esp32xdg-'))
        config = Path(tempfile.mkdtemp(prefix='esp32cfg-')) / 'arduino-cli.yaml'
        data = Path(os.environ.get('ARDUINO_DIRECTORIES_DATA') or Path.home() / '.arduino15')
        config.write_text(
            'directories:\n'
            f'  data: {data}\n'
            'build_cache:\n'
            f'  path: {cache}\n')
        os.environ['SIM_COMPILE_SANDBOX'] = '1'
        os.environ['ARDUINO_BUILD_CACHE_PATH'] = str(cache)
        os.environ['SIM_BUILD_CACHE_DIR'] = str(cache)
        os.environ['XDG_CACHE_HOME'] = str(xdg)
        os.environ['SIM_ARDUINO_CONFIG_FILE'] = str(config)
        compileguard._bwrap_ok = None
        work = Path(tempfile.mkdtemp(prefix='esp32fresh-'))
        bdir = Path(tempfile.mkdtemp(prefix='esp32fw-'))
        try:
            plan = server._compile_plan({'sketch': sketch, 'files': {}})
            self.assertIsInstance(plan, dict, getattr(plan, 'body', plan))
            resp = asyncio.run(server._compile_in(
                work, bdir, plan['key'], plan['sketch'], plan['files'],
                plan['defines'], plan['net'], plan['netmode'], plan['simlibs']))
            import json
            if isinstance(resp, dict):
                payload = resp
                body = json.dumps(resp)
            else:
                body = resp.body.decode()
                payload = json.loads(body)
            self.assertNotIn('reason=scan', body)
            self.assertNotIn("wasn't the cause", body, body[-2000:])
            self.assertTrue(payload.get('ok'), payload.get('log', '')[-2000:])
            elfs = [path for path in work.rglob('*.elf') if path.is_file() and path.stat().st_size > 0]
            self.assertTrue(elfs, 'no ELF under ' + str(work))
            machines = {path.name: _elf_machine(path) for path in elfs}
            self.assertIn(EM_XTENSA, machines.values(), machines)
            image = bdir / 'flash.bin'
            self.assertTrue(image.is_file() and image.stat().st_size > 0, 'firmware image is empty')
            self.assertNotIn('panicked', payload.get('log') or '')
        finally:
            compileguard._bwrap_ok = None
            shutil.rmtree(work, ignore_errors=True)
            shutil.rmtree(bdir, ignore_errors=True)
            shutil.rmtree(cache, ignore_errors=True)
            shutil.rmtree(xdg, ignore_errors=True)
            shutil.rmtree(config.parent, ignore_errors=True)
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value



    def test_fresh_blink_run_toggles_gpio2(self):
        _require_or_skip(self)
        qemu, rom = _require_qemu(self)
        import socket
        import threading
        import time
        import uvicorn
        server.QEMU = str(qemu)
        server.ROMDIR = str(rom)
        blink = (Path(__file__).resolve().parents[1] / 'examples' / 'Blink.ino').read_text()
        sketch = blink + '\n// fresh %d\n' % secrets_token()
        saved = {
            key: os.environ.get(key)
            for key in ('SIM_COMPILE_SANDBOX', 'ARDUINO_BUILD_CACHE_PATH', 'SIM_BUILD_CACHE_DIR',
                        'XDG_CACHE_HOME', 'SIM_ARDUINO_CONFIG_FILE')
        }
        cache = Path(tempfile.mkdtemp(prefix='esp32cache-'))
        xdg = Path(tempfile.mkdtemp(prefix='esp32xdg-'))
        config = Path(tempfile.mkdtemp(prefix='esp32cfg-')) / 'arduino-cli.yaml'
        data = Path(os.environ.get('ARDUINO_DIRECTORIES_DATA') or Path.home() / '.arduino15')
        config.write_text(
            'directories:\n'
            f'  data: {data}\n'
            'build_cache:\n'
            f'  path: {cache}\n')
        os.environ['SIM_COMPILE_SANDBOX'] = '1'
        os.environ['ARDUINO_BUILD_CACHE_PATH'] = str(cache)
        os.environ['SIM_BUILD_CACHE_DIR'] = str(cache)
        os.environ['XDG_CACHE_HOME'] = str(xdg)
        os.environ['SIM_ARDUINO_CONFIG_FILE'] = str(config)
        compileguard._bwrap_ok = None
        work = Path(tempfile.mkdtemp(prefix='esp32fresh-'))
        plan = None
        sock = socket.socket()
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
        sock.close()
        uv = None
        thread = None
        try:
            plan = server._compile_plan({'sketch': sketch, 'files': {}})
            self.assertIsInstance(plan, dict, getattr(plan, 'body', plan))
            shutil.rmtree(plan['bdir'], ignore_errors=True)
            resp = asyncio.run(server._compile_in(
                work, plan['bdir'], plan['key'], plan['sketch'], plan['files'],
                plan['defines'], plan['net'], plan['netmode'], plan['simlibs']))
            import json
            if isinstance(resp, dict):
                payload = resp
            else:
                payload = json.loads(resp.body.decode())
            self.assertTrue(payload.get('ok'), (payload.get('log') or '')[-2000:])
            self.assertFalse(payload.get('cached'))
            self.assertEqual(payload.get('id'), plan['key'])
            self.assertNotIn('unknown build id', str(payload.get('id')))
            image = server.BUILDS / plan['key'] / 'flash.bin'
            self.assertTrue(image.is_file() and image.stat().st_size > 0)
            config_uv = uvicorn.Config(
                server.app, host='127.0.0.1', port=port, log_level='warning', access_log=False)
            uv = uvicorn.Server(config_uv)
            uv.install_signal_handlers = lambda: None
            thread = threading.Thread(target=uv.run, daemon=True)
            thread.start()
            deadline = time.time() + 15
            while time.time() < deadline:
                try:
                    with socket.create_connection(('127.0.0.1', port), 0.2):
                        break
                except OSError:
                    time.sleep(0.05)
            else:
                self.fail('run server did not listen')
            url = 'ws://127.0.0.1:%d/api/run/%s' % (port, payload['id'])
            if server.TOKEN:
                url += '?t=' + server.TOKEN
            seconds = _toolchain_run_deadline()
            started, edges, bad, info = asyncio.run(_gpio2_toggles(url, seconds))
            detail = _blink_failure_detail(info, image)
            self.assertNotEqual(bad, 'unknown build id', detail)
            self.assertNotIn('unknown build id', bad, detail)
            self.assertEqual(bad, '', detail)
            self.assertTrue(started, 'the run did not send a session ' + detail)
            self.assertGreaterEqual(
                len(edges), 2,
                'GPIO2 toggled %d time(s) (edges at %s) %s' % (len(edges), edges, detail))
            self.assertLess(edges[1], seconds, detail + ' edges=%s' % (edges,))
        finally:
            if uv is not None:
                uv.should_exit = True
            if thread is not None:
                thread.join(5)
            compileguard._bwrap_ok = None
            shutil.rmtree(work, ignore_errors=True)
            if plan is not None:
                shutil.rmtree(plan['bdir'], ignore_errors=True)
            shutil.rmtree(cache, ignore_errors=True)
            shutil.rmtree(xdg, ignore_errors=True)
            shutil.rmtree(config.parent, ignore_errors=True)
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

    def test_lwip_sandbox_reaches_the_mock_tv_and_blocks_the_host(self):
        """DHCP, HTTP via guestfwd, the Eco UDP frame, and both blocked connects.

        The only network example is the Wi-Fi/IR TV remote. This sketch is that
        path: slirp guestfwd to relay.py, and the unix datagram tap. The guest
        has no route to 1.1.1.1 or to the slirp host at 10.0.2.2.
        """
        _require_or_skip(self)
        qemu, rom = _require_qemu(self)
        import socket
        import threading
        import time
        import uvicorn
        server.QEMU = str(qemu)
        server.ROMDIR = str(rom)
        sketch = _NET_SKETCH + '\n// fresh %d\n' % secrets_token()
        saved = {
            key: os.environ.get(key)
            for key in ('SIM_COMPILE_SANDBOX', 'ARDUINO_BUILD_CACHE_PATH', 'SIM_BUILD_CACHE_DIR',
                        'XDG_CACHE_HOME', 'SIM_ARDUINO_CONFIG_FILE')
        }
        cache = Path(tempfile.mkdtemp(prefix='esp32cache-'))
        xdg = Path(tempfile.mkdtemp(prefix='esp32xdg-'))
        config = Path(tempfile.mkdtemp(prefix='esp32cfg-')) / 'arduino-cli.yaml'
        data = Path(os.environ.get('ARDUINO_DIRECTORIES_DATA') or Path.home() / '.arduino15')
        config.write_text(
            'directories:\n'
            f'  data: {data}\n'
            'build_cache:\n'
            f'  path: {cache}\n')
        os.environ['SIM_COMPILE_SANDBOX'] = '1'
        os.environ['ARDUINO_BUILD_CACHE_PATH'] = str(cache)
        os.environ['SIM_BUILD_CACHE_DIR'] = str(cache)
        os.environ['XDG_CACHE_HOME'] = str(xdg)
        os.environ['SIM_ARDUINO_CONFIG_FILE'] = str(config)
        compileguard._bwrap_ok = None
        compileguard._seccomp_ok = None
        work = Path(tempfile.mkdtemp(prefix='esp32net-'))
        plan = None
        sock = socket.socket()
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
        sock.close()
        uv = None
        thread = None
        try:
            plan = server._compile_plan({
                'sketch': sketch, 'files': {}, 'defines': ['SIM'], 'net': 'shim', 'netShim': True,
            })
            self.assertIsInstance(plan, dict, getattr(plan, 'body', plan))
            self.assertEqual(plan['netmode'], 'lwip')
            shutil.rmtree(plan['bdir'], ignore_errors=True)
            resp = asyncio.run(server._compile_in(
                work, plan['bdir'], plan['key'], plan['sketch'], plan['files'],
                plan['defines'], plan['net'], plan['netmode'], plan['simlibs']))
            import json
            payload = resp if isinstance(resp, dict) else json.loads(resp.body.decode())
            self.assertTrue(payload.get('ok'), (payload.get('log') or '')[-2000:])
            self.assertEqual((server.BUILDS / plan['key'] / 'net.txt').read_text().strip(), 'lwip')
            config_uv = uvicorn.Config(
                server.app, host='127.0.0.1', port=port, log_level='warning', access_log=False)
            uv = uvicorn.Server(config_uv)
            uv.install_signal_handlers = lambda: None
            thread = threading.Thread(target=uv.run, daemon=True)
            thread.start()
            deadline = time.time() + 15
            while time.time() < deadline:
                try:
                    with socket.create_connection(('127.0.0.1', port), 0.2):
                        break
                except OSError:
                    time.sleep(0.05)
            else:
                self.fail('run server did not listen')
            url = 'ws://127.0.0.1:%d/api/run/%s' % (port, payload['id'])
            if server.TOKEN:
                url += '?t=' + server.TOKEN
            info = asyncio.run(_net_exchange(url, 90))
            text = info['uart']
            detail = 'bad=%r uart=%r udp=%r logs=%r http=%r' % (
                info['bad'], text[-1500:], info['udp'], info['logs'][-12:], info['http'])
            self.assertEqual(info['bad'], '', detail)
            self.assertTrue(info['started'], detail)
            self.assertIn('DHCP 10.0.2.', text, detail)
            self.assertIn('HTTP 200', text, detail)
            self.assertTrue(info['http'], detail)
            eco = [item for item in info['udp'] if item.get('dst') == '10.13.37.2' and '65636f' in (item.get('hex') or '')]
            self.assertTrue(eco, detail)
            self.assertIn('BLOCK public', text, detail)
            self.assertIn('BLOCK host', text, detail)
            self.assertNotIn('OPEN public', text, detail)
            self.assertNotIn('OPEN host', text, detail)
        finally:
            if uv is not None:
                uv.should_exit = True
            if thread is not None:
                thread.join(5)
            compileguard._bwrap_ok = None
            compileguard._seccomp_ok = None
            shutil.rmtree(work, ignore_errors=True)
            if plan is not None:
                shutil.rmtree(plan['bdir'], ignore_errors=True)
            shutil.rmtree(cache, ignore_errors=True)
            shutil.rmtree(xdg, ignore_errors=True)
            shutil.rmtree(config.parent, ignore_errors=True)
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value


def _qemu_bin() -> Path | None:
    raw = (os.environ.get('QEMU_BIN') or '').strip()
    candidates = []
    if raw:
        candidates.append(Path(raw))
    home = Path.home()
    candidates += [
        home / 'qemu-gpio/bin/qemu-system-xtensa',
        home / '.esp32lab/qemu/bin/qemu-system-xtensa',
        home / 'qemu-src/build/qemu-system-xtensa',
        Path('/tmp/qemu-src/build/qemu-system-xtensa'),
    ]
    for path in candidates:
        if path.is_file() and os.access(path, os.X_OK):
            return path
    return None


def _qemu_rom(qemu: Path) -> Path | None:
    raw = (os.environ.get('QEMU_ROM_DIR') or '').strip()
    candidates = [Path(raw)] if raw else []
    candidates.append(qemu.resolve().parents[1] / 'share' / 'qemu')
    candidates += [Path('/tmp/qemu-src/pc-bios'), Path('/tmp/qemu-src/build/pc-bios')]
    for path in candidates:
        if (path / 'esp32-v3-rom.bin').is_file():
            return path
    return None


def _require_qemu(test):
    qemu = _qemu_bin()
    rom = _qemu_rom(qemu) if qemu else None
    missing = []
    if qemu is None:
        missing.append('qemu-system-xtensa (set QEMU_BIN to the patched Espressif QEMU)')
    elif rom is None:
        missing.append('esp32-v3-rom.bin next to ' + str(qemu))
    if not missing:
        return qemu, rom
    message = 'missing ' + '; '.join(missing)
    if os.environ.get('SIM_REQUIRE_TOOLCHAIN_TEST') == '1':
        test.fail(message)
    test.skipTest(message)


def _toolchain_run_deadline() -> float:
    """Watch window for the Blink GPIO run. Default 15 s, never above 120 s."""
    raw = (os.environ.get('SIM_TOOLCHAIN_RUN_DEADLINE') or '').strip()
    try:
        value = float(raw) if raw else 15.0
    except ValueError:
        value = 15.0
    if value <= 0:
        value = 15.0
    return min(value, 120.0)


def _blink_failure_detail(info: dict, image: Path) -> str:
    """What the run actually did, for a GPIO assertion that would otherwise say only ``edges at []``."""
    log_path = server.BUILDS / 'qemu-last.log'
    if log_path.is_file():
        raw = log_path.read_bytes()[-800:]
        log_note = '%s (%d bytes) tail=%r' % (log_path, log_path.stat().st_size, raw.decode(errors='replace'))
    else:
        log_note = '%s missing' % log_path
    size = image.stat().st_size if image.is_file() else 0
    uart_lines = ''.join(info.get('uart') or []).splitlines()
    return (
        'ws=%s status=%r error=%r qemu_rc=%s image=%s size=%s qemu_log=%s '
        'uart_tail=%r gpio=%r fsel=%r'
        % (info.get('counts'), info.get('status'), info.get('error'), info.get('rc'),
           image, size, log_note, uart_lines[-20:], info.get('gpio'), info.get('fsel'))
    )


async def _gpio2_toggles(url: str, seconds: float):
    import json
    import websockets
    started = False
    edges = []
    last = None
    bad = ''
    counts: dict[str, int] = {}
    status = None
    error = None
    rc = None
    uart_chunks: list[str] = []
    gpio_seen: list[dict] = []
    fsel_seen: list[dict] = []
    async with websockets.connect(url, open_timeout=10, max_size=None) as ws:
        origin = asyncio.get_running_loop().time()
        deadline = origin + seconds
        while asyncio.get_running_loop().time() < deadline:
            remain = deadline - asyncio.get_running_loop().time()
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=min(0.5, max(0.05, remain)))
            except asyncio.TimeoutError:
                continue
            msg = json.loads(raw)
            kind = msg.get('t') or '?'
            counts[kind] = counts.get(kind, 0) + 1
            if kind == 'status' and status is None:
                status = msg.get('msg')
            if kind == 'error':
                if error is None:
                    error = msg.get('msg') or ''
                if msg.get('rc') is not None or rc is None:
                    rc = msg.get('rc')
                bad = msg.get('msg') or ''
                break
            if kind == 'exit' and rc is None:
                rc = msg.get('code')
            if kind == 'uart' and msg.get('d'):
                uart_chunks.append(msg.get('d'))
            if kind == 'gpio':
                gpio_seen.append({
                    'out': msg.get('out'), 'out1': msg.get('out1'),
                    'en': msg.get('en'), 'en1': msg.get('en1'),
                    'fast': msg.get('fast'), 'q': msg.get('q'),
                })
            if kind == 'fsel':
                fsel_seen.append({
                    'pin': msg.get('pin'), 'sig': msg.get('sig'),
                    'fast': msg.get('fast'), 'q': msg.get('q'),
                })
            if kind == 'session':
                started = True
            if kind == 'gpio' and (msg.get('en', 0) & (1 << 2)):
                level = 1 if msg.get('out', 0) & (1 << 2) else 0
                if last is not None and level != last:
                    edges.append(asyncio.get_running_loop().time() - origin)
                last = level
                if len(edges) >= 2:
                    break
            if kind in ('gpio', 'mux', 'rtc') and not msg.get('fast') and 'q' in msg:
                out = msg.get('out', 0) & msg.get('en', 0)
                out1 = msg.get('out1', 0) & msg.get('en1', 0)
                await ws.send(json.dumps({'t': 'in', 'in': out & 0xffffffff, 'in1': out1 & 0xff, 'q': msg['q']}))
            elif kind == 'i2c' and msg.get('op') == 'S' and not msg.get('fast'):
                await ws.send(json.dumps({'t': 'i2cr', 'ack': 0}))
            elif kind == 'i2c' and msg.get('op') == 'R':
                await ws.send(json.dumps({'t': 'i2cr', 'b': 255}))
            elif kind == 'adcq':
                await ws.send(json.dumps({'t': 'adc', 'u': msg.get('u', 0), 'ch': msg.get('ch', 0), 'v': 0}))
        try:
            await ws.send(json.dumps({'t': 'stop'}))
        except Exception:
            pass
    return started, edges, bad, {
        'counts': counts, 'status': status, 'error': error, 'rc': rc,
        'uart': uart_chunks, 'gpio': gpio_seen, 'fsel': fsel_seen,
    }


_NET_SKETCH = r'''
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiUdp.h>
void setup() {
  Serial.begin(115200);
  WiFi.begin("SIM-GUEST", "sim");
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) delay(100);
  Serial.print("DHCP ");
  Serial.println(WiFi.localIP());
  HTTPClient http;
  http.begin("http://10.0.2.100/");
  int code = http.GET();
  Serial.print("HTTP ");
  Serial.println(code);
  http.end();
  WiFiUDP udp;
  udp.beginPacket(IPAddress(10, 13, 37, 2), 9999);
  udp.write((const uint8_t *)"eco", 3);
  udp.endPacket();
  Serial.println("UDP sent");
  WiFiClient pub;
  Serial.println(pub.connect("1.1.1.1", 80) ? "OPEN public" : "BLOCK public");
  WiFiClient hostc;
  Serial.println(hostc.connect("10.0.2.2", 22) ? "OPEN host" : "BLOCK host");
  Serial.println("NET DONE");
}
void loop() { delay(1000); }
'''


async def _net_exchange(url: str, seconds: float):
    """Drive one lwIP run: answer GPIO, the mock TV, and record the Eco frame."""
    import json
    import websockets
    uart = []
    udp = []
    logs = []
    http_codes = []
    bad = ''
    started = False
    async with websockets.connect(url, open_timeout=10, max_size=None) as ws:
        origin = asyncio.get_running_loop().time()
        deadline = origin + seconds
        while asyncio.get_running_loop().time() < deadline:
            remain = deadline - asyncio.get_running_loop().time()
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=min(0.5, max(0.05, remain)))
            except asyncio.TimeoutError:
                continue
            msg = json.loads(raw)
            kind = msg.get('t')
            if kind == 'session':
                started = True
            elif kind == 'error':
                bad = msg.get('msg') or ''
                break
            elif kind == 'uart' and msg.get('d'):
                uart.append(msg.get('d'))
            elif kind == 'netlog':
                logs.append(msg.get('msg') or '')
            elif kind == 'net' and msg.get('k') == 'http':
                http_codes.append(msg.get('url'))
                await ws.send(json.dumps({
                    't': 'netr', 'id': msg.get('id'), 'code': 200, 'body': '{"ok":true}',
                }))
            elif kind == 'net' and msg.get('k') == 'udp':
                udp.append(msg)
            elif kind in ('gpio', 'mux', 'rtc') and not msg.get('fast') and 'q' in msg:
                out = msg.get('out', 0) & msg.get('en', 0)
                out1 = msg.get('out1', 0) & msg.get('en1', 0)
                await ws.send(json.dumps({'t': 'in', 'in': out & 0xffffffff, 'in1': out1 & 0xff, 'q': msg['q']}))
            elif kind == 'i2c' and msg.get('op') == 'S' and not msg.get('fast'):
                await ws.send(json.dumps({'t': 'i2cr', 'ack': 0}))
            elif kind == 'i2c' and msg.get('op') == 'R':
                await ws.send(json.dumps({'t': 'i2cr', 'b': 255}))
            elif kind == 'adcq':
                await ws.send(json.dumps({'t': 'adc', 'u': msg.get('u', 0), 'ch': msg.get('ch', 0), 'v': 0}))
            if 'NET DONE' in ''.join(uart):
                break
        try:
            await ws.send(json.dumps({'t': 'stop'}))
        except Exception:
            pass
    return {
        'started': started, 'bad': bad, 'uart': ''.join(uart),
        'udp': udp, 'logs': logs, 'http': http_codes,
    }


def secrets_token() -> int:
    return int.from_bytes(os.urandom(4), 'big')



class BlinkDiagnosticTests(unittest.TestCase):
    def test_deadline_defaults_to_15_and_caps_at_120(self):
        saved = os.environ.pop('SIM_TOOLCHAIN_RUN_DEADLINE', None)
        try:
            self.assertEqual(_toolchain_run_deadline(), 15)
            os.environ['SIM_TOOLCHAIN_RUN_DEADLINE'] = '30'
            self.assertEqual(_toolchain_run_deadline(), 30)
            os.environ['SIM_TOOLCHAIN_RUN_DEADLINE'] = '200'
            self.assertEqual(_toolchain_run_deadline(), 120)
            os.environ['SIM_TOOLCHAIN_RUN_DEADLINE'] = '0'
            self.assertEqual(_toolchain_run_deadline(), 15)
            os.environ['SIM_TOOLCHAIN_RUN_DEADLINE'] = 'nope'
            self.assertEqual(_toolchain_run_deadline(), 15)
        finally:
            if saved is None:
                os.environ.pop('SIM_TOOLCHAIN_RUN_DEADLINE', None)
            else:
                os.environ['SIM_TOOLCHAIN_RUN_DEADLINE'] = saved

    def test_no_edge_detail_includes_uart_gpio_and_fsel(self):
        lines = ['uart line %d' % n for n in range(25)]
        info = {
            'counts': {'uart': 25, 'gpio': 2, 'fsel': 1},
            'status': 'qemu started',
            'error': None,
            'rc': None,
            'uart': [line + '\n' for line in lines],
            'gpio': [{'out': 0, 'en': 4, 'q': 1}, {'out': 4, 'en': 4, 'q': 2}],
            'fsel': [{'pin': 2, 'sig': 256, 'q': 1}],
        }
        text = _blink_failure_detail(info, Path('/tmp/no-such-flash.bin'))
        self.assertIn('uart_tail=', text)
        self.assertIn('uart line 24', text)
        self.assertNotIn('uart line 4', text)
        self.assertIn("'out': 0", text)
        self.assertIn("'pin': 2", text)
        self.assertIn('qemu_rc=None', text)


class WrapperPanicTests(unittest.TestCase):
    def test_proc_self_exe_panic_is_infra(self):
        root = Path(tempfile.mkdtemp(prefix='esp32panic-'))
        gxx = root / 'xtensa-esp-elf-g++'
        gxx.write_text(
            '#!/bin/sh\n'
            "echo \"thread 'main' panicked at src/main.rs:1:1:\" >&2\n"
            'echo "no /proc/self/exe available. Is /proc mounted?" >&2\n'
            'exit 101\n')
        gxx.chmod(0o755)
        dyn = root / 'xtensa_esp32.so'
        dyn.write_bytes(b'so')
        saved = {key: os.environ.get(key) for key in (
            'SIM_XTENSA_CC_REAL', 'SIM_XTENSA_DYNCONFIG', 'SIM_COMPILE_SANDBOX')}
        os.environ['SIM_XTENSA_CC_REAL'] = str(gxx)
        os.environ['SIM_XTENSA_DYNCONFIG'] = str(dyn)
        os.environ['SIM_COMPILE_SANDBOX'] = 'off'
        try:
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                resp = server._compile_plan({
                    'sketch': '#include SIM_X\nvoid setup(){}\n',
                    'files': {},
                    'defines': ['SIM_X="hostname"'],
                })
            self.assertFalse(isinstance(resp, dict))
            import json
            body = json.loads(resp.body.decode())
            self.assertEqual(body.get('reason'), 'infra')
            self.assertEqual(body.get('log'), compileguard.SANDBOX_MSG)
            self.assertNotIn('#include lines', body['log'])
            logged = buf.getvalue()
            self.assertIn('reason=infra', logged)
            self.assertNotIn('reason=scan', logged)
        finally:
            shutil.rmtree(root, ignore_errors=True)
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value


if __name__ == '__main__':
    unittest.main()
