#!/usr/bin/env python3
"""ESP32 simulator backend: real arduino-cli builds + Espressif QEMU (patched GPIO bridge) over WebSocket.

Run:  python3 server.py [--port 8765]      then open http://127.0.0.1:8765/
Env:  QEMU_BIN (default ~/qemu-gpio/bin/qemu-system-xtensa or ~/qemu-src/build/qemu-system-xtensa)
      QEMU_ROM_DIR (dir with esp32-v3-rom.bin), ARDUINO_CLI, ESP32_FQBN
      Disk bounds (web/README.md): SIM_MIN_FREE_MB, SIM_BUILD_CACHE_DIR,
      SIM_IMAGE_CACHE_MAX_MB, SIM_CORE_CACHE_MAX_MB, SIM_SKETCH_CACHE_MAX_MB,
      SIM_NETSTACK_CACHE_DIR, SIM_NETSTACK_CACHE_MAX_MB, SIM_ORPHAN_MAX_AGE_S
      and the matching *_MAX_AGE_S knobs.
"""
import asyncio, hashlib, json, os, re, shutil, subprocess, sys, tempfile, time, argparse
import diskkeep
from pathlib import Path
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
import secrets
from fastapi.responses import PlainTextResponse
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
import uvicorn

HERE = Path(__file__).resolve().parent
SITE = HERE.parent
HOME = Path.home()
def first(*c):
    for p in c:
        if p and Path(p).exists(): return str(p)
    return c[-1]
QEMU = os.environ.get('QEMU_BIN') or first(HOME / 'qemu-gpio/bin/qemu-system-xtensa', HOME / 'qemu-src/build/qemu-system-xtensa', HERE / 'bin/qemu-system-xtensa')
ROMDIR = os.environ.get('QEMU_ROM_DIR') or first(HOME / 'qemu-gpio/share/qemu', HOME / 'qemu/qemu/share/qemu', HOME / 'qemu-src/pc-bios')
CLI = os.environ.get('ARDUINO_CLI') or shutil.which('arduino-cli') or str(HOME / 'bin/arduino-cli')
FQBN = os.environ.get('ESP32_FQBN', 'esp32:esp32:esp32doit-devkit-v1')   # DOIT DevKit V1 (DIO flash; QEMU flash model doesn't do QIO)
BUILDS = Path(os.environ.get('SIM_BUILD_DIR', tempfile.gettempdir())) / 'esp32sim-builds'
BUILDS.mkdir(parents=True, exist_ok=True)
SHIMS = HERE / 'shims'
SHIM_VER = hashlib.sha256(b''.join(p.read_bytes() for p in sorted(SHIMS.rglob('*')) if p.is_file())).hexdigest()[:8] if SHIMS.exists() else ''
# Deterministic virtual clock: time only advances with executed instructions (16 ns/insn at shift=4 = 62.5 M insn/s virtual), so
# lock-step GPIO waits don't starve FreeRTOS ticks / trip the interrupt watchdog. sleep=on keeps idle in real time.
ICOUNT = os.environ.get('SIM_ICOUNT', 'shift=4,align=off,sleep=on')
EFUSE_VREF_CODE = int(os.environ.get('SIM_ADC_VREF_CODE', '16'))   # 0x10 = '-0' => burned, 1100 mV nominal
MAX_RUNS = int(os.environ.get('SIM_MAX_RUNS', '4'))
app = FastAPI(title='ESP32 sim backend')
runs = {}
_live_images = set()   # firmware ids a QEMU process still has open
_compile_lock = asyncio.Lock()
# ---------------- public-exposure hardening ----------------
TOKEN = os.environ.get('SIM_TOKEN', '')
MAX_BODY = 200 * 1024; COMPILE_TIMEOUT = int(os.environ.get('SIM_COMPILE_TIMEOUT', '300'))
PROGRESS = {'active': False, 'log': '', 't0': 0.0, 'stage': '', 'stages': '', 'compiler': ''}
RUN_CAP = float(os.environ.get('SIM_RUN_CAP', '0'))          # seconds; 0 = unlimited
RESUME_GRACE = float(os.environ.get('SIM_RESUME_GRACE', '1800'))  # 0 = keep forever (until user stops / QEMU exits)
STOP_ON_1001 = os.environ.get('SIM_STOP_ON_1001', '0') == '1'   # old behaviour: a 1001 'going away' close ends the run
import builtins as _b, datetime as _dt
def print(*a, **k): _b.print(_dt.datetime.now().strftime('%F %T'), *a, **{**k, 'flush': True})  # keep QEMU alive this long after the browser websocket drops
RING_BYTES = 48 * 1024 * 1024
MAX_RUNS = min(MAX_RUNS, int(os.environ.get('SIM_MAX_RUNS_HARD', '6')))
CLOSED_GRACE = float(os.environ.get('SIM_CLOSED_GRACE', '90'))  # tab closed/reloaded (pagehide): keep QEMU this long for a reload to re-attach
EVICT_AFTER = float(os.environ.get('SIM_EVICT_AFTER', '900'))  # a detached run is only evicted for a new one after this long
# Network/Debug log (WiFi/DHCP/DNS/TCP/HTTP/UDP events streamed as {'t':'netlog'}). SIM_NETLOG=0 disables it entirely.
NETLOG = os.environ.get('SIM_NETLOG', '1') != '0'
# GPIO answer cache: in lock-step mode every pad write waits for the browser's GPIO_IN reply (one network round trip; ~100 ms
# through a tunnel, which makes a keyboard-matrix scan take seconds). The browser's answer depends only on the pad state and
# the circuit, so the server remembers answers per (OUT/EN, IO_MUX/RTC version) and replies instantly; the browser sends
# {'t':'inv'} whenever the circuit changes (key press, edit) and any unsolicited input change also clears it. SIM_GPIO_CACHE=0 disables.
GPIO_CACHE = os.environ.get('SIM_GPIO_CACHE', '1') != '0'
# I2C fast path (opt-in by the page with {'t':'i2cfast','on':true}): consecutive I2C write bytes go to the page as one
# message, and an I2C START to an address the page has already answered is ACKed here from that answer (plus the last
# GPIO_IN the server sent), so an OLED frame costs no network round trips. Cleared together with the GPIO cache on 'inv'.
I2C_FAST = os.environ.get('SIM_I2C_FAST', '1') != '0'
def _authed(q, cookies):
    return not TOKEN or secrets.compare_digest(q.get('t', ''), TOKEN) or secrets.compare_digest(cookies.get('simtok', ''), TOKEN)
@app.middleware('http')
async def gate(request: Request, call_next):
    if request.url.path.startswith('/server'):
        return PlainTextResponse('not found', 404)
    if not _authed(request.query_params, request.cookies):
        return PlainTextResponse('unauthorized', 401)
    if request.method == 'POST' and int(request.headers.get('content-length') or 0) > MAX_BODY:
        return PlainTextResponse('request too large', 413)
    resp = await call_next(request)
    pth = request.url.path
    if pth == '/' or pth.endswith('.html'):
        resp.headers['Cache-Control'] = 'no-cache, must-revalidate'   # always revalidate the page so new ?v= asset URLs are picked up
    elif pth.startswith(('/js/', '/css/')):
        if pth.endswith('/view3d.js'):
            resp.headers['Cache-Control'] = 'no-cache, must-revalidate'   # 3D hotfixes must reach phones immediately
        else:
            resp.headers['Cache-Control'] = 'public, max-age=31536000, immutable' if request.query_params.get('v') else 'no-cache'
    if TOKEN and request.query_params.get('t') == TOKEN:
        resp.set_cookie('simtok', TOKEN, httponly=True, samesite='lax', secure=True, max_age=86400 * 7)
    return resp
