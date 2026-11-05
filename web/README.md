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
- `server/server.py`: FastAPI. `/api/compile` runs arduino-cli. `WS /api/run/{id}` starts QEMU and relays the GPIO bridge, UART and the HTTP guest-forward.
- `server/qemu-patch/`: the QEMU patch plus its BASE_COMMIT.
- `server/shims/QemuEth`: the open_eth + lwIP WiFi replacement, with a DNS hook for `*.sim.internal` (and legacy `*.wokwi.internal`).
- `server/shims/QemuNet`: a UART-only fallback, used when the request asks for `"net":"shim"`.
- `js/`: the editor, solver, parts, the runtime bridge and the mock devices.

## Tests
- `node --test tests/*.test.js`: solver, JS-sketch runner, remote logic and the network log.
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
