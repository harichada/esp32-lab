# ESP32 Lab — on-device compiler (Android arm64)

Compiles an Arduino sketch for **ESP32 (esp32 devkit / esp32doit-devkit-v1)** fully offline on the phone.
Toolchain: Espressif `xtensa-esp-elf` gcc 14.2.0 (esp-14.2.0_20260121, = arduino `esp-x32 2601`) **linux-aarch64 glibc build**,
Arduino-ESP32 core **3.3.12** + its esp32 SDK libs. No arduino-cli, no python, no esptool on device.

## How it runs on Android 10+ (bundle-2 "loader" design — v1 symlink/relative-interp design is gone)
Rule: **every exec()/PROT_EXEC mmap targets a real file in `nativeLibraryDir`**; app data holds only non-executable data.
* jniLibs/arm64-v8a (19 files):
  * `libesp32compile.so` launcher, `libesp32wrap.so` gcc -wrapper shim, `libesp32img.so` elf2image/merge — **static bionic** (NDK r27, android29), no loader needed.
  * `libldlinux64.so` = glibc **2.31** ld.so (Debian 11; predates clone3/rseq usage, which Android's app seccomp can SIGSYS on), plus `libc6.so libm6.so libdl2.so libpthread0.so libgcc_s1.so libstdcxx6.so`.
    Sonames are renamed *in place* inside every ELF's string table (`src/renamelibs.py`; e.g. `libc.so.6`→`libc6.so`) so the files can carry extractable `lib*.so` names. No patchelf.
  * Toolchain ELFs: `libxgcc.so libxgxx.so libxcc1.so libxcc1plus.so libxas.so libxld.so libxar.so libxsize.so libxtensa_esp32.so` (dynconfig, dlopen'ed via `XTENSA_GNU_CONFIG`).
* Each tool runs as `$NLD/libldlinux64.so --library-path $NLD $NLD/libxgcc.so ...` (loader invoked explicitly → PT_INTERP unused).
* gcc gets `-wrapper $NLD/libesp32wrap.so`: its sub-programs (cc1, cc1plus, as, collect2/ld) are not found as files, so gcc
  runs `wrap <name> args`; the shim maps the name to the real file and execs the loader. collect2 is replaced by ld (collect2-only `-f*`/plugin args dropped; link uses `-fno-use-linker-plugin`).
* `compile.sh` is only *read* by `/system/bin/sh` (mksh) and uses toybox commands only (find sed grep cat cp mkdir basename timeout).
  Every step runs under `timeout` (`ESP32LAB_STEP_TIMEOUT`, default 150 s) and prints `== step` / `-- file` progress lines; a failure prints `ERROR: step failed/timed out: <step>`.
* `--selftest`: runs every binary `--version` with a 5 s timeout plus a tiny `gcc -c` through the wrapper; exit 0 = OK. The app runs it before the first compile and from `/api/diag`.
* elf2image/merge: C port, byte-identical to esptool 5.3.1. bootloader/partitions/boot_app0 prebuilt (4 MB DIO). Core archives prebuilt by this arm64 toolchain (`cache/core-*.a`, dio_qspi).

## Exact command line (matches INTEGRATION.md §2)
```
cwd=<any build dir>  env: ESP32LAB_HOME=<filesDir>/toolchain  ESP32LAB_BIN=<nativeLibraryDir>  TMPDIR=<cacheDir>
<nativeLibraryDir>/libesp32compile.so --fqbn esp32:esp32:esp32doit-devkit-v1 --sketch <dir> --out <outdir> --home <filesDir>/toolchain [--define NAME[=V]]... [--net lwip|shim]
<nativeLibraryDir>/libesp32compile.so --selftest --home <filesDir>/toolchain      # diagnostics
```
Exit 0 ⇒ `<outdir>/flash.bin` (4 MiB merged: 0x1000 bootloader, 0x8000 partitions, 0xe000 boot_app0, 0x10000 app),
plus `sketch.ino.elf`, `sketch.ino.bin`, `sketch.ino.map`. Log on stdout/stderr.
**Differences:** `--fqbn` accepts only `esp32:esp32:esp32` and `…:esp32doit-devkit-v1`; `--net` is accepted but ignored
(QemuEth/QemuNet shim sources are not in this bundle — add them to the sketch dir or extend compile.sh's link line).
Sketch preprocessing is a simplified arduino-builder: all `*.ino` concatenated, `#include <Arduino.h>` + regex-generated
prototypes; extra `.c/.cpp/.S` in the sketch dir are compiled; bundled core libraries (WiFi, Wire, SPI, …) are compiled
when the sketch `#include`s one of their headers (no transitive dependency resolution).
The sketch must be in `<dir>/*.ino` (any name).

## Files
* `build_bundle.sh` — produces `out/jniLibs/arm64-v8a/*.so` + `out/payload/toolchain/toolchain.tar` from the Espressif tarball + ~/.arduino15.
* `install_into_app.sh` — copies them into `app-project/app/src/main/{jniLibs,assets/payload}` (bump payload VERSION).
* `src/launcher.c`, `src/wrap.c`, `src/compile.sh`, `src/esp32img.c`, `src/renamelibs.py`, `prebuilt/`.
* `test_noexec.sh` — Android simulation: app data on a **noexec tmpfs**, nativeLibraryDir=/tmp/nld, toybox + mksh, `env -i`, qemu-aarch64 binfmt.

## Re-test on the box
`./build_bundle.sh && ./test_noexec.sh` (needs qemu-user binfmt registered, toybox, mksh, NDK r27, glibc 2.31 debs in /workspace/tc-dl/g231/x).
