#!/usr/bin/env bash
# macOS/Linux equivalent of start.bat
set -e; cd "$(dirname "$0")"
docker info >/dev/null 2>&1 || { echo "Start Docker first (install: https://www.docker.com/products/docker-desktop/)"; exit 1; }
docker image inspect esp32-lab:local >/dev/null 2>&1 || docker load -i esp32-lab-image.tar.gz
docker rm -f esp32lab >/dev/null 2>&1 || true
docker run -d --name esp32lab --restart unless-stopped -p 127.0.0.1:8765:8765 -v esp32lab-data:/home/sim/.esp32lab esp32-lab:local >/dev/null
until curl -s -o /dev/null http://localhost:8765/api/health; do sleep 2; done
U="http://localhost:8765/?ex=remote"; (xdg-open "$U" || open "$U") >/dev/null 2>&1 || echo "Open $U"
