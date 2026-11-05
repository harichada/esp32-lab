# Third-party notices

This product (working name: "the simulator"; final product name TBD) bundles or uses the components below.
Each remains under its own license. First-party code: see `LICENSE` (all rights reserved).

**Not affiliated** with or endorsed by Espressif Systems, Arduino SA, or Wokwi (CodeMagic LTD).
ESP32 / Espressif, Arduino, and Wokwi are trademarks of their respective owners; used only descriptively.
The diagram.json importer reads a third-party file format for interoperability only.

| Component | Version | License | Upstream | License text |
|---|---|---|---|---|
| Espressif QEMU fork (+ local GPIO-bridge patch) | QEMU 9.2.2 base, commit `febae182e132e4055529be423a818225ebddaa3a` | GPL-2.0 | https://github.com/espressif/qemu | https://github.com/espressif/qemu/blob/esp-develop/LICENSE · https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt |
| ESP32 ROM ELF/images | esp-rom-elfs | Apache-2.0 (ROM ELFs); © 2015-2022 Espressif Systems (Shanghai) Co. Ltd. | https://github.com/espressif/esp-rom-elfs | https://github.com/espressif/esp-rom-elfs/blob/master/LICENSE |
| glib | distro | LGPL-2.1+ | https://gitlab.gnome.org/GNOME/glib | https://www.gnu.org/licenses/old-licenses/lgpl-2.1.txt |
| pixman | distro | MIT | https://gitlab.freedesktop.org/pixman/pixman | https://gitlab.freedesktop.org/pixman/pixman/-/blob/master/COPYING |
| libgcrypt | distro | LGPL-2.1+ | https://gnupg.org/software/libgcrypt/ | https://www.gnu.org/licenses/old-licenses/lgpl-2.1.txt |
| libslirp | distro | BSD-3-Clause | https://gitlab.freedesktop.org/slirp/libslirp | https://gitlab.freedesktop.org/slirp/libslirp/-/blob/master/COPYRIGHT |
| musl libc (Android static QEMU) | – | MIT | https://musl.libc.org/ | https://git.musl-libc.org/cgit/musl/tree/COPYRIGHT |
| xtensa-esp-elf GCC / binutils toolchain | esp-14.2.0_20260121 | GPL-3.0 + GCC Runtime Library Exception | https://github.com/espressif/crosstool-NG | https://www.gnu.org/licenses/gpl-3.0.txt · https://www.gnu.org/licenses/gcc-exception-3.1.html |
| glibc (Android APK runtime) | 2.31 (Debian 11) | LGPL-2.1+ | https://sourceware.org/glibc/ · https://sources.debian.org/src/glibc/2.31-13/ | https://www.gnu.org/licenses/old-licenses/lgpl-2.1.txt |
| libstdc++ / libgcc_s | GCC | GPL-3.0 + Runtime Library Exception | https://gcc.gnu.org/ | https://www.gnu.org/licenses/gcc-exception-3.1.html |
| Arduino-ESP32 core | 3.3.12 | LGPL-2.1 | https://github.com/espressif/arduino-esp32 | https://github.com/espressif/arduino-esp32/blob/master/LICENSE.md |
| ESP-IDF libraries | (bundled with core) | Apache-2.0 | https://github.com/espressif/esp-idf | https://github.com/espressif/esp-idf/blob/master/LICENSE |
| esptool | 5.3.1 | GPL-2.0-or-later | https://github.com/espressif/esptool | https://github.com/espressif/esptool/blob/master/LICENSE |
| arduino-cli | 1.5.1 | GPL-3.0 | https://github.com/arduino/arduino-cli | https://github.com/arduino/arduino-cli/blob/master/LICENSE.txt |
| NanoHTTPD / nanohttpd-websocket | 2.3.1 | BSD-3-Clause | https://github.com/NanoHttpd/nanohttpd | https://github.com/NanoHttpd/nanohttpd/blob/master/LICENSE.md |
| org.json | 20240303 | Public Domain | https://github.com/stleary/JSON-java | https://github.com/stleary/JSON-java/blob/master/LICENSE |
| Java-WebSocket | 1.5.7 | MIT | https://github.com/TooTallNate/Java-WebSocket | https://github.com/TooTallNate/Java-WebSocket/blob/master/LICENSE |
| FastAPI, uvicorn, websockets, httptools, uvloop | distro | MIT / BSD-3-Clause | https://github.com/fastapi/fastapi · https://github.com/encode/uvicorn · https://github.com/python-websockets/websockets · https://github.com/MagicStack/httptools · https://github.com/MagicStack/uvloop | see each repo's LICENSE |
| Inter font | – | SIL OFL 1.1 | https://github.com/rsms/inter | web/fonts/LICENSE-* |
| JetBrains Mono font | – | SIL OFL 1.1 | https://github.com/JetBrains/JetBrainsMono | web/fonts/LICENSE-* |
| Adafruit GFX, SSD1306, SH110X, BME280, ILI9341, MPU6050, TouchScreen, TSC2007 | – | BSD | https://github.com/adafruit | each library's license.txt |
| Adafruit BusIO, MCP3008, STMPE610, DHT sensor library | – | MIT | https://github.com/adafruit | each library's LICENSE |
| Adafruit Unified Sensor | – | Apache-2.0 | https://github.com/adafruit/Adafruit_Sensor | https://www.apache.org/licenses/LICENSE-2.0 |
| Adafruit NeoPixel | – | LGPL-3.0 | https://github.com/adafruit/Adafruit_NeoPixel | https://github.com/adafruit/Adafruit_NeoPixel/blob/master/COPYING |
| ESP32Servo | 3.2.1 | LGPL-2.1 | https://github.com/madhephaestus/ESP32Servo | https://www.gnu.org/licenses/old-licenses/lgpl-2.1.txt |
| Keypad | 3.1.1 | GPL-3.0 | https://github.com/Chris--A/Keypad | https://www.gnu.org/licenses/gpl-3.0.txt |
| three.js (WebGL 3D view) | 0.134.0 (vendored `web/vendor/three.min.js` + UMD bloom helpers) | MIT | https://github.com/mrdoob/three.js | https://github.com/mrdoob/three.js/blob/r134/LICENSE |
| LiquidCrystal_PCF8574 (replaces LiquidCrystal_I2C) | 2.3.0 | BSD-3-Clause, © Matthias Hertel | https://github.com/mathertel/LiquidCrystal_PCF8574 | https://github.com/mathertel/LiquidCrystal_PCF8574/blob/master/LICENSE |

