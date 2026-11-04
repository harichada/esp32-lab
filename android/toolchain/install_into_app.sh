#!/bin/bash
# Copy built payload into the app project (run ./build_bundle.sh first)
set -e; HERE=$(cd "$(dirname "$0")" && pwd); APP=${APP:-/workspace/esp32-lab-android/app-project/app/src/main}
mkdir -p $APP/jniLibs/arm64-v8a $APP/assets/payload/toolchain
cp $HERE/out/jniLibs/arm64-v8a/*.so $APP/jniLibs/arm64-v8a/
rm -f $APP/assets/payload/toolchain/*.tar* $APP/assets/payload/toolchain/*.tgz; gzip -9c $HERE/out/payload/toolchain/toolchain.tar > $APP/assets/payload/toolchain/toolchain.tgz  # .tgz, NOT .tar.gz: AGP silently gunzips *.gz assets
echo "copied; remember to bump $APP/assets/payload/VERSION"
