# ARM64 (aarch64) image — live at http://129.158.200.25/ (Oracle ARM VM)

Build context layout expected by `Dockerfile`:
```
ctx/
  Dockerfile
  app/                 <- copy of ../../web
  home/Arduino/        <- Arduino libraries (included here, incl. Keypad)
  home/qemu-gpio/      <- NOT in repo: patched Espressif QEMU (xtensa) for aarch64
     bin/qemu-system-xtensa
     share/qemu/esp32-v3-rom.bin, esp32-v3-rom-app.bin (+ other ROMs)
```
The Dockerfile itself downloads arduino-cli 1.5.1 (ARM64) and installs core `esp32:esp32@3.3.12`.

## Getting qemu-gpio (excluded, ~20 MB binary)
Build Espressif QEMU (https://github.com/espressif/qemu, base commit in `android/qemu/BASE_COMMIT`)
with `android/qemu/esp32-local-mods.patch` (+ `meson-slirp-fix.patch`) applied:
```
./configure --target-list=xtensa-softmmu --prefix=$HOME/qemu-gpio --enable-slirp
make -j && make install
```
(`android/qemu/build-static-aarch64.sh` shows a static aarch64 build.) ROMs come from the same QEMU tree (`pc-bios/`) / Espressif release.

## Build & run
```
cp -r ../../web ctx/app && rm -rf ctx/app/dl
docker build -t esp32-lab ctx
docker run -d --name esp32lab -p 80:8765 -p 8765:8765 --restart unless-stopped \
  --security-opt seccomp=/home/opc/seccomp-bwrap.json \
  --security-opt no-new-privileges \
  -v esp32lab-data:/home/sim/.esp32lab -v esp32lab-cache:/home/sim/.cache/arduino esp32-lab
```

Before copying `qemu-gpio` into `ctx/home/qemu-gpio`, and again after the container is up, run `qemu-system-xtensa --version` with the server's spawn environment and confirm `ldd` prints no `not found` lines. Set `SIM_QEMU_LIB_DIRS` when `libslirp.so.0` (or another QEMU library) lives outside the prefix; accepted directories are appended after QEMU's own lib dirs. The same commands are in the root README deploy section. `/health` is false when `sandbox_ok` or `qemu_ok` is false. QEMU runs inside bubblewrap.