def _index_headers():
    names = set(); roots = [HOME / '.arduino15/packages', HOME / 'Arduino/libraries', SHIMS]
    for r in roots:
        if not r.exists(): continue
        for dp, _, fs in os.walk(r):
            for f in fs:
                if f.endswith(('.h', '.hpp', '.hh')): names.add(f)
    names |= {'stdio.h','stdlib.h','string.h','math.h','stdint.h','stdbool.h','stddef.h','ctype.h','limits.h','time.h','assert.h',
              'algorithm','vector','map','string','functional','array','memory','cstdint','cstring','cmath','cstdio','cstdlib','utility','queue','deque','list','set'}
    return names
KNOWN_HEADERS = _index_headers()
INC_RE = re.compile(r'^\s*#\s*include\b(.*)$', re.M)
def check_sources(srcs, uploaded):
    for txt in srcs:
        if re.search(r'incbin|__has_include|#\s*(include_next|import)\b', txt): return 'forbidden directive (.incbin/__has_include/include_next/import)'
        for m in INC_RE.finditer(txt):
            arg = m.group(1).strip()
            mm = re.match(r'^[<"]([^<>"]+)[>"]', arg)
            if not mm: return f'unsupported #include form: {arg[:60]}'
            h = mm.group(1)
            if h.startswith('/') or '\\' in h or '..' in h or ':' in h: return f'forbidden include path: {h}'
            base = h.rsplit('/', 1)[-1]
            if h in uploaded or base in KNOWN_HEADERS: continue
            return f'include not in allowlist: {h}'
    return None
def sanitize(log):
    for pth in sorted({str(BUILDS), str(HOME), tempfile.gettempdir(), str(HERE)}, key=len, reverse=True):
        log = log.replace(pth, '~')
    return re.sub(r'(/[A-Za-z0-9_.+-]+){2,}/', '.../', log)

@app.get('/api/health')
def health():
    ok_q = Path(QEMU).exists(); ok_c = Path(CLI).exists() if CLI else False
    return {'ok': ok_q and ok_c, 'qemu': QEMU if ok_q else None, 'arduino_cli': CLI if ok_c else None, 'fqbn': FQBN, 'runs': len(runs),
            'notes': 'Real Xtensa emulation (Espressif QEMU, patched esp32.gpio/iomux/rtcio). Wi-Fi radio not emulated: network sketches use the QemuNet shim (WiFi/HTTPClient/WiFiUdp -> mock devices).'}

def merged_image(outdir: Path) -> Path:
    m = list(outdir.glob('*.ino.merged.bin'))
    if m:
        p = m[0]
        if p.stat().st_size < 4 * 1024 * 1024:
            with open(p, 'ab') as f: f.write(b'\xff' * (4 * 1024 * 1024 - p.stat().st_size))
        return p
    raise RuntimeError('no merged image produced')

def _begin_progress():
    PROGRESS.update(active=True, log='', t0=time.time(), stage='', stages='', compiler='')

def _stage(msg: str):
    """Append a stage line the UI can show while arduino-cli is still running."""
    PROGRESS['stage'] = msg
    line = msg.rstrip() + '\n'
    if line not in PROGRESS['stages']:
        PROGRESS['stages'] += line
    PROGRESS['log'] = PROGRESS['stages'] + PROGRESS['compiler']

def _compiler_log(text: str):
    PROGRESS['compiler'] = text
    PROGRESS['log'] = PROGRESS['stages'] + text

def _note_compiler_line(line: str):
    if 'xtensa-esp32-elf-g' not in line:
        return
    if '--start-group' in line:
        _stage('Linking...')
    elif ' -c ' in line and ' -E ' not in line and 'sketch.ino.cpp' in line:
        _stage('Compiling sketch...')

@app.get('/api/compile/progress')
async def compile_progress():
    # Keep the stage lines even when the compiler tail is long.
    log = (PROGRESS.get('stages') or '') + (PROGRESS.get('compiler') or '')[-20000:]
    return {'active': PROGRESS['active'], 'elapsed': round(time.time() - PROGRESS['t0'], 1) if PROGRESS['active'] else 0,
            'log': log, 'stage': PROGRESS.get('stage') or ''}

def _cache_roots():
    return diskkeep.cache_roots_from_env()

@app.on_event('startup')
async def _prewarm():
    try:
        summary = diskkeep.startup(builds=BUILDS, cache_roots=_cache_roots(),
                                   temp_roots=[Path(tempfile.gettempdir())], limits=diskkeep.Limits.from_env(),
                                   netstack_root=diskkeep.netstack_root_from_env())
        print('disk startup', summary, flush=True)
    except Exception as e:
        print('disk startup failed:', repr(e), flush=True)
    async def go():
        try: await compile_({'sketch': 'void setup(){}\nvoid loop(){}'}); print('prewarm compile done', flush=True)
        except Exception as e: print('prewarm failed:', repr(e), flush=True)
    if os.environ.get('SIM_PREWARM', '1') == '1': asyncio.get_event_loop().create_task(go())