Adafruit's names and SSD1306 splash logo appear only as part of their libraries, not as branding.

## Apache-2.0 attribution (Espressif ROM)
ESP32 ROM code is Copyright (c) 2015-2022 Espressif Systems (Shanghai) Co. Ltd., used under the Apache License 2.0
(https://www.apache.org/licenses/LICENSE-2.0). It is distributed unmodified. ROM third-party copyrights:
https://docs.espressif.com/projects/esp-idf/en/latest/esp32/COPYRIGHT.html#rom-source-code-copyrights

## GPL-2.0 notice and written source offer (QEMU)
The emulator is a modified build of Espressif's QEMU fork, licensed under the GNU GPL version 2. It comes with
ABSOLUTELY NO WARRANTY. Corresponding source: upstream https://github.com/espressif/qemu at commit
`febae182e132e4055529be423a818225ebddaa3a` (`android/qemu/BASE_COMMIT`), plus the local changes in
`android/qemu/esp32-local-mods.patch` and `android/qemu/meson-slirp-fix.patch`, built with
`android/qemu/build-static-aarch64.sh`.
**Written offer:** for at least three years from when we last distribute this binary, Hari Kishore Chada will
give anyone who asks a complete machine-readable copy of the corresponding source (including the patches and
build script above) for no more than the cost of physically distributing it. Ask through the product's support contact.
The same offer covers the GPL/LGPL toolchain and glibc binaries shipped in the Android APK (exact upstream tags above).
