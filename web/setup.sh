#!/usr/bin/env bash
# ESP32 Circuit Lab — one-shot local setup for Linux, macOS and WSL2.
#   ./setup.sh           install everything (first run ~20-40 min, mostly the QEMU build) and start the server
#   ./setup.sh --start   just start the server
# Installs into ~/.esp32lab (arduino-cli, patched Espressif QEMU, Python venv). Uses sudo/brew only for build deps.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PREFIX="${ESP32LAB_HOME:-$HOME/.esp32lab}"
PORT="${PORT:-8765}"
CORE_VER="3.3.12"
QEMU_REPO="https://github.com/espressif/qemu.git"
BASE_COMMIT="$(cat "$HERE/server/qemu-patch/BASE_COMMIT")"
mkdir -p "$PREFIX/bin"
export PATH="$PREFIX/bin:$PATH"
# keep the esp32 core isolated from any existing Arduino install
export ARDUINO_DIRECTORIES_DATA="$PREFIX/arduino15" ARDUINO_DIRECTORIES_USER="$PREFIX/Arduino" ARDUINO_DIRECTORIES_DOWNLOADS="$PREFIX/arduino15/staging"
export ARDUINO_BOARD_MANAGER_ADDITIONAL_URLS="https://espressif.github.io/arduino-esp32/package_esp32_index.json"
log() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }

start() {
  export SIM_BUILD_DIR="${SIM_BUILD_DIR:-$PREFIX/builds}"; mkdir -p "$SIM_BUILD_DIR"
  export QEMU_BIN="$PREFIX/qemu/bin/qemu-system-xtensa" QEMU_ROM_DIR="$PREFIX/qemu/share/qemu" ARDUINO_CLI="$PREFIX/bin/arduino-cli"
  log "Starting server on http://127.0.0.1:$PORT/  (Ctrl+C to stop)"
  exec "$PREFIX/venv/bin/python" "$HERE/server/server.py" --port "$PORT"
}
[ "${1:-}" = "--start" ] && start

OS="$(uname -s)"
log "Installing build dependencies ($OS)"
if [ "$OS" = "Darwin" ]; then
  command -v brew >/dev/null || { echo "Install Homebrew first: https://brew.sh"; exit 1; }
  brew install git ninja pkg-config glib pixman libgcrypt libslirp python@3.12 meson || true
elif command -v apt-get >/dev/null; then
  sudo apt-get update || echo "apt-get update had errors; continuing"
  sudo apt-get install -y git curl python3 python3-venv python3-pip ninja-build meson pkg-config build-essential \
    libglib2.0-dev libpixman-1-dev libgcrypt20-dev libslirp-dev
elif command -v dnf >/dev/null; then
  sudo dnf install -y git curl python3 ninja-build meson pkgconf-pkg-config gcc gcc-c++ make glib2-devel pixman-devel libgcrypt-devel libslirp-devel
elif command -v pacman >/dev/null; then
  sudo pacman -S --needed --noconfirm git curl python ninja meson pkgconf base-devel glib2 pixman libgcrypt libslirp
else
  echo "Unknown package manager: install git, python3, ninja, meson, pkg-config, glib2, pixman, libgcrypt, libslirp dev packages manually."
fi

log "arduino-cli + esp32 core $CORE_VER"
if ! [ -x "$PREFIX/bin/arduino-cli" ]; then
  curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | BINDIR="$PREFIX/bin" sh
fi
arduino-cli core update-index
arduino-cli core install "esp32:esp32@$CORE_VER"
arduino-cli lib install "Adafruit SSD1306" "Adafruit GFX Library" "Adafruit BME280 Library" "Adafruit MPU6050" "Adafruit Unified Sensor" "Adafruit BusIO" "Adafruit ILI9341" "Adafruit MCP3008" "LiquidCrystal_PCF8574"

log "Patched Espressif QEMU (GPIO/IO_MUX/RTCIO/RMT/SENS-ADC/LEDC bridge)"
if ! [ -x "$PREFIX/qemu/bin/qemu-system-xtensa" ]; then
  SRC="$PREFIX/qemu-src"
  [ -d "$SRC/.git" ] || git clone --filter=blob:none "$QEMU_REPO" "$SRC"
  git -C "$SRC" fetch --depth 1 origin "$BASE_COMMIT" 2>/dev/null || true
  git -C "$SRC" checkout -f "$BASE_COMMIT"
  git -C "$SRC" apply "$HERE/server/qemu-patch/esp32-gpio-bridge.patch"
  mkdir -p "$SRC/build" && cd "$SRC/build"
  ../configure --target-list=xtensa-softmmu --enable-gcrypt --enable-slirp --disable-werror --disable-docs \
    --disable-sdl --disable-gtk --disable-vnc --disable-capstone --prefix="$PREFIX/qemu"
  ninja && ninja install
  cd "$HERE"
fi

log "Python venv (fastapi, uvicorn)"
[ -d "$PREFIX/venv" ] || python3 -m venv "$PREFIX/venv"
"$PREFIX/venv/bin/pip" install -q fastapi 'uvicorn[standard]' websockets

log "Done. Next time just run: $0 --start"
start
