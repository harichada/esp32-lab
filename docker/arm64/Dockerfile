FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-fastapi python3-uvicorn python3-websockets python3-httptools python3-uvloop \
      libglib2.0-0t64 libpixman-1-0 libgcrypt20 libslirp0 zlib1g libatomic1 ca-certificates curl bubblewrap \
    && rm -rf /var/lib/apt/lists/* && useradd -m -u 1000 sim
RUN curl -fsSL https://downloads.arduino.cc/arduino-cli/arduino-cli_1.5.1_Linux_ARM64.tar.gz | tar -xz -C /usr/local/bin arduino-cli
USER sim
ENV HOME=/home/sim
RUN arduino-cli config init && arduino-cli config add board_manager.additional_urls https://espressif.github.io/arduino-esp32/package_esp32_index.json \
 && arduino-cli core update-index && arduino-cli core install esp32:esp32@3.3.12 \
 && cd /home/sim/.arduino15/packages/esp32/tools && rm -rf esp-rv32 esp32c* esp32h2-libs esp32p4* esp32s* openocd-esp32 *gdb \
 && rm -rf /home/sim/.arduino15/staging
COPY --chown=sim:sim home/ /home/sim/
COPY --chown=sim:sim app/ /app/
RUN mkdir -p /home/sim/.cache/arduino /home/sim/builds /home/sim/.esp32lab/projects && chmod +x /home/sim/qemu-gpio/bin/qemu-system-xtensa
ENV QEMU_BIN=/home/sim/qemu-gpio/bin/qemu-system-xtensa QEMU_ROM_DIR=/home/sim/qemu-gpio/share/qemu \
    SIM_RUN_CAP=0 SIM_TOKEN= SIM_BUILD_DIR=/home/sim/builds SIM_PROJECT_DIR=/home/sim/.esp32lab/projects
WORKDIR /app/server
EXPOSE 8765
CMD ["python3", "server.py", "--host", "0.0.0.0", "--port", "8765"]
