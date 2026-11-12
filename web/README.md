# ESP32 Circuit Lab — local ESP32 + electronics simulator

It runs real ESP32 firmware: sketches are compiled by arduino-cli (esp32 core 3.3.12) and executed in Espressif's QEMU, with a patch that bridges the chip's pins to a circuit solver running in the browser.

## Quick start (your own machine: Linux, macOS or WSL2)
    ./setup.sh            # installs arduino-cli + the esp32 core, builds patched QEMU, creates a Python venv, starts the server
    ./setup.sh --start    # later runs
Then open http://127.0.0.1:8765/

Everything installs under `~/.esp32lab`. You need about 3 GB of disk; the first QEMU build takes 10–30 minutes.

Manual start, if the dependencies are already installed:

    QEMU_BIN=... QEMU_ROM_DIR=... python3 server/server.py --port 8765

`?ex=blink|button|pot|potjs|rc|transistor|remote|blank` opens an example directly.

## What is emulated
| Stage | Status |
|---|---|
| 1. Compile, run, UART serial, digital GPIO (OUT, IN, enable, pull-ups via IO_MUX/RTCIO), RMT IR TX | ✅ works with unmodified Blink and Button |
| 2. SAR ADC (`analogRead`), LEDC PWM (`analogWrite`/`ledcWrite`), timers | ✅ ADC: the chip is modelled as the exact inverse of ESP-IDF's line-fitting calibration (eFuse Vref 1100 mV burned in the QEMU eFuse image, plus the IDF high-range LUT), i.e. a typical chip's non-linear response. `analogRead` gives the raw code a real chip would and `analogReadMilliVolts` is within ±1 mV up to the 3.13 V ceiling. LEDC duty, frequency and hardware fades (`ledcFade`, fade-end interrupt) drive the pin |
| 3. Networking | ✅ `WiFi.begin()` brings up real lwIP over QEMU's open_eth NIC with slirp. The real HTTPClient runs over TCP to the mock devices. UDP (`WiFiUDP`) is real lwIP too: frames go over a QEMU hub to the server and back to the mock devices (the remote's Kasa Eco toggle). There is no 802.11 radio |
| 4. I²C | ✅ The emulated ESP32 I²C controller is bridged transaction by transaction to virtual parts: SSD1306 128×64 OLED (shows the real framebuffer), BME280 and MPU6050 (sliders in the Inspector). Unmodified Adafruit libraries work. SDA=21, SCL=22, VCC must be powered |
| 5. SPI | ✅ SPI2/SPI3 (HSPI/VSPI) user transactions are bridged to virtual parts: ILI9341 240×320 TFT (CASET/RASET/RAMWR, MADCTL rotations, rendered on a canvas), MCP3008 8-channel ADC (bit-level protocol) and a microSD card (SPI-mode SDHC, 64 MB sparse FAT16 image with HELLO.TXT, read and write). Unmodified Adafruit_ILI9341, Adafruit_MCP3008 and the core SD library work. Write-only traffic (TFT pixels) is streamed and coalesced; when a CS of a MISO-driving part is low the transaction runs in lock-step |
| Not yet | Bluetooth, 802.11, deep sleep, SPI DMA (`spi_master` with DMA buffers), ST7789. A client must answer ADC/I²C requests in lock-step, otherwise the firmware waits |

The circuit solver uses modified nodal analysis with Newton–Raphson, and backward-Euler for transients. It models R, C, LED/IR LED (with burn-out), diode, zener, NPN/PNP, MOSFET, buttons, switches, pot, LDR, LDO, battery and supplies, buzzer, volt- and ammeters, and a 4-channel scope.

## Examples, My Projects and wiring
- Examples (`?ex=…`) open **read-only**. "Make a copy" (or simply editing code, defines, parts or wires) copies it into **📁 My Projects**, which auto-saves to localStorage and opens with `?p=<id>`. My Projects: open, rename, duplicate, delete, export/import JSON, and an optional **server copy** (`/api/projects`, stored in `SIM_PROJECT_DIR`, default `~/.esp32lab/projects`).
- Wiring: click a pin, then click the target pin (dragging works too). A preview follows the cursor, pins snap from a few pixels away, hovering shows the pin name (e.g. "ESP32 GPIO4") and highlights everything on the same net (breadboard strips too). Clicking empty space adds a bend, Esc cancels, and "right-angle wires" routes with L bends. Select a wire and press Delete/Backspace to remove it; right-click it for delete, colour or bends; double-click it to add a bend and drag the white handles. Ctrl+Z/Ctrl+Y undo and redo. Labelled key shortcuts only press keys while the sketch is running.

