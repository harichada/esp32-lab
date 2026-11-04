
## QEMU for Android arm64 (Phase 1, done 2026-11-03)
- Source: /home/box/qemu-src (QEMU 9.2.2 + esp32 GPIO bridge patches, uncommitted local mods), copied to /tmp/qsrc.
  One build fix to meson.build: wrap `slirp = declare_dependency(...)` in `if slirp_dep.found()` so `--disable-slirp` works.
- Build: `qemu/build-static-aarch64.sh` run in docker alpine:3.20 (x86_64); clang/lld cross to aarch64-alpine-linux-musl with an
  aarch64 Alpine sysroot (glib, pixman, zlib, pcre2, libintl, libgcrypt, libgpg-error, all static). Output: **static-pie aarch64, no ELF interpreter,
  no shared libs** → runs on Android without bionic.
  `docker run --name qx -v /tmp/qsrc:/src -v qemu/build:/out alpine:3.20 sh /out/build-static-aarch64.sh`
- Artifact: qemu/qemu-system-xtensa-aarch64 (18.3 MB stripped, 4.8 MB gzipped) → app-project/app/src/main/jniLibs/arm64-v8a/libqemu-system-xtensa.so
  ROMs esp32-v3-rom.bin + esp32-v3-rom-app.bin (445 KB each) → assets/payload/qemu-rom/
- Disabled: slirp (no static libslirp in Alpine; build libslirp 4.8 statically if open_eth/-net user is needed), tools, vnc/sdl/gtk, capstone, plugins.
- Proof: qemu/test/boot_test.py runs it under qemu-aarch64 user mode (built from same tree, test/qemu-aarch64) with the app's exact cmdline
  (TCP-client chardevs to 127.0.0.1). test/boot_blink_serial.log: ROM banner, bootloader, then "BLINK 0 led=0 / BLINK 1 led=1 ...";
  GPIO bridge emits X reset / S / M / F lines. test/boot_blink.log: stock Blink boots, GPIO lines flow.
- Not yet verified on a real Android device/emulator (no arm64 Android emulator runnable here). Risks: seccomp-blocked syscalls in
  static musl (expect OK; Termux runs similar), TMPDIR must be set (app does), SELinux exec from nativeLibraryDir (supported).

### QEMU update 2026-11-03 21:55 EST: slirp enabled
- Source saved: qemu/src (full tree incl. local esp32 mods + meson slirp fix, no .git/build). Also qemu/BASE_COMMIT,
  qemu/esp32-local-mods.patch (git diff vs BASE_COMMIT), qemu/meson-slirp-fix.patch.
- build-static-aarch64.sh now builds static libslirp 4.8.0 (meson cross file, c_ld=lld) into the sysroot and configures --enable-slirp.
  Rebuild: `mkdir -p qemu/build && cp qemu/build-static-aarch64.sh qemu/build/ && sudo docker run --rm -v $PWD/qemu/src:/src -v $PWD/qemu/build:/out alpine:3.20 sh /out/build-static-aarch64.sh`
- New binary 18.4 MB (4.9 MB gz), sha256 1b8cbbed…9e, copied to jniLibs/arm64-v8a/libqemu-system-xtensa.so. build/ tree deleted.
- Proof (qemu-aarch64 user mode): test/boot_net_dhcp.log — QemuEth sketch (test/ns.ino) with `-net nic,model=open_eth -net user`
  prints "lwIP up on open_eth: 10.0.2.15 (gw 10.0.2.2, DHCP)" / "IP=10.0.2.15". Blink+serial re-verified (test/boot_blink_serial.log).
  Run tests with NET=1 for networking.
