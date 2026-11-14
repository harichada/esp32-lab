#!/bin/sh
# Host deploy hook for certbot. Installed as
# /etc/letsencrypt/renewal-hooks/deploy/esp32lab and run as root after a
# certificate is issued or renewed.
#
# It asks the running container to reload TLS (SIGHUP). It does not restart
# the container, so port 80 stays up. If the new certificate is missing or
# does not load, it logs that and does not signal the process. The site keeps
# serving HTTP, and port 80 is not pointed at a broken 443.
#
# The certificate name comes from certbot's RENEWED_LINEAGE, then CERT_NAME.
# The documented name is esp32lab.duckdns.org. Any other name works when
# CERT_NAME or the lineage directory is that name. This hook does not publish
# a port.
set -eu
name="${RENEWED_LINEAGE:-}"
name="${name##*/}"
if [ -z "$name" ]; then
  name="${CERT_NAME:-esp32lab.duckdns.org}"
fi
live="/etc/letsencrypt/live/$name"
if [ ! -f "$live/fullchain.pem" ] || [ ! -f "$live/privkey.pem" ]; then
  echo "esp32lab deploy hook: certificate for $name is missing; leaving HTTP in place and not reloading" >&2
  exit 1
fi
if ! python3 -c 'import ssl,sys; ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER).load_cert_chain(sys.argv[1], sys.argv[2])' \
  "$live/fullchain.pem" "$live/privkey.pem"; then
  echo "esp32lab deploy hook: certificate for $name did not load; leaving HTTP in place and not reloading" >&2
  exit 1
fi
# live/ entries are symlinks into archive/. The container user is uid 1000
# and the key is mode 600, so grant that uid read without making the key
# world-readable. Mount the whole /etc/letsencrypt tree or the symlinks dangle.
if command -v setfacl >/dev/null 2>&1; then
  setfacl -m u:1000:rx /etc/letsencrypt /etc/letsencrypt/live /etc/letsencrypt/archive "/etc/letsencrypt/archive/$name"
  setfacl -m u:1000:r /etc/letsencrypt/archive/"$name"/privkey*.pem
else
  echo "esp32lab deploy hook: setfacl is not installed; uid 1000 may not be able to read the new private key" >&2
fi
container="${CONTAINER_NAME:-esp32lab}"
docker kill -s HUP "$container"