## Network log and virtual devices (Wi-Fi remote)
- **Network tab** (next to Serial): timestamped WiFi/DHCP/DNS/TCP connect/HTTP (method, host:port, path, status, bytes, latency, errors) and UDP send/recv of the emulated ESP32, decoded by the server from the QEMU network hub and the slirp guest-forwards, plus the virtual devices' reactions (`DEV`) and firmware `[net]` lines (`FW`). Filter box (`http`, `udp`, `8060`, `errors`…), Copy and Clear. Turn off with `?netlog=0` (browser) or `SIM_NETLOG=0` (server).
- **Virtual devices** (Devices tab, `js/devices.js`): Sony Bravia (IRCC SOAP + JSON-RPC `setPowerStatus`, `X-Auth-PSK`, default PSK `0000`), Roku ECP (`POST :8060/keypress/<Key>`), Eco Plug (legacy UDP 80 and KAB UDP 1022). Addresses that reach them from the emulated ESP32:
  - `host.sim.internal` (any `*.sim.internal`; legacy `*.wokwi.internal` still accepted) → 10.0.2.100, ports 80, 8060, 8080 (the `-DSIM` build: Sony `host.sim.internal:8080`, Roku `:8060`, Eco `10.13.37.2`).
  - Real LAN addresses also work: TCP to 192.168.x.x / 172.16–31.x.x / 10.x.x.x (not 10.0.2.x) on ports 80/8060/8080 is redirected to the virtual devices, and UDP to any non-slirp address goes to them. So the firmware's real targets (Sony 192.168.1.50, Roku 192.168.1.60:8060, Eco 192.168.1.70) or `SIM_SONY_HOST="192.168.1.50"` etc. in the Defines box behave the same. Build with `SIM_NO_LAN_REMAP` in Defines to switch the redirect off.
  - **Real devices**: the emulator cannot reach your home LAN (slirp NAT on the server). Flash `firmware/remote.ino` to a real ESP32 **without** `SIM`, set `WIFI_SSID`/`WIFI_PASS`, `SONY_IP` + `SONY_PSK` (TV: Network > IP control > Authentication "Normal and Pre-Shared Key"), `ROKU_IP` (Roku: Settings > System > Advanced > Control by mobile apps = Enabled/Permissive) and `ECO_IPS`, and give each device a DHCP reservation. Serial shows the same `[net]` diagnostics.
- Key taps are held until the firmware has had time to scan and debounce them, and the server caches GPIO-input answers per pad state (`SIM_GPIO_CACHE=0` / `?gcache=0` to disable) so lock-step keyboard scanning stays fast through a tunnel.

## How it fits together
- `server/server.py`: FastAPI. `/api/compile` runs arduino-cli. `WS /api/run/{id}` starts QEMU and relays the GPIO bridge, UART and the HTTP guest-forward. `server/diskkeep.py` bounds the disk those two use.
- `server/qemu-patch/`: the QEMU patch plus its BASE_COMMIT.
- `server/shims/QemuEth`: the open_eth + lwIP WiFi replacement, with a DNS hook for `*.sim.internal` (and legacy `*.wokwi.internal`).
- `server/shims/QemuNet`: a UART-only fallback, used when the request asks for `"net":"shim"`.
- `js/`: the editor, solver, parts, the runtime bridge and the mock devices.

## Disk

`/api/compile` shells out to `arduino-cli compile` (not esp-idf). A warm Blink compile used to leave about **66.3 MiB** (69,523,776 bytes) behind, which matches the production drop from ~940 MB free to ~877 MB during ordinary use. Measured with arduino-cli 1.5.1, esp32 core 3.3.12, FQBN `esp32:esp32:esp32doit-devkit-v1`, and `web/examples/Blink.ino`, after the core archive already existed. The first compile on an empty cache also writes the core archive below (2,794,876 bytes) and a slightly larger sketch tree (28,087,018 bytes).

