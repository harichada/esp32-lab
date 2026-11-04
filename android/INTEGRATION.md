# ESP32 Lab Android — integration points

Project: `app-project/` (AGP 8.5.2, Kotlin 1.9.24, NanoHTTPD 2.3.1 + websocket). Build:
`cd app-project && JAVA_HOME=/opt/android-sdk/jdk17 ./gradlew assembleDebug && cp app/build/outputs/apk/debug/app-debug.apk ../ESP32Lab.apk`

All paths live in `app/src/main/java/com/hari/esp32lab/Paths.kt`. `extractNativeLibs=true` + `useLegacyPackaging`, so each
`jniLibs/arm64-v8a/lib*.so` is extracted to `nativeLibraryDir` and is exec()'d from there (the only exec-allowed dir on API 29+).
Every binary must be **static or bionic-linked aarch64 PIE**, min API 24. `LD_LIBRARY_PATH=nativeLibraryDir` is set, so extra
shared libs can be shipped there too as `lib*.so`.

## 1. Web UI
`app/src/main/assets/site/` = copy of `/workspace/esp32-remote/sim-site` (minus server/, tests/). Served at
`http://127.0.0.1:8765/` (falls back to a random port) by `LabServer` inside the foreground `ServerService`; shown in a full-screen WebView.

## 2. Compiler (toolchain agent)
- Binary: `app/src/main/jniLibs/arm64-v8a/libesp32compile.so` (a launcher executable; name must start with `lib`, end in `.so`).
- Data: put files under `app/src/main/assets/payload/toolchain/` (a `*.tar` there is auto-extracted with `/system/bin/tar`).
  Unpacked to `filesDir/toolchain/` on first launch; **bump `assets/payload/VERSION`** to force re-unpack. Optional `toolchain/VERSION` is part of the build-cache key.
- Invocation (from `Toolchain.compile` in `LabServer.kt`), cwd = build dir:
  `libesp32compile.so --fqbn esp32:esp32:esp32doit-devkit-v1 --sketch <dir with sketch.ino + .h/.cpp> --out <outdir> --home <filesDir/toolchain> [--define NAME[=V]]... [--net lwip|shim]`
  Env: `ESP32LAB_HOME`=toolchain home, `ESP32LAB_BIN`=nativeLibraryDir (to find sibling compilers e.g. `libxtensa-gcc.so`), `TMPDIR`, `HOME`.
- Contract: stdout+stderr = build log; exit 0 on success and leave `<outdir>/flash.bin` **or** `<outdir>/*.ino.merged.bin`
  (bootloader+partitions+app, DIO). Shell pads to 4 MiB. Timeout 300 s. `--net lwip` ⇒ link QemuEth shim with `--wrap=lwip_getaddrinfo,--wrap=lwip_connect`; `shim` ⇒ QemuNet (same as server.py).
- If the toolchain README mandates a different CLI, change only `Toolchain.compile()`.

## 3. QEMU (qemu agent)
- Binary: `app/src/main/jniLibs/arm64-v8a/libqemu-system-xtensa.so` (patched esp32-gpio-bridge build from `/workspace/esp32-lab-android/qemu`).
- ROMs: `app/src/main/assets/payload/qemu-rom/` (esp32-v3-rom.bin, esp32-v3-rom-app.bin, …) → `filesDir/qemu-rom`, passed as `-L`.
- Command line (`QemuSession.run` in `RunSocket.kt`) is server.py's, except chardevs are **TCP clients to loopback** instead of unix sockets:
  `-display none -machine esp32 -drive file=flash.bin,if=mtd,format=raw -nic none -chardev socket,id=ser,host=127.0.0.1,port=P1 -serial chardev:ser -chardev socket,id=gp,host=127.0.0.1,port=P2 -global driver=esp32.gpio,property=chardev,value=gp -drive file=efuse.bin,if=none,format=raw,id=efuse -global driver=nvram.esp32.efuse,property=drive,value=efuse -L <rom> -monitor none -icount shift=4,align=off,sleep=on`
  ⇒ the QEMU build needs `slirp` only if lwip networking is wanted (`-net nic,model=open_eth -net user`).
- GPIO line protocol bridged exactly as server.py (S/M/R with answer cache, U/F/T/P/J/Q/X in; I/K/B/V/Z/A/Y out).

## Status (2026-11-03, payload VERSION 3-toolchain-3.3.12-dio-qemu9.2.2-slirp)
- Stubs removed: real compiler + QEMU wired. FQBNs allowed: esp32:esp32:esp32, esp32:esp32:esp32doit-devkit-v1 (others -> 400).
- Toolchain ships as `assets/payload/toolchain/toolchain.tgz` (52 MB, from 229 MB tar). **Must be .tgz, not .tar.gz** (AGP gunzips *.gz assets).
  Extracted in-process by `AssetUnpacker.untar` (GNU/pax/ustar, symlinks); progress screen in MainActivity on first run.
- compile.sh now links **dio_qspi** (was qio_qspi -> app asserted in init_flash under QEMU). Fixed in toolchain/src + build_bundle.sh + repacked tar.
- Swapping QEMU: drop a new `jniLibs/arm64-v8a/libqemu-system-xtensa.so` and rebuild. slirp is auto-detected (`-netdev help` lists `user`);
  with slirp, lwip sketches get `-net nic,model=open_eth -net user,guestfwd=tcp:10.0.2.100:{8080,8060,80}-tcp:127.0.0.1:<bridge>` (HTTP -> WS `net`/`netr`, same as server.py).
- JVM smoke harness: `harness/` runs the real LabServer/RunSocket/AssetUnpacker sources with android stubs; aarch64 ELFs via binfmt qemu-aarch64:
  `cd harness && ./gradlew installDist && build/install/harness/bin/harness ../app-project/app/src/main /tmp/w sketch.ino 75`

## Not ported
- WS resume (`?sid=&since=`) answers "expired"; no message ring.
- UDP frame tap to LAN devices (10.13.37.2, `udpr`) not ported. HTTP guest-forward to 10.0.2.100 is ported but not yet smoke-tested.
- Token gate / header allow-list (`check_sources`) not ported (local only).
