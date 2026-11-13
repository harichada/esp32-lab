# ESP32 Lab — browser ESP32 simulator

Write Arduino sketches for ESP32 in the browser, compile them with arduino-cli (esp32 core 3.3.12) and run them on a
patched Espressif QEMU with virtual parts (LEDs, buttons, keypad, OLED/LCD/TFT, NeoPixel, servo, sensors…), streamed over WebSocket.

**Live:** http://129.158.200.25/

## Structure
| Path | What |
|---|---|
| `web/` | Website (`index.html`, `js/` incl. `parts-art.js`, `bom.js`, keypad, `css/`) + Python server (`server/server.py`, FastAPI/uvicorn on :8765) + tests. Matches the live ARM VM copy. |
| `docker/arm64/` | ARM64 Dockerfile + Arduino libraries (deployed on the Oracle ARM VM). |
| `docker/amd64/` | x86_64 Dockerfile, build script, local launchers; x86 micro VM notes. |
| `android/` | Android app (offline simulator: on-device toolchain + QEMU), harness, QEMU patches/build scripts, toolchain bundling scripts. |
| `examples/` | Extra example sketches (`*.ino`) and test/screenshot scripts. |

## Deploy (ARM or x86)
```
docker build -t esp32-lab <ctx>        # see docker/arm64/README.md or docker/amd64/README.md for context staging
docker run -d --name esp32lab -p 80:8765 -p 8765:8765 --restart unless-stopped \
  -v esp32lab-data:/home/sim/.esp32lab -v esp32lab-cache:/home/sim/.cache/arduino esp32-lab
```

A test copy is a second process on `127.0.0.1`, reached at `http://<live>/staging/` through the live server. Leave `SIM_STAGING_UPSTREAM` unset until that process is running: empty means `/staging/` is 404 and the live site is unchanged. Do not publish the test copy on port 8080. See `web/README.md` for `SIM_STAGING`, `SIM_ACCESS_TOKEN`, `SIM_BASE_PATH`, the cookie, and the two-process local start.
Large binaries (QEMU build, arduino cores/toolchains, caches) are not committed — the sub-READMEs explain how to fetch/build them.

## Android APK
```
cd android/app-project
echo "sdk.dir=$ANDROID_HOME" > local.properties
../toolchain/build_bundle.sh && ../toolchain/install_into_app.sh   # stages toolchain + QEMU payload into app assets (not in repo)
./gradlew assembleRelease   # or assembleDebug
```
See `android/INTEGRATION.md`, `android/NOTES.md`, `android/toolchain/README.md`. Signing keys are not in the repo — supply your own.

Prebuilt APKs: [esp32lab-v0.5](https://github.com/harichada/trading_bot_commentary/releases/tag/esp32lab-v0.5) · [esp32lab-v0.6](https://github.com/harichada/trading_bot_commentary/releases/tag/esp32lab-v0.6)
