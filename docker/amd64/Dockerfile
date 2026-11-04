FROM --platform=linux/amd64 debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-fastapi python3-uvicorn python3-websockets python3-httptools python3-uvloop \
      libglib2.0-0t64 libpixman-1-0 libgcrypt20 libslirp0 zlib1g libatomic1 ca-certificates \
    && rm -rf /var/lib/apt/lists/* && useradd -m -u 1000 sim
COPY --chown=sim:sim home/ /home/sim/
COPY --chown=sim:sim app/ /app/
RUN mv /app/arduino-cli-bin /usr/local/bin/arduino-cli && chmod +x /usr/local/bin/arduino-cli
USER sim
ENV HOME=/home/sim QEMU_BIN=/home/sim/qemu-gpio/bin/qemu-system-xtensa QEMU_ROM_DIR=/home/sim/qemu-gpio/share/qemu \
    SIM_RUN_CAP=0 SIM_TOKEN= SIM_BUILD_DIR=/home/sim/builds SIM_PROJECT_DIR=/home/sim/.esp32lab/projects
WORKDIR /app/server
EXPOSE 8765
CMD ["python3", "server.py", "--host", "0.0.0.0", "--port", "8765"]