What one warm compile used to keep, and where:

1. `{SIM_BUILD_DIR}/esp32sim-builds/<16-hex id>/` — **47,665,946 bytes**. `SIM_BUILD_DIR` defaults to the system temp dir (so this is `/tmp/esp32sim-builds/`). `setup.sh` uses `~/.esp32lab/builds`. The Docker image uses `/home/sim/builds`.

    | File | Bytes |
    |---|---:|
    | `sketch/sketch.ino` | 707 |
    | `sketch/build/esp32.esp32.esp32doit-devkit-v1/sketch.ino.map` | 11,483,387 |
    | `sketch/build/.../sketch.ino.elf` | 5,704,084 |
    | `sketch/build/.../sketch.ino.merged.bin` | 4,194,304 |
    | `sketch/build/.../sketch.ino.bin` | 257,840 |
    | `sketch/build/.../sdkconfig` | 113,980 |
    | `sketch/build/.../sketch.ino.bootloader.bin` | 23,488 |
    | `sketch/build/.../boot_app0.bin` | 8,192 |
    | `sketch/build/.../sketch.ino.partitions.bin` | 3,072 |
    | `sketch/build/.../build.options.json`, `partitions.csv`, `flash_args` | 905 |
    | `out/sketch.ino.map` | 11,483,387 |
    | `out/sketch.ino.elf` | 5,704,084 |
    | `out/sketch.ino.merged.bin` | 4,194,304 |
    | `out/sketch.ino.bin` | 257,840 |
    | `out/sketch.ino.bootloader.bin` | 23,488 |
    | `out/sketch.ino.partitions.bin` | 3,072 |
    | `flash.bin` (the image QEMU boots) | 4,194,304 |
    | `log.txt` (verbose log; 56 lines for Blink) | 15,508 |
    | `net.txt` | 0 |

    The `sketch/build/` tree is the ESP32 "export binaries" hook. `out/` is a second copy from `--output-dir`. `flash.bin` is a third copy of the merged image. Nothing deleted these except a compile timeout, which removed only this directory.

2. `~/.cache/arduino/sketches/<MD5 of the sketch path>/` — **21,857,830 bytes**. Same elf, map, and merged image again, plus `sdkconfig`, `includes.cache`, `compile_commands.json`, and a small `sketch/` preprocess dir. The directory name is the uppercase MD5 of the absolute sketch path (a different directory for every distinct sketch). arduino-cli 1.5.1's purge still scans `$TMP/arduino` (empty in this measurement) and only drops entries older than 30 days, so this tree was never removed. `$XDG_CACHE_HOME/arduino` is used instead of `~/.cache/arduino` when that variable is set.

One core archive is created on the first compile and then reused, which is what keeps the next Blink fast: `~/.cache/arduino/cores/esp32_esp32_esp32doit-devkit-v1_<hash>/core.a` (2,794,876 bytes). Installed cores and libraries (`~/.arduino15`, `~/Arduino`, or `ARDUINO_DIRECTORIES_DATA` / `ARDUINO_DIRECTORIES_USER`) are a separate, much larger tree and are not a per-compile leak.

A QEMU run copies `flash.bin` to `$TMPDIR/esp32run-<random>/flash.bin` (4,194,304 bytes) plus `efuse.bin` (124 bytes) and the gpio/uart sockets. That directory was removed when a run ended normally. It was left behind if QEMU failed to connect, or if the process was killed before the cleanup at the end of the session.

What happens now:

