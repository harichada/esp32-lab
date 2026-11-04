#!/bin/bash
# Watchdog: keeps server.py and the ngrok tunnel alive. Run with: setsid nohup ./supervise.sh >> /tmp/supervise.log 2>&1 < /dev/null &
# This ngrok account has no static dev domain (each start gets a new random *.ngrok-free.app), so on every ngrok
# restart the new URL is written to the link file. Set NGROK_URL=https://<reserved-domain> to pin one.
HERE="$(cd "$(dirname "$0")" && pwd)"; URLF="$HERE/.ngrok_url"; LINK=/workspace/esp32-sim-link.html
log() { echo "$(date '+%F %T %Z') $*"; }
write_link() {
  local u="$1" t; t="$(cat /tmp/sim_token)"
  printf '<html><body><a href="%s/?t=%s&ex=remote">Open ESP32 Simulator</a><script>location.href='"'"'%s/?t=%s&ex=remote'"'"'</script></body></html>\n' "$u" "$t" "$u" "$t" > "$LINK"
}
while true; do
  if ! pgrep -f "python3 server.py --port 8765" >/dev/null; then
    log "server.py not running -> starting"
    pkill -f "qemu-system-xtensa .*esp32run-" && log "killed orphaned QEMU from the previous server"
    (cd "$HERE" && SIM_TOKEN="$(cat /tmp/sim_token)" setsid nohup python3 server.py --port 8765 >> /tmp/simserver.log 2>&1 < /dev/null &)
  fi
  if ! pgrep -f "ngrok http 8765" >/dev/null; then
    U="${NGROK_URL:-}"
    log "ngrok not running -> starting ${U:+(pinned $U)}"
    (cd ~/bin && setsid nohup ./ngrok http 8765 ${U:+--url "$U"} --log stdout >> /tmp/ngrok.log 2>&1 < /dev/null &)
    for i in $(seq 30); do sleep 1; N="$(curl -s localhost:4040/api/tunnels | python3 -c 'import sys,json;t=json.load(sys.stdin)["tunnels"];print(t[0]["public_url"] if t else "")' 2>/dev/null)"; [ -n "$N" ] && break; done
    if [ -n "$N" ]; then
      [ "$N" != "$U" ] && log "ngrok URL is now $N"
      echo "$N" > "$URLF"; write_link "$N"
    else log "ngrok did not come up (see /tmp/ngrok.log)"; pkill -f "ngrok http 8765"; fi
  fi
  sleep 5
done
