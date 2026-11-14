# x86_64 (amd64) image

- `Dockerfile` — amd64 image (expects a pre-staged context, see `build-image.sh`).
- `Dockerfile.arm64` — copy of the ARM variant.
- `build-image.sh` — stages context: site (`web/`), trimmed `~/.arduino15` (ESP32 core 3.3.12 + esp-x32 toolchain, esp32-libs, esptool_py, mklittlefs, mkspiffs only), `~/Arduino` libs, `~/qemu-gpio` (x86_64 build of patched QEMU, see docker/arm64/README.md), arduino-cli binary; then `docker build` + `docker save`.
- `start.sh/.bat`, `stop.bat`, `README.txt` — local Windows/macOS/Linux launcher (localhost:8765). The image tarball (`esp32-lab-image.tar.gz`) is NOT in the repo.

Binaries excluded: arduino15 cores/toolchains, qemu build, arduino-cli, image tarballs. Get them with:
```
arduino-cli config add board_manager.additional_urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
arduino-cli core update-index && arduino-cli core install esp32:esp32@3.3.12
```

## x86 micro VM deploy (129.80.165.212, Ubuntu 20.04)
1. Install Docker CE (get.docker.com / docker apt repo).
2. Load/build image, then:
```
docker run -d --name esp32lab -p 80:8765 --restart unless-stopped \
  -v esp32lab-data:/home/sim/.esp32lab -v esp32lab-cache:/home/sim/.cache/arduino esp32-lab:local
```
Do not publish container port 8765. Host 443 (`-p 443:8443`) waits until HTTPS is approved. See `web/README.md`.
3. Oracle images ship restrictive iptables; open ports (and persist):
```
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo netfilter-persistent save
```
Do not open 8765. Port 443 is added in the host firewall and the VCN security list only when HTTPS is approved. Allow 80 in the security list.