- Each compile uses a fresh `esp32build-*` directory for the sketch and for `--output-dir`. It is deleted in a `finally` block after `flash.bin` is published, or the compile fails, or it times out. The matching `sketches/<MD5>` tree is deleted in that same `finally`. `--build-path` is not passed: on arduino-cli 1.x that flag turns off the core cache and rebuilds the ESP32 core every time.
- The published entry is only `flash.bin`, `log.txt`, and `net.txt` (about 4.2 MB for Blink). Repeat runs of the same source are still a cache hit. The build log for a hit is only this request's line, for example `[0.0s] cached (originally built in 41.4 s)`. It does not replay the stored `[41.4s] compile` line or the stage lines from that build (`Building network stack...`, `Compiling sketch...`, `Linking...`).
- The core archive stays. It is capped by size and age, least-recently-used, and the newest archive is kept even when it is the only one over the cap. Compiled library archives under the same cache (`libraries/`), if present, are capped the same way. The installed core and library sources are never deleted.
- A network sketch (QemuEth + the Arduino `Network`, `HTTPClient` and `NetworkClientSecure` objects) used to recompile those files on every edit. arduino-cli puts them in the sketch tree, and that tree is deleted after each compile, so the ~40 s cost came back on every cache miss. The first such compile now archives those objects as `<arduino-cache>/netstack/<key>/libnetstack.a` (about 2.6 MB) plus the `libraries.cache` include list. A later edit links that archive (`--skip-libraries-discovery`) instead of rebuilding it. The key is the toolchain version and path, the esp32 core version, the FQBN, the `-D` defines, and a hash of the QemuEth sources, so a compiler or shim change misses. Defines stay in the key: `-DSIM_NO_LAN_REMAP` changes `qemu_eth.cpp`, so a different define list is a different archive. On startup the server builds the archive in the background for the defines the Wi-Fi remote example posts (`SIM`, read from `js/examples.js` and run through the same sanitizer as `/api/compile`). It skips that build when the archive is already present. `SIM_NETSTACK_WARM=0` turns the warm-up off; the default is on. Sketch deletion, firmware reclaim, and the orphan sweep leave `netstack/` in place. It has its own size and age cap; the newest archive is kept when the cap is tight, same as `core.a`.
- On startup, orphan `esp32build-*`, `esp32run-*`, and `arduino-sketch-*` directories older than an hour are removed, and existing `out/` and `sketch/` directories left by older servers are stripped off any published image. That reclaims the historical leak without throwing away `flash.bin`.
- QEMU's private directory is removed when the run ends: stop, QEMU exit, the resume grace after a disconnect, or a failed start. It is not removed while QEMU is still running for a reconnect, because the drive file has to stay.
- If free space on the build or cache filesystem is under `SIM_MIN_FREE_MB`, the server drops firmware images and sketch trees (and extra core archives) first. A filesystem smaller than that floor, such as a small `/tmp` tmpfs, only has to keep 32 MB free. If the disk is still short, `/api/compile` returns `low disk: … Compile was not started.` and does not launch arduino-cli.

On this machine the same Blink took 7.8 s with an empty core cache, 4.2 s once `core.a` existed, and 4.1 s when the sketch trees had been deleted first. Deleting the per-compile trees does not change the warm time. The server's ~8 s cold Blink is the same `arduino-cli compile` invocation as before.

| Variable | Default | Meaning |
|---|---|---|
| `SIM_BUILD_DIR` | system temp dir | Parent of `esp32sim-builds/`. Images land in `<dir>/esp32sim-builds/<id>/`. |
| `SIM_BUILD_CACHE_DIR` | (discovered) | arduino-cli build cache to cap. Also reads `ARDUINO_BUILD_CACHE_PATH`, `build_cache.path` in `arduino-cli.yaml`, `$XDG_CACHE_HOME/arduino` or `~/.cache/arduino`, and always checks `$TMP/arduino`. |
| `SIM_MIN_FREE_MB` | `300` | Free-space floor on the build and cache disks. Below it, caches are evicted and the compile is refused if still short. |
| `SIM_ORPHAN_MAX_AGE_S` | `3600` | Startup sweep age for `esp32build-*`, `esp32run-*`, and `arduino-sketch-*`. |
| `SIM_IMAGE_CACHE_MAX_MB` | `128` | Cap on published `flash.bin` entries. Live runs are not evicted. |
| `SIM_IMAGE_CACHE_MAX_AGE_S` | `604800` | Max age of a published image (7 days). |
| `SIM_SKETCH_CACHE_MAX_MB` | `0` | Cap on `sketches/` trees. `0` deletes them (they are keyed by a temp path and are not reused). Set a positive value only to keep trees for incremental rebuilds. |
| `SIM_SKETCH_CACHE_MAX_AGE_S` | `3600` | Max age of a sketch tree when the byte cap is non-zero. |
| `SIM_CORE_CACHE_MAX_MB` | `512` | Cap on `cores/` and compiled `libraries/` archives. The newest archive is always kept. |
| `SIM_CORE_CACHE_MAX_AGE_S` | `2592000` | Max age of a core archive (30 days). The newest one is kept past this age. |
| `SIM_NETSTACK_CACHE_DIR` | `<arduino-cache>/netstack` | Prebuilt QemuEth/lwIP archive. Not deleted by the sketch wipe or the orphan sweep. |
| `SIM_NETSTACK_CACHE_MAX_MB` | `64` | Cap on `netstack/<key>/` entries. The newest archive is always kept. |
| `SIM_NETSTACK_CACHE_MAX_AGE_S` | `2592000` | Max age of a network-stack archive (30 days). The newest one is kept past this age. |
| `SIM_NETSTACK_WARM` | `1` | At startup, build the network archive for the defines the browser posts (`SIM` on the Wi-Fi remote). Skips when that archive is already present. `0` turns it off. |

