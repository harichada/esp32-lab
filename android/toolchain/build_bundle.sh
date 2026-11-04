#!/bin/bash
# Builds the Android payload: out/jniLibs/arm64-v8a/*.so + out/payload/toolchain/toolchain.tar
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); DL=${DL:-/workspace/tc-dl}; A15=${A15:-$HOME/.arduino15/packages/esp32}
PREFIX=${PREFIX:-/data/data/com.hari.esp32lab/files/toolchain}   # = filesDir/toolchain (user 0)
XT=$DL/xtensa-esp-elf; [ -d $XT ] || { mkdir -p $DL; cd $DL; curl -L https://github.com/espressif/crosstool-NG/releases/download/esp-14.2.0_20260121/xtensa-esp-elf-14.2.0_20260121-aarch64-linux-gnu.tar.gz | tar xz; }
G=/usr/aarch64-linux-gnu/lib; BOXSTRIP=$A15/tools/esp-x32/2601/bin/xtensa-esp-elf-strip
O=$HERE/out; S=$O/stage; J=$O/jniLibs/arm64-v8a; rm -rf $O; mkdir -p $S/xtensa-esp-elf $J $O/payload/toolchain
T=$S/xtensa-esp-elf; V=14.2.0; MD=esp32/psram/no-rtti
# --- toolchain, esp32 only, single multilib
mkdir -p $T/bin $T/libexec/gcc/xtensa-esp-elf/$V $T/lib/gcc/xtensa-esp-elf/$V $T/xtensa-esp-elf/lib $T/xtensa-esp-elf/bin $T/lib/bfd-plugins
# esp32 wrapper binaries dropped (they check argv0); compile.sh passes -mdynconfig itself
for t in gcc g++ ar as ld size objcopy; do cp $XT/bin/xtensa-esp-elf-$t $T/bin/; done
for t in cc1 cc1plus collect2 lto-wrapper liblto_plugin.so; do cp $XT/libexec/gcc/xtensa-esp-elf/$V/$t $T/libexec/gcc/xtensa-esp-elf/$V/; done
for t in ar as ld; do cp $XT/xtensa-esp-elf/bin/$t $T/xtensa-esp-elf/bin/; done
cp $XT/lib/xtensa_esp32.so $T/lib/; cp $XT/lib/bfd-plugins/liblto_plugin.so $T/lib/bfd-plugins/
L=$XT/lib/gcc/xtensa-esp-elf/$V; cp -r $L/include $L/include-fixed $T/lib/gcc/xtensa-esp-elf/$V/; cp $L/*.o $T/lib/gcc/xtensa-esp-elf/$V/ 2>/dev/null || true
mkdir -p $T/lib/gcc/xtensa-esp-elf/$V/$MD; cp -r $L/$MD/. $T/lib/gcc/xtensa-esp-elf/$V/$MD/
cp -r $XT/xtensa-esp-elf/include $XT/xtensa-esp-elf/sys-include $T/xtensa-esp-elf/ ; cp $XT/xtensa-esp-elf/lib/*.specs $T/xtensa-esp-elf/lib/; cp -r $XT/xtensa-esp-elf/lib/ldscripts $T/xtensa-esp-elf/lib/
mkdir -p $T/xtensa-esp-elf/lib/$MD; cp -r $XT/xtensa-esp-elf/lib/$MD/. $T/xtensa-esp-elf/lib/$MD/
find $T -name '*.a' -exec $BOXSTRIP -g {} \; 2>/dev/null || true
# --- Arduino core + SDK (esp32 only)
cp -r $A15/tools/esp32-libs/3.3.12 $S/esp32-libs; rm -rf $S/esp32-libs/qio_qspi  # DIO: QEMU flash model has no QIO (doit-devkit-v1 / esp32 in DIO)
H=$A15/hardware/esp32/3.3.12; mkdir -p $S/core/variants; cp -r $H/cores $H/libraries $S/core/; cp -r $H/variants/esp32 $H/variants/doitESP32devkitV1 $S/core/variants/
# third-party libraries (everything installed for the box arduino-cli) + sim-site network shims
mkdir -p $S/libs $S/shims; cp -r $HOME/Arduino/libraries/*/ $S/libs/; cp -r ${SHIMS:-/workspace/esp32-remote/sim-site/server/shims}/* $S/shims/
rm -rf $S/core/libraries/*/examples $S/libs/*/examples $S/libs/*/extras $S/libs/*/.git* $S/libs/*/docs
python3 $HERE/src/libindex.py $S
mkdir -p $S/boot $S/bin; cp $HERE/prebuilt/bootloader.bin $HERE/prebuilt/partitions.bin $H/tools/partitions/boot_app0.bin $S/boot/
[ -f $HERE/prebuilt/core-esp32.a ] && mkdir -p $S/cache && cp $HERE/prebuilt/core-*.a $S/cache/ || true
cp $HERE/src/compile.sh $S/compile.sh; echo "esp-x32-2601 arduino-esp32-3.3.12 bundle-5-simlibs" > $S/VERSION
# --- host binaries (static)
NDKCC=${NDKCC:-/opt/android-sdk/ndk/27.2.12479018/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android29-clang}  # static bionic: no glibc/rseq, runs on any Android
$NDKCC -O2 -static -s -o $J/libesp32compile.so $HERE/src/launcher.c
$NDKCC -O2 -static -s -o $J/libesp32img.so $HERE/src/esp32img.c
$NDKCC -O2 -static -s -o $J/libesp32wrap.so $HERE/src/wrap.c
# --- glibc 2.31 runtime (Debian 11; pre-clone3/rseq, friendlier to Android's app seccomp) -> jniLibs with renamed sonames
G=${G231:-$DL/g231/x}; [ -d $G ] || { echo "need glibc 2.31 arm64 debs extracted at $G" >&2; exit 1; }
cp -L $G/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1 $J/libldlinux64.so
cp -L $G/lib/aarch64-linux-gnu/libc.so.6 $J/libc6.so;  cp -L $G/lib/aarch64-linux-gnu/libm.so.6 $J/libm6.so
cp -L $G/lib/aarch64-linux-gnu/libdl.so.2 $J/libdl2.so; cp -L $G/lib/aarch64-linux-gnu/libpthread.so.0 $J/libpthread0.so
cp -L $G/lib/aarch64-linux-gnu/libgcc_s.so.1 $J/libgcc_s1.so; cp -L $G/usr/lib/aarch64-linux-gnu/libstdc++.so.6 $J/libstdcxx6.so
# --- toolchain ELFs -> jniLibs (fixed short names); remove all ELFs from the data tree
cp $XT/bin/xtensa-esp-elf-gcc $J/libxgcc.so; cp $XT/bin/xtensa-esp-elf-g++ $J/libxgxx.so
cp $XT/libexec/gcc/xtensa-esp-elf/$V/cc1 $J/libxcc1.so; cp $XT/libexec/gcc/xtensa-esp-elf/$V/cc1plus $J/libxcc1plus.so
cp $XT/xtensa-esp-elf/bin/as $J/libxas.so; cp $XT/xtensa-esp-elf/bin/ld $J/libxld.so; cp $XT/xtensa-esp-elf/bin/ar $J/libxar.so
cp $XT/bin/xtensa-esp-elf-size $J/libxsize.so; cp $XT/lib/xtensa_esp32.so $J/libxtensa_esp32.so
python3 $HERE/src/renamelibs.py $J/libldlinux64.so $J/libc6.so $J/libm6.so $J/libdl2.so $J/libpthread0.so $J/libgcc_s1.so $J/libstdcxx6.so $J/libx*.so
cd $S; find . -type f | while read f; do readelf -h "$f" 2>/dev/null | grep -q AArch64 && rm -f "$f" || true; done; rm -rf $S/xtensa-esp-elf/bin $S/xtensa-esp-elf/libexec $S/xtensa-esp-elf/xtensa-esp-elf/bin $S/xtensa-esp-elf/lib/bfd-plugins
tar cf $O/payload/toolchain/toolchain.tar -C $S .
du -sh $J $O/payload/toolchain/toolchain.tar; ls $J | wc -l
