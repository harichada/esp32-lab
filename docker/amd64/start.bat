@echo off
setlocal
cd /d "%~dp0"
title ESP32 Lab (local)
where docker >nul 2>nul || (echo Docker Desktop is not installed. Get it from https://www.docker.com/products/docker-desktop/ then run this again. & start https://www.docker.com/products/docker-desktop/ & pause & exit /b 1)
docker info >nul 2>nul
if errorlevel 1 (
  echo Starting Docker Desktop...
  start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"
  :wait
  timeout /t 3 >nul
  docker info >nul 2>nul || goto wait
)
docker image inspect esp32-lab:local >nul 2>nul
if errorlevel 1 (
  if not exist "esp32-lab-image.tar.gz" (echo esp32-lab-image.tar.gz not found next to start.bat & pause & exit /b 1)
  echo Loading image - first time only, takes a few minutes...
  docker load -i esp32-lab-image.tar.gz || (pause & exit /b 1)
)
docker rm -f esp32lab >nul 2>nul
docker run -d --name esp32lab --restart unless-stopped -p 127.0.0.1:8765:8765 -v esp32lab-data:/home/sim/.esp32lab esp32-lab:local >nul || (pause & exit /b 1)
echo Waiting for server...
:up
timeout /t 2 >nul
curl -s -o nul http://localhost:8765/api/health || goto up
start "" "http://localhost:8765/?ex=remote"
echo ESP32 Lab running at http://localhost:8765/?ex=remote  (run stop.bat to stop)
timeout /t 5 >nul
