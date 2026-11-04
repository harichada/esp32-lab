ESP32 Lab - run locally (Windows 11)

1. Install Docker Desktop if you don't have it: https://www.docker.com/products/docker-desktop/  (already installed on KiddoKingdom)
2. Put these files in one folder, e.g. C:\ESP32Lab :
     esp32-lab-image.tar.gz   start.bat   stop.bat
3. Double-click start.bat.
   - It starts Docker Desktop if needed, loads the image the first time (a few minutes), starts the simulator,
     and opens http://localhost:8765/?ex=remote in your browser.
4. Double-click stop.bat to stop it. It also restarts itself with Docker Desktop until stopped.

Notes: only reachable from this computer (localhost). No token needed. No run time limit.
Saved projects live in the Docker volume "esp32lab-data" and survive restarts.
If port 8765 is busy, edit start.bat and change the first 8765 in "-p 127.0.0.1:8765:8765" and the URLs.
macOS/Linux: run ./start.sh instead.
