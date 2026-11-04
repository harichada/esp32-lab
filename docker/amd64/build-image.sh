#!/usr/bin/env bash
# Rebuild on the Grok box: stages the site, trimmed arduino15 (ESP32 core + xtensa toolchain only), libs and patched QEMU, then docker build + save.
set -e; O=/workspace/esp32-lab-local; C=$O/build/ctx; A=$HOME/.arduino15; rm -rf $C; mkdir -p $C/home/.arduino15/packages/esp32/tools $C/home/.esp32lab/projects $C/home/builds
cp $O/pkg/Dockerfile $C/; cp -a /workspace/esp32-remote/sim-site $C/app; rm -rf $C/app/server/server.py.bak* $C/app/server/__pycache__ $C/app/screenshots $C/app/tests/ui
cp -a $A/*.yaml $A/*.json $A/*.sig $C/home/.arduino15/; cp -a $A/packages/{arduino,builtin} $C/home/.arduino15/packages/; cp -a $A/packages/esp32/hardware $C/home/.arduino15/packages/esp32/
for t in esp-x32 esp32-libs esptool_py mklittlefs mkspiffs; do cp -a $A/packages/esp32/tools/$t $C/home/.arduino15/packages/esp32/tools/; done
cp -a $HOME/Arduino $HOME/qemu-gpio $C/home/; cp $(command -v arduino-cli || echo $HOME/bin/arduino-cli) $C/app/arduino-cli-bin
sudo docker build --platform linux/amd64 -t esp32-lab:local $C
sudo docker save esp32-lab:local | gzip -1 > $O/esp32-lab-image.tar.gz