@app.post('/api/compile')
async def compile_(req: dict):
    sketch = req.get('sketch', '')
    files = req.get('files', {}) or {}
    if not isinstance(sketch, str) or not isinstance(files, dict) or not all(isinstance(v, str) for v in files.values()):
        return JSONResponse({'ok': False, 'log': 'bad request'}, 400)
    if len(sketch) + sum(len(v) for v in files.values()) > MAX_BODY:
        return JSONResponse({'ok': False, 'log': 'sources too large'}, 413)
    files = {k: v for k, v in files.items() if re.fullmatch(r'[A-Za-z0-9_.-]+\.(h|hpp|c|cpp|ino)', k) and k != 'sketch.ino'}
    err = check_sources([sketch, *files.values()], set(files))
    if err: return JSONResponse({'ok': False, 'log': 'rejected: ' + err})
    if _compile_lock.locked():
        return JSONResponse({'ok': False, 'log': 'another compile is running, retry shortly'}, 429, headers={'Retry-After': '3'})
    defines = [d for d in (req.get('defines') or []) if re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*(=[A-Za-z0-9_."]*)?', d)]
    net = bool(req.get('netShim', False)) or bool(re.search(r'#include\s*[<"](WiFi|HTTPClient|WiFiUdp)\.h', sketch + ''.join(files.values())))
    netmode = (req.get('net') if req.get('net') in ('lwip', 'shim') else 'lwip') if net else None
    allsrc = sketch + ''.join(files.values())
    simlibs = [n for h, n in (('Adafruit_NeoPixel.h', 'QemuNeoPixel'), ('DHT.h', 'QemuDHT')) if re.search(r'#\s*include\s*[<"]' + re.escape(h) + r'[>"]', allsrc) and (SHIMS / n).exists()]
    key = hashlib.sha256(json.dumps([sketch, files, defines, net, netmode, FQBN, SHIM_VER if (net or simlibs) else '', simlibs], sort_keys=True).encode()).hexdigest()[:16]
    bdir = BUILDS / key
    img = bdir / 'flash.bin'
    if img.exists():
        return _cached_compile(key, bdir, net, netmode)
    async with _compile_lock:
        if img.exists():
            return _cached_compile(key, bdir, net, netmode)
        roots = _cache_roots()
        try:
            diskkeep.prepare_for_compile(builds=BUILDS, cache_roots=roots, temp_roots=[Path(tempfile.gettempdir())],
                                         limits=diskkeep.Limits.from_env(), keep_images=set(_live_images),
                                         netstack_root=diskkeep.netstack_root_from_env())
        except diskkeep.LowDisk as e:
            return JSONResponse({'ok': False, 'log': e.message}, 507)
        # .last-used is stamped when arduino-cli starts; a couple of seconds of slack covers that.
        started = time.time() - 2
        try:
            with diskkeep.request_build_dir() as work:
                return await _compile_in(work, bdir, key, sketch, files, defines, net, netmode, simlibs)
        finally:
            try: diskkeep.forget_sketch_builds_since(roots, started)
            except Exception as e: print('sketch cache cleanup failed:', repr(e))
            PROGRESS['active'] = False

def _cached_compile(key, bdir, net, netmode):
    t0 = time.perf_counter()
    try: diskkeep.touch_firmware(bdir / 'flash.bin')
    except OSError: pass
    try: log = sanitize((bdir / 'log.txt').read_text())
    except OSError: log = ''
    log = diskkeep.cached_build_log(log, time.perf_counter() - t0)
    return {'ok': True, 'id': key, 'cached': True, 'log': log, 'netShim': net, 'net': netmode}

_TC = None
_HEADERS = None
_NET_LIBS = ('QemuEth', 'Network', 'HTTPClient', 'NetworkClientSecure')

def _arduino_data() -> Path:
    for c in (os.environ.get('ARDUINO_DIRECTORIES_DATA'), os.environ.get('ARDUINO_DATA_DIR'),
              str(HOME / '.arduino15'), str(HOME / '.esp32lab' / 'arduino15')):
        if c and (Path(c) / 'packages' / 'esp32').is_dir():
            return Path(c)
    return HOME / '.arduino15'

def _toolchain():
    """esp32 core version, a fingerprint that changes when the compiler moves, and gcc-ar."""
    global _TC
    if _TC is not None:
        return _TC or None
    data = _arduino_data()
    plats = sorted((data / 'packages/esp32/hardware/esp32').glob('*/platform.txt'))
    gccs = sorted((data / 'packages/esp32/tools/esp-x32').glob('*/bin/xtensa-esp32-elf-g++'))
    if not plats or not gccs:
        _TC = False
        return None
    core = ''
    for line in plats[-1].read_text(errors='replace').splitlines():
        if line.startswith('version='):
            core = line.split('=', 1)[1].strip()
            break
    gcc = gccs[-1]
    ar = gcc.parent / 'xtensa-esp32-elf-gcc-ar'
    try:
        ver = subprocess.check_output([str(gcc), '--version'], text=True, timeout=30).splitlines()[0].strip()
    except (OSError, subprocess.SubprocessError):
        _TC = False
        return None
    if not ar.is_file() or not core:
        _TC = False
        return None
    _TC = {'core': core, 'fingerprint': f'{core}|{ver}|{gcc}', 'ar': ar}
    return _TC

def _collect_headers(lib: Path) -> set:
    src = lib / 'src' if (lib / 'src').is_dir() else lib
    names = set()
    if not src.is_dir():
        return names
    for header in src.rglob('*'):
        if header.is_file() and not header.is_symlink() and header.suffix.lower() in {'.h', '.hpp', '.hh'}:
            names.add(header.name)
    return names

def _header_index():
    """Headers the network archive provides, and headers that belong to some other library."""
    global _HEADERS
    if _HEADERS is not None:
        return _HEADERS
    net, other = set(), set()
    roots = list((_arduino_data() / 'packages/esp32/hardware/esp32').glob('*/libraries'))
    roots.append(Path(os.environ.get('ARDUINO_DIRECTORIES_USER') or HOME / 'Arduino') / 'libraries')
    roots.append(SHIMS)
    for root in roots:
        if not root.is_dir():
            continue
        for lib in root.iterdir():
            if not lib.is_dir() or lib.is_symlink():
                continue
            headers = _collect_headers(lib)
            if lib.name in _NET_LIBS:
                net |= headers
            else:
                other |= headers
    _HEADERS = (net, other - net)
    return _HEADERS

def _netstack_covers(sketch: str, files: dict) -> bool:
    """True when every included library header is part of the prebuilt network stack."""
    _net, other = _header_index()
    for match in INC_RE.finditer(sketch + ''.join(files.values())):
        arg = match.group(1).strip()
        found = re.match(r'^[<"]([^<>"]+)[>"]', arg)
        if not found:
            continue
        if found.group(1).rsplit('/', 1)[-1] in other:
            return False
    return True

def _netstack_identity(defines):
    tc = _toolchain()
    shim = SHIMS / 'QemuEth'
    if not tc or not shim.is_dir():
        return None
    return {'toolchain': tc['fingerprint'], 'core': tc['core'], 'shim_hash': diskkeep.source_tree_hash(shim),
            'fqbn': FQBN, 'defines': tuple(defines)}

def _seed_libraries_cache(sketch_dir: Path, payload: bytes) -> None:
    folder = diskkeep.arduino_build_cache_dir() / 'sketches' / diskkeep.request_sketch_hash(sketch_dir)
    folder.mkdir(parents=True, exist_ok=True)
    (folder / 'libraries.cache').write_bytes(payload)

def _extract_netstack(entry: Path, dest: Path) -> list:
    tc = _toolchain()
    manifest = json.loads((entry / 'manifest.json').read_text())
    dest.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run([str(tc['ar']), 'x', str(entry / 'libnetstack.a')], cwd=dest,
                          capture_output=True, text=True, timeout=60)
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or 'ar x failed')[-400:])
    paths = []
    for name in manifest.get('objects') or []:
        obj = dest / name
        if not obj.is_file():
            raise FileNotFoundError(name)
        paths.append(obj.resolve())
    if not paths:
        raise RuntimeError('empty netstack archive')
    return paths

def _harvest_netstack(sketch_dir: Path, defines):
    """Archive the QemuEth/Network/HTTPClient/NetworkClientSecure objects from this compile."""
    ident = _netstack_identity(defines)
    tc = _toolchain()
    if not ident or not tc:
        return None
    build = diskkeep.arduino_build_cache_dir() / 'sketches' / diskkeep.request_sketch_hash(sketch_dir)
    libs = build / 'libraries'
    cache_file = build / 'libraries.cache'
    if not libs.is_dir() or not cache_file.is_file():
        return None
    extra = [p.name for p in libs.iterdir() if p.is_dir() and p.name not in _NET_LIBS]
    if extra:
        return None
    objects = []
    for name in _NET_LIBS:
        folder = libs / name
        if folder.is_dir():
            objects.extend(sorted(folder.glob('*.o')))
    if not objects:
        return None
    key = diskkeep.netstack_key(**ident)
    root = diskkeep.netstack_root_from_env()
    staging = root / f'.{key}.objs'
    if staging.exists():
        shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)
    try:
        staged = []
        for obj in objects:
            dest = staging / obj.name
            shutil.copyfile(obj, dest)
            staged.append(dest)
        archive = staging / 'libnetstack.a'
        proc = subprocess.run([str(tc['ar']), 'rcs', str(archive), *[str(p) for p in staged]],
                              capture_output=True, text=True, timeout=60)
        if proc.returncode != 0 or not archive.is_file():
            print('netstack archive failed:', (proc.stderr or '')[-400:])
            return None
        manifest = {'objects': [p.name for p in staged], 'core': ident['core'], 'shim': ident['shim_hash'],
                    'fqbn': ident['fqbn'], 'defines': list(ident['defines'])}
        return diskkeep.publish_netstack(root, key, archive, cache_file.read_bytes(), manifest)
    finally:
        shutil.rmtree(staging, ignore_errors=True)