## Tests
- `node --test tests/*.test.js`: solver, JS-sketch runner, remote logic and the network log.
- `python3 tests/diskkeep_test.py`: firmware-image reclaim, sketch/core LRU eviction, orphan sweep, the low-disk guard, and the network-stack cache (it survives sketch cleanup and the orphan sweep, the size cap evicts the oldest entry, a shim-hash change misses, a firmware-cache hit is only the `[0.0s] cached` line, and the startup warm-up uses the browser's `SIM` define so its key matches a browser compile).
- `node --test` also covers the project store (`tests/projects.test.js`).
- `python3 tests/ui/projects_wiring_ui.py [url]`: copy-on-edit, My Projects persistence and server copy, click-click wiring, hover labels, net highlight, Delete/Backspace, right-click menu, double-click bend, Esc, undo.
- `python3 tests/ui/remote_net_ui.py [url]`: remote example end to end in Chrome (80 ms key taps, virtual TV/Roku/Eco change, Network tab content). Tests read the token from `SIM_TOKEN` or `/tmp/sim_token`.
- `python3 tests/e2e_backend.py http://127.0.0.1:8765`: real firmware for Blink, Button and the Remote, including lwIP HTTP and analogReadMilliVolts.
- `python3 tests/ui/editor_ui.py`: headless Chrome. Covers drag and drop, wiring, undo, diagram.json import, the transistor example, Stage 2 Pot→PWM (calibrated ADC + mV, including the >2.6 V range), the I²C example and the SPI example.
- `setup.sh` installs the Adafruit SSD1306/GFX/BME280/MPU6050/ILI9341/MCP3008 libraries for the I²C and SPI examples.
- Unit tests also cover the SPI parts (`tests/spidev.test.js`) and the ADC calibration inverse.

## Long runs, reconnects and the watchdog
- `SIM_RUN_CAP` (seconds, default `0` = unlimited) caps a run; `SIM_RESUME_GRACE` (default 120 s) is how long QEMU
  keeps running with no browser attached before it is cleaned up.
- Runs are resumable: every server→browser message carries a sequence number `_n` and is kept in a bounded ring
  (48 MB). If the websocket drops (e.g. an ngrok "heartbeat timeout"), the page shows **reconnecting…**, reconnects with
  back-off to `/api/run/<build>?sid=<session>&since=<last _n>`, gets everything it missed, re-sends its input/ADC state,
  and the server re-asks any outstanding lock-step GPIO/ADC request. QEMU is never restarted.
- `server/supervise.sh` (run with `setsid nohup ./supervise.sh >> /tmp/supervise.log 2>&1 < /dev/null &`) restarts
  `server.py` and `ngrok http 8765` if either dies and rewrites `/workspace/esp32-sim-link.html` with the current URL.
  `NGROK_URL=https://<reserved domain>` pins a static domain if the account has one.
- `tests/ui/resume_ui.py [base] [minutes] [ngrok_pid]` is the long-run resilience test.
