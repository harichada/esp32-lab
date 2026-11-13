# ESP32 Lab — browser ESP32 simulator

Write Arduino sketches for ESP32 in the browser, compile them with arduino-cli (esp32 core 3.3.12) and run them on a
patched Espressif QEMU with virtual parts (LEDs, buttons, keypad, OLED/LCD/TFT, NeoPixel, servo, sensors…), streamed over WebSocket.

**Live:** http://129.158.200.25/

Header fit on every UI change: `npm run test:e2e`

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
  --security-opt seccomp=/home/opc/seccomp-bwrap.json \
  --security-opt no-new-privileges \
  -v esp32lab-data:/home/sim/.esp32lab -v esp32lab-cache:/home/sim/.cache/arduino esp32-lab
```

A test copy is a second process on `127.0.0.1`, reached at `http://<live>/staging/` through the live server. Leave `SIM_STAGING_UPSTREAM` unset until that process is running: empty means `/staging/` is 404 and the live site is unchanged. Do not publish the test copy on port 8080. See `web/README.md` for `SIM_STAGING`, `SIM_ACCESS_TOKEN`, `SIM_BASE_PATH`, the cookie, and the two-process local start.

`deploy/seccomp-bwrap.json` is the Docker 29.9.3 default seccomp profile (moby/profiles `seccomp/default.json` at `245180c51918481c0525424b3ee025d2b435d46c`, tag `seccomp/v0.2.4`) plus `clone`, `clone3`, `unshare`, `mount`, `umount2`, `setns`, and `pivot_root`. `deploy/seccomp-bwrap.md` records the rule changes and `deploy/check_seccomp.py` checks them. Copy that file to `/home/opc/seccomp-bwrap.json` on the host. Do not pass `--privileged` or `--cap-add`. Rolling back uses the live v66 image `e3d38a538a45` (tag `rollback-keep-v66`) plus `/home/opc/backup-v66` and a fresh projects snapshot. The second fallback is the v65 image `356f7c19711d` plus `/home/opc/backup-v65`. On that rollback, drop the `seccomp=` option so Docker's default filter is used again.

Before copying `qemu-gpio` into the image context, and again after `esp32lab` is running, check that QEMU starts with the server's spawn environment and that `ldd` has no `not found` lines. `SIM_QEMU_LIB_DIRS` (see `web/README.md`) appends a root-owned library directory that is outside the QEMU prefix, such as the one that provides `libslirp.so.0`, after QEMU's own lib dirs. `/health` and `/api/health` report `qemu_ok` and `sandbox_ok`; `ok` is false when either is false. A failed QEMU check stops a run with "The simulator couldn't start. Try again in a minute." QEMU itself runs under bubblewrap with `--unshare-all` (only `lo`). Bubblewrap is the only sandbox; a missing `bwrap` refuses compiles and runs.

```
# before the copy, from web/ so `import server` finds the module
cd web/server
python3 -c 'import server,subprocess,sys; env=server.qemu_run_env(romdir=server.ROMDIR, qemu_bin=server.QEMU); p=subprocess.run([server.QEMU,"--version"],env=env,capture_output=True,text=True); sys.stdout.write(p.stdout); sys.stderr.write(p.stderr); raise SystemExit(p.returncode)'
ldd "$(readlink -f "${QEMU_BIN:-$HOME/qemu-gpio/bin/qemu-system-xtensa}")" | grep -F 'not found' && exit 1

# after the container is up (workdir is /app/server)
docker exec esp32lab python3 -c 'import server,subprocess,sys; env=server.qemu_run_env(romdir=server.ROMDIR, qemu_bin=server.QEMU); p=subprocess.run([server.QEMU,"--version"],env=env,capture_output=True,text=True); sys.stdout.write(p.stdout); sys.stderr.write(p.stderr); raise SystemExit(p.returncode)'
docker exec esp32lab sh -c 'ldd "$QEMU_BIN" | grep -F "not found" && exit 1 || exit 0'
```
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