async def _compile_in(work, bdir, key, sketch, files, defines, net, netmode, simlibs):
    """Run arduino-cli with --output-dir inside `work`. The caller deletes `work` and the sketch build tree."""
    sk = work / 'sketch'; out = work / 'out'
    sk.mkdir(parents=True); out.mkdir()
    (sk / 'sketch.ino').write_text(sketch)
    for name, content in files.items():
        if re.fullmatch(r'[A-Za-z0-9_.-]+\.(h|hpp|c|cpp|ino)', name) and name != 'sketch.ino':
            (sk / name).write_text(content)
    # --build-path is intentionally not set. On arduino-cli 1.x it disables the core cache and
    # rebuilds the ESP32 core on every sketch (minutes, not the ~8 s warm Blink).
    _begin_progress()
    use_stack = False
    objs = []
    covered = netmode == 'lwip' and _netstack_covers(sketch, files)
    if covered:
        ident = _netstack_identity(defines)
        hit = None
        if ident:
            hit = diskkeep.find_netstack(diskkeep.netstack_root_from_env(), diskkeep.netstack_key(**ident))
        if hit:
            try:
                objs = _extract_netstack(hit, work / 'netobjs')
                _seed_libraries_cache(sk, (hit / 'libraries.cache').read_bytes())
                use_stack = True
                _stage('Using cached network stack...')
            except (OSError, RuntimeError, json.JSONDecodeError, FileNotFoundError) as e:
                print('netstack cache unusable:', repr(e))
        if not use_stack:
            _stage('Building network stack (first time, about 40 s)...')
    else:
        _stage('Compiling sketch...')
    cmd = [CLI, 'compile', '-b', FQBN, '--output-dir', str(out), '--warnings', 'none']
    if defines:
        cmd += ['--build-property', 'compiler.cpp.extra_flags=' + ' '.join('-D' + d for d in defines),
                '--build-property', 'compiler.c.extra_flags=' + ' '.join('-D' + d for d in defines)]
    if netmode == 'lwip':
        # Object files go in compiler.c.elf.extra_flags, which the link recipe places before
        # --start-group and core.a. build.extra_libs is after core.a and lets core.a win weak
        # symbols (the image grew by about 76 bytes). One libstdc++ COMDAT,
        # basic_string::_M_dispose, can still differ by a few bytes from a full link.
        link = '-Wl,--wrap=lwip_getaddrinfo,--wrap=lwip_connect'
        if use_stack:
            link += ' ' + ' '.join(str(p) for p in objs)
        cmd += ['--library', str(SHIMS / 'QemuEth'), '--build-property', 'compiler.c.elf.extra_flags=' + link]
    elif net: cmd += ['--library', str(SHIMS / 'QemuNet')]
    for n in simlibs: cmd += ['--library', str(SHIMS / n)]   # simulator back ends: NeoPixel show() -> UART frame, DHT read() -> lock-step bits
    if use_stack:
        # Library discovery would rebuild QemuEth, Network, HTTPClient and NetworkClientSecure
        # into the sketch tree, which is deleted after every compile.
        cmd += ['--skip-libraries-discovery']
    cmd.append(str(sk))
    t0 = PROGRESS['t0']
    cmd[2:2] = ['-v', '--no-color']
    p = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    buf = []
    async def _pump():
        async for ln in p.stdout:
            t = ln.decode(errors='replace'); buf.append(t)
            _note_compiler_line(t)
            _compiler_log(sanitize(''.join(buf[-200:]).replace(str(sk) + '/', '')))
        await p.wait()
    try:
        await asyncio.wait_for(_pump(), COMPILE_TIMEOUT)
    except asyncio.TimeoutError:
        p.kill(); await p.wait()
        return JSONResponse({'ok': False, 'log': PROGRESS['stages'] + sanitize(''.join(buf[-200:])) + f'\ncompile timed out ({COMPILE_TIMEOUT}s) - the first build after a restart compiles the ESP32 core; press Run again.'})
    body = ''.join(buf[-300:]) if len(buf) > 300 else ''.join(buf).replace(str(sk) + '/', '')
    log = PROGRESS['stages'] + sanitize(body)
    if netmode == 'lwip' and use_stack:
        tag = '(+QemuEth: open_eth + lwIP, cached network stack)'
    elif netmode == 'lwip':
        tag = '(+QemuEth: open_eth + lwIP)'
    elif net:
        tag = '(+QemuNet shim)'
    else:
        tag = ''
    log += f'\n[{time.time() - t0:.1f}s] compile{(" " + tag) if tag else ""}\n'
    if p.returncode != 0:
        return JSONResponse({'ok': False, 'log': log, 'netShim': net, 'net': netmode})
    if covered and not use_stack:
        try: _harvest_netstack(sk, defines)
        except Exception as e: print('netstack harvest failed:', repr(e))
    try:
        produced = merged_image(out)
    except RuntimeError as e:
        return JSONResponse({'ok': False, 'log': log + '\n' + str(e)})
    diskkeep.publish_firmware(bdir, produced, log, netmode or '')
    return {'ok': True, 'id': key, 'cached': False, 'log': log, 'netShim': net, 'net': netmode}

# ---------------- raw Ethernet frame tap (real lwIP UDP <-> browser mock devices) ----------------
import socket, struct
udp_taps = {}
def free_udp_port():
    s_ = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s_.bind(('127.0.0.1', 0)); p_ = s_.getsockname()[1]; s_.close(); return p_
