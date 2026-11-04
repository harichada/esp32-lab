#!/bin/bash
# Compile every sim-site example under the noexec Android simulation (run after test_noexec.sh set it up).
D=/data/data/com.hari.esp32lab/files; EX=${EX:-/workspace/tc-test/ex}; cd $D/build
run(){ env -i PATH=/tmp/tbx HOME=$D TMPDIR=$D/tmp ESP32LAB_SH=/usr/bin/mksh ESP32LAB_HOME=$D/toolchain ESP32LAB_BIN=/tmp/nld /tmp/nld/libesp32compile.so "$@"; }
for e in ${@:-$(ls $EX)}; do extra=; [ $e = REMOTE ] && extra="--define SIM --net lwip"
  rm -rf $D/build/o-$e; s=$(date +%s); run --fqbn esp32:esp32:esp32doit-devkit-v1 --sketch $EX/$e --out $D/build/o-$e --home $D/toolchain $extra > /tmp/ex-$e.log 2>&1; rc=$?
  printf "%-12s exit=%s %4ss %s\n" $e $rc $(( $(date +%s)-s )) "$( [ -f $D/build/o-$e/flash.bin ] && echo "flash.bin $(stat -c%s $D/build/o-$e/sketch.ino.bin)B app" || grep -m1 -E 'error|ERROR' /tmp/ex-$e.log)"; done
