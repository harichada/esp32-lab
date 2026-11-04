#!/bin/bash
# Faithful-as-possible Android simulation on an x86 box: qemu-aarch64 via binfmt, app data on a NOEXEC tmpfs,
# nativeLibraryDir = /tmp/nld (only jniLibs files), toybox userland, mksh as /system/bin/sh, env -i.
set -e; T=$(cd "$(dirname "$0")" && pwd); D=/data/data/com.hari.esp32lab/files
sudo umount $D 2>/dev/null || true; sudo rm -rf /data/data/com.hari.esp32lab; sudo mkdir -p $D
sudo mount -t tmpfs -o noexec,size=2g tmpfs $D; sudo chown box $D; mkdir -p $D/toolchain $D/tmp $D/build/sk
tar xf $T/out/payload/toolchain/toolchain.tar -C $D/toolchain
rm -rf /tmp/nld; cp -r $T/out/jniLibs/arm64-v8a /tmp/nld
cp /tmp/nld/libesp32img.so $D/x.so; if $D/x.so 2>/dev/null; then echo "noexec NOT enforced"; else echo "noexec enforced on app data (exec rc=$?)"; fi
echo "find ELF/symlinks in app data:"; find $D -type l | head; find $D -type f -exec sh -c 'head -c4 "$1" | grep -q ELF && echo "$1"' _ {} \; | grep -v x.so | head
cp ${SKETCH:-/workspace/tc-test/sk/sketch.ino} $D/build/sk/sketch.ino; cd $D/build
run(){ env -i PATH=/tmp/tbx HOME=$D TMPDIR=$D/tmp LD_LIBRARY_PATH=/tmp/nld ESP32LAB_SH=/usr/bin/mksh ESP32LAB_HOME=$D/toolchain ESP32LAB_BIN=/tmp/nld /tmp/nld/libesp32compile.so "$@"; }
echo "== selftest"; run --selftest --home $D/toolchain; echo "selftest exit=$?"
echo "== compile"; time run --fqbn esp32:esp32:esp32doit-devkit-v1 --sketch $D/build/sk --out $D/build/out --home $D/toolchain; echo "compile exit=$?"
ls -la $D/build/out/flash.bin