def ip_csum(b):
    if len(b) % 2: b += b'\0'
    t = sum(struct.unpack('!%dH' % (len(b) // 2), b)); t = (t >> 16) + (t & 0xffff); t += t >> 16
    return (~t) & 0xffff
class FrameTap(asyncio.DatagramProtocol):
    """QEMU '-net socket,udp=' carries whole Ethernet frames over UDP. We watch the hub for IPv4/UDP datagrams that
    the guest sends to non-slirp addresses (LAN devices like the Eco plug at 10.13.37.2, or broadcasts), hand them to the
    browser's mock devices and inject the replies as frames that appear to come from the device via the gateway."""
    GW_MAC = bytes.fromhex('525500000202')   # overwritten from observed frames
    def __init__(self, ws, log=None): self.ws = ws; self.peer = None; self.tr = None; self.n = 0; self.ctx = {}; self.gw = self.GW_MAC; self.log = log; self.gmac = None
    def connection_made(self, tr): self.tr = tr
    def datagram_received(self, f, addr):
        if self.log:
            try: self.observe(f)
            except Exception as e: print('netlog observe:', repr(e))
        if len(f) < 42 or f[12:14] != b'\x08\x00': return
        ip = f[14:]; ihl = (ip[0] & 15) * 4
        if ip[9] != 17: return
        src, dst = socket.inet_ntoa(ip[12:16]), socket.inet_ntoa(ip[16:20])
        if dst.startswith('10.0.2.') or src.startswith('10.0.2.') is False: return
        if dst.startswith('224.') or dst == '10.0.2.255': return
        sport, dport, ln = struct.unpack('!HHH', ip[ihl:ihl + 6]); data = ip[ihl + 8: ihl + ln]
        if dport in (67, 68, 53): return
        if f[0:6] != b'\xff' * 6: self.gw = f[0:6]
        self.n += 1; self.ctx[self.n] = (f[6:12], src, sport)
        if self.log: self.log('udp', f'UDP send {src}:{sport} -> {dst}:{dport} {len(data)} B', hex=data[:48].hex())
        asyncio.ensure_future(self.ws.send_json({'t': 'net', 'k': 'udp', 'via': 'lwip', 'id': self.n, 'src': src, 'dst': dst, 'sport': sport, 'dport': dport, 'hex': data.hex()}))
    def observe(self, f):
        """Passive decode of every frame on the hub for the Network log (DHCP, DNS, TCP connects/resets, ARP misses)."""
        if len(f) < 34 or f[12:14] != b'\x08\x00': return
        ip = f[14:]; ihl = (ip[0] & 15) * 4; proto = ip[9]
        src, dst = socket.inet_ntoa(ip[12:16]), socket.inet_ntoa(ip[16:20])
        l4 = ip[ihl:]
        if proto == 17 and len(l4) >= 8:
            sport, dport = struct.unpack('!HH', l4[:4]); d = l4[8:]
            if 67 in (sport, dport) and len(d) >= 240:
                yi = socket.inet_ntoa(d[16:20]); mt = None; i = 240
                while i < len(d) and d[i] != 255:
                    if d[i] == 0: i += 1; continue
                    if i + 1 >= len(d): break
                    if d[i] == 53: mt = d[i + 2]
                    i += 2 + d[i + 1]
                nm = {1: 'DISCOVER', 2: 'OFFER', 3: 'REQUEST', 5: 'ACK', 6: 'NAK', 7: 'RELEASE'}.get(mt, str(mt))
                self.log('dhcp', f'DHCP {nm}' + (f' -> IP {yi}' if mt in (2, 5) else ''), ok=mt != 6)
            elif 53 in (sport, dport) and len(d) > 12:
                qd, an = struct.unpack('!HH', d[4:8]); i = 12; labels = []
                while i < len(d) and d[i]: labels.append(d[i + 1:i + 1 + d[i]].decode('latin-1')); i += 1 + d[i]
                name = '.'.join(labels)
                if dport == 53: self.log('dns', f'DNS query {name}')
                else:
                    rc = d[3] & 15; ans = ''
                    j = i + 5
                    for _ in range(an):
                        if j + 12 > len(d): break
                        j += 2 if d[j] & 0xc0 == 0xc0 else len(d)
                        t_, _c, _ttl, rl = struct.unpack('!HHIH', d[j:j + 10]); j += 10
                        if t_ == 1 and rl == 4: ans = socket.inet_ntoa(d[j:j + 4]); break
                        j += rl
                    self.log('dns', f'DNS answer {name} -> {ans or "NXDOMAIN/none (rcode %d)" % rc}', ok=bool(ans))
        elif proto == 6 and len(l4) >= 14:
            sport, dport = struct.unpack('!HH', l4[:4]); fl = l4[13]
            if fl & 0x02 and not fl & 0x10 and not dst.startswith('10.0.2.15'):
                self.log('tcp', f'TCP connect {src}:{sport} -> {dst}:{dport}' + ('' if dst == '10.0.2.100' else '  (not a simulator address: goes to the box network via slirp)'), dst=dst, dport=dport)
            elif fl & 0x04 and dst == '10.0.2.15':
                self.log('tcp', f'TCP reset from {src}:{sport} (connection refused / closed)', ok=False)
    def reply(self, m):
        c = self.ctx.pop(int(m.get('id', 0)), None)
        if not c or not self.tr: return
        gmac, gip, gport = c
        if self.log and not (m.get('replies') or []): self.log('udp', 'UDP: no virtual device answered (no reply)', ok=False)
        for r in m.get('replies') or []:
            data = bytes.fromhex(r.get('hex', '')); sip = socket.inet_aton(r.get('ip', '10.13.37.2'))
            udp = struct.pack('!HHHH', int(r.get('sport', 0)), gport, 8 + len(data), 0) + data
            hdr = struct.pack('!BBHHHBBH4s4s', 0x45, 0, 20 + len(udp), 0, 0, 64, 17, 0, sip, socket.inet_aton(gip))
            hdr = hdr[:10] + struct.pack('!H', ip_csum(hdr)) + hdr[12:]
            if self.log: self.log('udp', f"UDP recv {r.get('ip')}:{r.get('sport')} -> {gip}:{gport} {len(data)} B")
            self.tr.sendto(gmac + self.gw + b'\x08\x00' + hdr + udp, self.peer)

# ---------------- resumable run sessions ----------------
# A run (QEMU + bridges) lives in a Session that outlives any single websocket. Every server->browser message is
# numbered (_n) and kept in a bounded ring; when the browser's websocket drops (ngrok heartbeat timeout, Wi-Fi blip)
# QEMU keeps running (lock-step requests simply wait for the browser) and the browser reconnects with ?sid=&since=,
# receives everything it missed, and re-answers any outstanding request. Sessions die when QEMU exits, the user stops,
# no browser has been attached for RESUME_GRACE seconds, or (optionally) RUN_CAP is reached.
from collections import deque
SESSIONS = {}
class Link:
    def __init__(self, sid):
        self.sid = sid; self.ws = None; self.n = 0; self.ring = deque(); self.size = 0; self.q = asyncio.Queue()
        self.detached_at = time.monotonic(); self.pending_req = lambda: []; self.done = False; self.resumes = 0; self.soft = False
    async def send_json(self, m):
        self.n += 1; m = dict(m); m['_n'] = self.n; txt = json.dumps(m, separators=(',', ':'))
        self.ring.append((self.n, m.get('t'), txt)); self.size += len(txt)
        while self.size > RING_BYTES and len(self.ring) > 1: self.size -= len(self.ring.popleft()[2])
        ws = self.ws
        if ws is not None:
            try: await ws.send_text(txt)
            except Exception: self.detach(ws)
    async def ping(self):   # app-level heartbeat so the browser can detect a half-open tunnel (not stored in the ring)
        ws = self.ws
        if ws is not None:
            try: await asyncio.wait_for(ws.send_text('{"t":"hb","n":%d}' % self.n), 10)
            except Exception: self.detach(ws)
    def detach(self, ws):
        if self.ws is ws and ws is not None:
            self.ws = None; self.detached_at = time.monotonic(); print(f'run {self.sid}: browser detached', flush=True)
    async def attach(self, ws, since):
        old = self.ws; self.ws = None
        if old is not None: asyncio.ensure_future(_quiet_close(old))
        first = self.ring[0][0] if self.ring else self.n + 1
        if since and since + 1 < first: await ws.send_text(json.dumps({'t': 'status', 'msg': f'resume gap: {first - since - 1} old messages dropped'}))
        # Replay what the browser missed, except the flood of GPIO-output snapshots: those only matter as the latest
        # state (each one supersedes the previous), so only the newest missed one is sent. Everything else (UART text,
        # pin-mux/RTC writes, RMT/IR, PWM, I2C/SPI, network, netlog) is replayed in order.
        last = since; sent = 0
        while True:   # loop until caught up (new messages may arrive while we await)
            batch = [e for e in list(self.ring) if e[0] > last]
            if not batch: break
            lastg = max((e[0] for e in batch if e[1] == 'gpio'), default=0)
            for n, t, txt in batch:
                if t != 'gpio' or n == lastg: await ws.send_text(txt); sent += 1
                last = n
        self.ws = ws; self.detached_at = time.monotonic(); self.soft = False
        if since: self.resumes += 1; print(f'run {self.sid}: browser resumed (since {since}, now {self.n}, replayed {sent})', flush=True)
        for m in self.pending_req(): await self.send_json(m)   # re-ask a lock-step question whose answer may have been lost
    async def read(self, ws):
        try:
            while True: await self.q.put(await ws.receive_json())
        except WebSocketDisconnect as e:
            print(f'run {self.sid}: websocket closed code={e.code}')
            if STOP_ON_1001 and e.code == 1001 and self.ws is ws: await self.q.put({'t': 'stop'})   # page closed/navigated away: end the run now
        except Exception: pass
        finally: self.detach(ws)
    async def receive_json(self): return await self.q.get()
    async def close(self):
        ws = self.ws; self.ws = None
        if ws is not None: await _quiet_close(ws)
async def _quiet_close(ws):
    try: await ws.close()
    except Exception: pass

@app.websocket('/api/run/{bid}')
async def run(ws: WebSocket, bid: str):
    if not _authed(ws.query_params, ws.cookies):
        await ws.close(code=4401); return
    await ws.accept()
    sid = ws.query_params.get('sid')
    if sid:   # resume an existing session
        link = SESSIONS.get(sid)
        if not link or link.done:
            await ws.send_json({'t': 'error', 'msg': 'run session expired (QEMU was stopped)', 'expired': 1}); await ws.close(); return
        try: since = int(ws.query_params.get('since') or 0)
        except ValueError: since = 0
        try: await link.attach(ws, since)
        except Exception: link.detach(ws); return
        await link.read(ws); return
    img = BUILDS / re.sub(r'[^0-9a-f]', '', bid) / 'flash.bin'
    if not img.exists():
        await ws.send_json({'t': 'error', 'msg': 'unknown build id'}); await ws.close(); return
    if len(runs) >= MAX_RUNS:   # make room by ending runs whose browser is gone (waiting out their resume grace)
        for l_ in sorted((l_ for l_ in SESSIONS.values() if l_.ws is None and not l_.done and (l_.soft or time.monotonic() - l_.detached_at > EVICT_AFTER)), key=lambda l_: l_.detached_at):
            if len(runs) < MAX_RUNS: break
            await l_.q.put({'t': 'stop', 'why': 'evicted for a new run (MAX_RUNS)'})
            for _ in range(50):
                if l_.done: break
                await asyncio.sleep(0.1)
    if len(runs) >= MAX_RUNS:
        await ws.send_json({'t': 'error', 'msg': 'too many concurrent runs'}); await ws.close(); return
    sid = secrets.token_hex(8); link = SESSIONS[sid] = Link(sid)
    await link.send_json({'t': 'session', 'sid': sid, 'grace_s': RESUME_GRACE, 'cap_s': RUN_CAP})
    await link.attach(ws, 0)
    task = asyncio.create_task(session_main(link, bid, img))
    link.task = task
    await link.read(ws)

async def session_main(ws, bid, img):
    link = ws
    try: await _session_main(link, bid, img)
    except Exception as e: print('session error:', repr(e), flush=True)
    finally:
        link.done = True
        try: await link.close()
        except Exception: pass
        async def _forget():
            await asyncio.sleep(RESUME_GRACE or 600); SESSIONS.pop(link.sid, None)
        asyncio.ensure_future(_forget())

async def _session_main(ws, bid, img):
    """One QEMU run. The private flash copy is removed when this returns, including a failed start."""
    safe = re.sub(r'[^0-9a-f]', '', bid)
    if safe: _live_images.add(safe)
    tmp = Path(tempfile.mkdtemp(prefix='esp32run-'))
    hold = {}
    try:
        await _qemu_session(ws, bid, img, tmp, hold)
    finally:
        proc = hold.get('proc')
        if proc is not None and proc.returncode is None:
            try: proc.kill()
            except ProcessLookupError: pass
            try: await proc.wait()
            except Exception: pass
        runs.pop(id(ws), None)
        for srv in (hold.get('gsrv'), hold.get('ssrv')):
            if srv is not None:
                try: srv.close()
                except Exception: pass
        for h_ in hold.get('hsrvs') or []:
            try: h_.close()
            except Exception: pass
        for t_ in hold.get('taps') or []:
            try: t_.close()
            except Exception: pass
        udp_taps.pop(id(ws), None)
        _live_images.discard(safe)
        shutil.rmtree(tmp, ignore_errors=True)

async def _qemu_session(ws, bid, img, tmp, hold):
    link = ws
    flash = tmp / 'flash.bin'; shutil.copy(img, flash)      # private copy (NVS writes)
    gsock, ssock = str(tmp / 'gpio.sock'), str(tmp / 'uart.sock')
    # eFuse image (BLK0..3 = 124 bytes). BLK0 word4 bits[12:8] = ADC_VREF (sign-magnitude, 7 mV steps from 1100 mV):
    # a "burned" Vref lets ESP-IDF's line-fitting ADC calibration (analogReadMilliVolts) work like on real silicon.
    efuse = tmp / 'efuse.bin'; eb = bytearray(124); eb[16:20] = (EFUSE_VREF_CODE << 8).to_bytes(4, 'little'); efuse.write_bytes(bytes(eb))
    conns = {}
    ready = asyncio.Event()
    async def on_gpio(r, w):
        conns['g'] = (r, w); ready.set() if 's' in conns else None
    async def on_uart(r, w):
        conns['s'] = (r, w); ready.set() if 'g' in conns else None
    netmode = (img.parent / 'net.txt').read_text().strip() if (img.parent / 'net.txt').exists() else ''
    pending = {}; nid = [0]; hsrvs = []; taps = []; hold['hsrvs'] = hsrvs; hold['taps'] = taps
    nl_on = [NETLOG]; t_run = time.time()
    def nlog(k, msg, ok=True, **kw):
        if not nl_on[0]: return
        try: asyncio.ensure_future(ws.send_json({'t': 'netlog', 'ts': round(time.time() - t_run, 3), 'k': k, 'msg': msg, 'ok': ok, **kw}))
        except Exception: pass
    def http_handler(port):
        async def h(r, w):
            try:
                head = await asyncio.wait_for(r.readuntil(b'\r\n\r\n'), 10)
                lines = head.decode('latin-1').split('\r\n'); method, path, _ = (lines[0].split(' ') + ['', ''])[:3]
                hdrs = {}
                for l in lines[1:]:
                    if ':' in l: k, v = l.split(':', 1); hdrs[k.strip()] = v.strip()
                n = int(next((v for k, v in hdrs.items() if k.lower() == 'content-length'), '0') or 0)
                body = (await r.readexactly(n)).decode('latin-1') if n else ''
                host = next((v for k, v in hdrs.items() if k.lower() == 'host'), f'host.sim.internal:{port}')
                t1 = time.time(); nlog('http', f'HTTP {method} {host} {path} (guest TCP :{port}, {n} B body)', method=method, host=host, path=path)
                nid[0] += 1; i = nid[0]; fut = asyncio.get_event_loop().create_future(); pending[i] = fut
                await ws.send_json({'t': 'net', 'id': i, 'k': 'http', 'via': 'lwip', 'method': method, 'url': f'http://{host}{path}', 'headers': hdrs, 'body': body})
                try: code, rb = await asyncio.wait_for(fut, 10)
                except asyncio.TimeoutError:
                    nlog('http', f'HTTP {method} {host}{path} -> no answer from browser devices in 10 s (is the page open?)', ok=False); raise
                ms = round((time.time() - t1) * 1000)
                nlog('http', f'HTTP {method} {host}{path} -> ' + (f'{code} ({len(rb)} B, {ms} ms)' if code > 0 else f'no virtual device at this address -> connection closed ({ms} ms)'), ok=0 < code < 400, status=code, ms=ms)
                if code > 0:
                    rb = rb.encode('latin-1', errors='replace')
                    w.write(f'HTTP/1.1 {code} {"OK" if code == 200 else "Error"}\r\nContent-Type: application/json\r\nContent-Length: {len(rb)}\r\nConnection: close\r\n\r\n'.encode() + rb)
                    await w.drain()
            except Exception as e:
                print('http bridge:', repr(e))
                if not isinstance(e, asyncio.TimeoutError): nlog('http', f'HTTP bridge error on :{port}: {type(e).__name__}', ok=False)
            finally:
                w.close()
        return h
    nic = ['-nic', 'none']
    if netmode == 'lwip':
        fw = []
        for port in (8080, 8060, 80):
            sp = str(tmp / f'http{port}.sock'); hsrvs.append(await asyncio.start_unix_server(http_handler(port), sp))
            fw.append(f'guestfwd=tcp:10.0.2.100:{port}-cmd:{sys.executable} {HERE / "relay.py"} {sp}')
        # hub 0: open_eth NIC + slirp (DHCP/DNS/TCP guest-forwards) + a raw-frame tap to this server (real UDP to LAN devices)
        loop = asyncio.get_event_loop()
        tap = FrameTap(ws, nlog)
        tr, _ = await loop.create_datagram_endpoint(lambda: tap, local_addr=('127.0.0.1', 0))
        tport = tr.get_extra_info('sockname')[1]
        qport = free_udp_port()
        tap.peer = ('127.0.0.1', qport); taps.append(tr); udp_taps[id(ws)] = tap
        nic = ['-net', 'nic,model=open_eth', '-net', 'user,' + ','.join(fw),
               '-net', f'socket,udp=127.0.0.1:{tport},localaddr=127.0.0.1:{qport}']
    gsrv = await asyncio.start_unix_server(on_gpio, gsock); hold['gsrv'] = gsrv
    ssrv = await asyncio.start_unix_server(on_uart, ssock); hold['ssrv'] = ssrv
    args = [QEMU, '-display', 'none', '-machine', 'esp32', '-drive', f'file={flash},if=mtd,format=raw', *nic,
            '-chardev', f'socket,id=ser,path={ssock}', '-serial', 'chardev:ser',
            '-chardev', f'socket,id=gp,path={gsock}', '-global', 'driver=esp32.gpio,property=chardev,value=gp',
            '-drive', f'file={efuse},if=none,format=raw,id=efuse', '-global', 'driver=nvram.esp32.efuse,property=drive,value=efuse',
            '-L', ROMDIR, '-monitor', 'none']
    if ICOUNT: args += ['-icount', ICOUNT]
    if bid in runs: pass
    proc = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    hold['proc'] = proc; runs[id(ws)] = proc
    await ws.send_json({'t': 'status', 'msg': 'qemu started', 'pid': proc.pid, 'cap_s': RUN_CAP})
    nlog('wifi', 'network: ' + ('open_eth NIC + slirp (DHCP 10.0.2.x, virtual devices at 10.0.2.100:80/8060/8080, LAN UDP via frame tap)' if netmode == 'lwip' else 'UART shim' if netmode else 'no network library in this sketch'))
    try:
        await asyncio.wait_for(ready.wait(), 10)
    except asyncio.TimeoutError:
        out = (await proc.stdout.read(4000)).decode(errors='replace') if proc.stdout else ''
        await ws.send_json({'t': 'error', 'msg': 'qemu did not connect: ' + sanitize(out)})
        if proc.returncode is None:
            proc.kill()
            try: await proc.wait()
            except Exception: pass
        try: await ws.close()
        except Exception: pass
        return
    gr, gw = conns['g']; sr, sw = conns['s']
    gc = {'on': GPIO_CACHE, 'cache': {}, 'ep': 0, 'muxver': 0, 'S': None, 'seq': 0, 'pend': {}, 'out': None, 'hits': 0,
          'i2cfast': False, 'i2cack': {}, 'i2cpend': None, 'lastI': (0, 0), 'bwait': False}
    t0 = time.monotonic()
    def pending_req():
        out = []
        if gc['out'] is not None and gc.get('outm') and gc['outm'].get('q') == gc['out']: out.append({k: v for k, v in gc['outm'].items() if k != '_n'})
        if gc.get('adcq'): out.append(gc['adcq'])
        return out
    link.pending_req = pending_req
    async def watchdog():
        k = 0
        while True:
            await asyncio.sleep(1); k += 1
            if k % 4 == 0: await link.ping()
            g_ = CLOSED_GRACE if link.soft else RESUME_GRACE
            if g_ and link.ws is None and time.monotonic() - link.detached_at > g_:
                print(f'run {link.sid}: no browser for {g_:.0f}s ({"tab closed" if link.soft else "resume grace"}), stopping QEMU'); return
            if RUN_CAP and time.monotonic() - t0 > RUN_CAP:
                await ws.send_json({'t': 'error', 'msg': f'session time cap reached ({RUN_CAP:.0f}s, SIM_RUN_CAP)'}); return
    async def pump_gpio():
        spib = []   # coalesced SPI write-only bytes (TFT pixel streams): one ws message per burst
        i2cb = []   # coalesced I2C write bytes (fast path only)
        async def flush_i2c():
            if i2cb:
                await ws.send_json({'t': 'i2c', 'op': 'W', 'a': list(i2cb)}); i2cb.clear()
        async def flush_spi():
            if spib:
                await ws.send_json({'t': 'spi', 'bus': spib[0][0], 'r': 0, 'hex': ''.join(h for _, h in spib)}); spib.clear()
        while True:
            line = await gr.readline()
            if not line: break
            p = line.decode().split()
            ts = time.monotonic() - t0
            if p[0] == 'J' and gc['i2cfast'] and len(p) > 2 and p[1] == 'W':
                i2cb.append(int(p[2]))
                if len(i2cb) < 4096 and len(getattr(gr, '_buffer', b'')) > 0: continue
                await flush_i2c(); continue
            await flush_i2c()
            if p[0] == 'U' and p[2] == '0' and len(p) > 3:
                if spib and spib[0][0] != int(p[1]): await flush_spi()
                spib.append((int(p[1]), p[3]))
                if len(spib) < 2000 and len(getattr(gr, '_buffer', b'')) > 0: continue
                await flush_spi(); continue
            await flush_spi()
            if p[0] == 'U':
                await ws.send_json({'t': 'spi', 'bus': int(p[1]), 'r': int(p[2]), 'hex': p[3] if len(p) > 3 else ''})
            elif p[0] in ('S', 'M', 'R'):
                if p[0] == 'S': gc['S'] = tuple(p[1:5]); m = {'t': 'gpio', 'ts': ts, 'out': int(p[1]), 'out1': int(p[2]), 'en': int(p[3]), 'en1': int(p[4])}
                else: gc['muxver'] += 1; m = {'t': 'mux' if p[0] == 'M' else 'rtc', 'ts': ts, 'off': int(p[1]), 'v': int(p[2])}
                gc['seq'] += 1; q = m['q'] = gc['seq']; key = (gc['S'], gc['muxver'])
                hit = gc['cache'].get(key) if gc['on'] else None
                if hit is not None:
                    gw.write(f"I {hit[0]} {hit[1]}\n".encode()); gc['lastI'] = hit; m['fast'] = 1; gc['hits'] += 1; gc['out'] = None
                else:
                    gc['pend'][q] = (key, gc['ep']); gc['out'] = q; gc['outm'] = m
                    if len(gc['pend']) > 512: gc['pend'].clear()
                await ws.send_json(m)
            elif p[0] == 'F':
                await ws.send_json({'t': 'fsel', 'ts': ts, 'pin': int(p[1]), 'sig': int(p[2])})
            elif p[0] == 'T':
                await ws.send_json({'t': 'rmt', 'ts': ts, 'ch': int(p[1]), 'tick_ns': int(p[2]), 'car_hi': int(p[3]), 'car_lo': int(p[4]), 'car_en': int(p[5]), 'items': p[6:]})
            elif p[0] == 'P':
                await ws.send_json({'t': 'pwm', 'ts': ts, 'ch': int(p[1]), 'duty': int(p[2]), 'res': int(p[3]), 'div': int(p[4])})
            elif p[0] == 'J':
                m = {'t': 'i2c', 'op': p[1], 'a': [int(x) for x in p[2:]]}
                if p[1] == 'S' and gc['i2cfast']:
                    k_ = tuple(p[2:4]); hit = gc['i2cack'].get(k_)
                    if hit is not None:
                        li = gc['lastI']; gw.write(f"K {hit}\nI {li[0]} {li[1]}\n".encode()); m['fast'] = 1; gc['i2cpend'] = None
                    else: gc['i2cpend'] = (k_, gc['ep'])
                if (p[1] == 'S' and not m.get('fast')) or p[1] == 'R': gc['bwait'] = True   # QEMU now blocks for K/B (+ I)
                await ws.send_json(m)
            elif p[0] == 'Q':
                gc['adcq'] = {'t': 'adcq', 'ts': ts, 'u': int(p[1]), 'ch': int(p[2])}; gc['bwait'] = True
                await ws.send_json({'t': 'adcq', 'ts': ts, 'u': int(p[1]), 'ch': int(p[2])})
            elif p[0] == 'X':
                await ws.send_json({'t': 'reset', 'ts': ts})
    ubuf = ['']
    async def pump_uart():
        while True:
            d = await sr.read(4096)
            if not d: break
            txt = d.decode('latin-1')
            await ws.send_json({'t': 'uart', 'd': txt})
            if nl_on[0]:
                ubuf[0] += txt
                *lines, ubuf[0] = ubuf[0].split('\n'); ubuf[0] = ubuf[0][-2000:]
                for ln in lines:
                    ln = ln.strip()
                    if ln.startswith('[qemu-eth]'):
                        b_ = ln[10:].strip(); k_ = 'dns' if b_.startswith('DNS') else 'tcp' if b_.startswith('connect') else 'wifi'
                        nlog(k_, b_, ok='fail' not in b_.lower())
                    elif ln.startswith('[net]'): nlog('fw', ln[5:].strip(), ok=not re.search(r'fail|error|-\d+\b|no reply|timeout', ln, re.I))
    async def pump_ws():
        while True:
            m = await ws.receive_json()
            t = m.get('t')
            if t == 'in' and 'q' in m:      # reply to a specific S/M/R request (see GPIO_CACHE)
                v = (int(m.get('in', 0)) & 0xffffffff, int(m.get('in1', 0)) & 0xff)
                pe = gc['pend'].pop(int(m['q']), None)
                if pe and pe[1] == gc['ep'] and gc['on']:
                    if len(gc['cache']) > 4096: gc['cache'].clear()
                    gc['cache'][pe[0]] = v
                if gc['out'] == int(m['q']) or not gc['on']:
                    gc['out'] = None; gw.write(f"I {v[0]} {v[1]}\n".encode()); gc['lastI'] = v; await gw.drain()
            elif t == 'inv':
                gc['ep'] += 1; gc['cache'].clear(); gc['i2cack'].clear(); gc['i2cpend'] = None
                await ws.send_json({'t': 'invack'})
            elif t == 'gcache':
                gc['on'] = GPIO_CACHE and bool(m.get('on', True)); gc['cache'].clear(); gc['ep'] += 1
            elif t == 'in':
                gc['ep'] += 1; gc['cache'].clear()
                gc['lastI'] = (int(m.get('in', 0)) & 0xffffffff, int(m.get('in1', 0)) & 0xff)
                # QEMU is blocked on a GPIO/pin-config request: let the page's own (q) answer release it. Answering with
                # these inputs would hand the firmware a value computed before the page saw that request (e.g. a DHT22
                # bit clocked by the pull-up toggle); the q answer is computed later and includes this input change too.
                if gc['out'] is not None: continue
                # QEMU's sync_wait() returns on the first I line: an unsolicited input update (button press) arriving while it
                # waits for an I2C ACK / read byte / ADC value would end the wait early (I2C NACK -> lost byte). Hold it; the
                # page's i2cr/adc answer is always followed by a fresh 'in', which delivers these inputs.
                if gc['bwait']: continue
                # An unsolicited I can still sit unread in QEMU's socket when the firmware starts its next I2C transfer;
                # sync_wait() would then take it as the answer with the ACK flag still at "NACK" and the byte is lost
                # (fatal for an HD44780 nibble stream). Prefixing "K 0" makes such a stale answer an ACK (the page's own
                # answer for that start follows and is equally harmless if it lands on a later wait).
                gw.write(f"K 0\nI {gc['lastI'][0]} {gc['lastI'][1]}\n".encode()); await gw.drain()
            elif t == 'netr':
                f = pending.pop(int(m.get('id', 0)), None)
                if f and not f.done(): f.set_result((int(m.get('code', -1)), str(m.get('body', ''))))
            elif t == 'udpr':
                tp = udp_taps.get(id(ws))
                if tp: tp.reply(m)
            elif t == 'i2cfast':
                gc['i2cfast'] = I2C_FAST and bool(m.get('on', True)); gc['i2cack'].clear(); gc['i2cpend'] = None
            elif t == 'i2cr':
                gc['bwait'] = False
                if 'ack' in m:
                    gw.write(f"K {int(m['ack'])}\n".encode())
                    pe = gc['i2cpend']; gc['i2cpend'] = None
                    if pe and pe[1] == gc['ep'] and gc['i2cfast']: gc['i2cack'][pe[0]] = int(m['ack'])
                if 'b' in m: gw.write(f"B {int(m['b']) & 0xff}\n".encode())
                await gw.drain()
            elif t == 'spir':
                gw.write(f"V {''.join(c for c in str(m.get('hex', '')) if c in '0123456789abcdefABCDEF')[:128]}\n".encode()); await gw.drain()
            elif t == 'spicfg':
                gw.write(f"Z {int(m.get('mask', 0)) & ((1 << 40) - 1)}\n".encode()); await gw.drain()
            elif t == 'adc':
                gc['adcq'] = None; gc['bwait'] = False
                gw.write(f"A {int(m.get('u', 0))} {int(m.get('ch', 0))} {int(m.get('v', 0)) & 0xffff}\n".encode()); await gw.drain()
            elif t == 'uart':
                sw.write(m.get('d', '').encode('latin-1', errors='replace')); await sw.drain()
            elif t == 'sync':
                gw.write(b'Y 1\n' if m.get('on') else b'Y 0\n'); await gw.drain()
            elif t == 'netlog':
                nl_on[0] = NETLOG and bool(m.get('on', True))
            elif t == 'stop' and m.get('why') == 'pagehide':   # tab closing/reloading: short grace instead of an instant kill
                link.soft = True; print(f'run {link.sid}: tab closed/reloaded -> {CLOSED_GRACE:.0f}s grace')
            elif t == 'stop':
                print(f'run {link.sid}: stop requested by browser ({m.get("why", "user")})'); break
    async def pump_qemu():
        with open(BUILDS / 'qemu-last.log', 'wb') as f:
            while True:
                d = await proc.stdout.read(4096)
                if not d: break
                f.write(d); f.flush()
        await proc.wait()
    tasks = [asyncio.create_task(x) for x in (pump_gpio(), pump_uart(), pump_ws(), pump_qemu(), watchdog())]
    try:
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for t in done:
            print(f'run {link.sid}: ended ({["gpio","uart","ws/stop","qemu-exit","watchdog"][tasks.index(t)]}) qemu rc={proc.returncode}')
            if t.exception() and not isinstance(t.exception(), WebSocketDisconnect): print('run error:', repr(t.exception()))
    finally:
        for t in tasks: t.cancel()
        if proc.returncode is None:
            proc.kill(); await proc.wait()
        runs.pop(id(ws), None)
        gsrv.close(); ssrv.close()
        for h_ in hsrvs: h_.close()
        for t_ in taps: t_.close()
        udp_taps.pop(id(ws), None)
        shutil.rmtree(tmp, ignore_errors=True)
        nlog('wifi', 'session ended: link down')
        try:
            await ws.send_json({'t': 'exit', 'code': proc.returncode})
        except Exception: pass

# ---------------- optional server-side project copies (My Projects "server copy") ----------------
PROJ_DIR = Path(os.environ.get('SIM_PROJECT_DIR', HOME / '.esp32lab/projects')); PROJ_MAX = 500
def _pid(i): return i if re.fullmatch(r'[A-Za-z0-9_-]{1,40}', i or '') else None
@app.get('/api/projects')
def proj_list():
    out = []
    if PROJ_DIR.exists():
        for f in sorted(PROJ_DIR.glob('*.json'), key=lambda f: -f.stat().st_mtime)[:PROJ_MAX]:
            try: out.append({'id': f.stem, 'name': json.loads(f.read_text()).get('name', f.stem), 'updated': int(f.stat().st_mtime * 1000)})
            except Exception: pass
    return out
@app.get('/api/projects/{pid}')
def proj_get(pid: str):
    i = _pid(pid); f = PROJ_DIR / f'{i}.json'
    if not i or not f.exists(): return JSONResponse({'error': 'not found'}, 404)
    return JSONResponse(json.loads(f.read_text()))
@app.put('/api/projects/{pid}')
async def proj_put(pid: str, request: Request):
    i = _pid(pid); body = await request.body()
    if not i: return JSONResponse({'error': 'bad id'}, 400)
    if len(body) > MAX_BODY: return JSONResponse({'error': 'too large'}, 413)
    try: o = json.loads(body); assert isinstance(o, dict) and isinstance(o.get('parts'), list)
    except Exception: return JSONResponse({'error': 'not a project'}, 400)
    PROJ_DIR.mkdir(parents=True, exist_ok=True)
    if len(list(PROJ_DIR.glob('*.json'))) >= PROJ_MAX and not (PROJ_DIR / f'{i}.json').exists(): return JSONResponse({'error': 'project limit'}, 507)
    tmp = PROJ_DIR / f'.{i}.tmp'; tmp.write_text(json.dumps(o)); tmp.replace(PROJ_DIR / f'{i}.json')
    return {'ok': True, 'id': i}
@app.delete('/api/projects/{pid}')
def proj_del(pid: str):
    i = _pid(pid)
    if i and (PROJ_DIR / f'{i}.json').exists(): (PROJ_DIR / f'{i}.json').unlink()
    return {'ok': True}

@app.get('/')
def index(): return FileResponse(SITE / 'index.html')
app.mount('/', StaticFiles(directory=str(SITE)), name='site')

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--port', type=int, default=8765); ap.add_argument('--host', default='127.0.0.1')
    a = ap.parse_args()
    print(f'QEMU={QEMU}\nROMDIR={ROMDIR}\nCLI={CLI}\nFQBN={FQBN}')
    uvicorn.run(app, host=a.host, port=a.port, log_level='warning')
