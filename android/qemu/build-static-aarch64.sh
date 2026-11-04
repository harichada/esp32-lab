#!/bin/sh
# Runs inside alpine:3.20 (x86_64). Cross-builds fully static aarch64 qemu-system-xtensa (musl).
set -e
apk add -q clang lld llvm build-base python3 py3-pip meson ninja pkgconf glib-dev bash perl flex bison git
S=/sysroot
apk add -q --arch aarch64 --root $S --initdb --allow-untrusted -X https://dl-cdn.alpinelinux.org/alpine/v3.20/main -X https://dl-cdn.alpinelinux.org/alpine/v3.20/community \
  musl-dev gcc glib-dev glib-static pixman-dev pixman-static zlib-dev zlib-static pcre2-dev libffi-dev linux-headers gettext-dev libgcrypt-dev libgcrypt-static libgpg-error-dev libgpg-error-static
ls $S/usr/lib/libslirp* || true
GCCV=$(ls $S/usr/lib/gcc/aarch64-alpine-linux-musl/)
CC="clang --target=aarch64-alpine-linux-musl --sysroot=$S"
LDF="-fuse-ld=lld -B$S/usr/lib/gcc/aarch64-alpine-linux-musl/$GCCV -L$S/usr/lib/gcc/aarch64-alpine-linux-musl/$GCCV"
export PKG_CONFIG=pkg-config PKG_CONFIG_SYSROOT_DIR=$S PKG_CONFIG_LIBDIR=$S/usr/lib/pkgconfig:$S/usr/share/pkgconfig

# ---- static libslirp 4.8.0 for aarch64-musl ----
if [ ! -f $S/usr/lib/libslirp.a ]; then
  cd /tmp && rm -rf libslirp-v4.8.0* && wget -q https://gitlab.freedesktop.org/slirp/libslirp/-/archive/v4.8.0/libslirp-v4.8.0.tar.gz && tar xzf libslirp-v4.8.0.tar.gz
  cat > /tmp/cross.ini <<EOC
[binaries]
c = ['clang','--target=aarch64-alpine-linux-musl','--sysroot=$S']
c_ld = 'lld'
ar = 'llvm-ar'
strip = 'llvm-strip'
pkg-config = 'pkg-config'
[host_machine]
system = 'linux'
cpu_family = 'aarch64'
cpu = 'aarch64'
endian = 'little'
EOC
  cd libslirp-v4.8.0 && meson setup bs --cross-file /tmp/cross.ini --default-library=static --prefix=/usr -Dbuildtype=release && ninja -C bs && DESTDIR=$S ninja -C bs install
fi
mkdir -p /out/b && cd /out/b
/src/configure --target-list=xtensa-softmmu --static --cc="$CC" --extra-ldflags="$LDF" --cxx="clang++" --host-cc=gcc \
  --cross-prefix=llvm-  --enable-gcrypt --disable-werror --disable-docs --disable-tools \
  --disable-sdl --disable-gtk --disable-vnc --disable-capstone --disable-opengl --disable-curses \
  --disable-guest-agent --disable-linux-io-uring --disable-libudev --disable-plugins --without-default-features --enable-slirp \
   --enable-tcg
ninja qemu-system-xtensa
llvm-strip -o /out/qemu-system-xtensa-aarch64 qemu-system-xtensa
