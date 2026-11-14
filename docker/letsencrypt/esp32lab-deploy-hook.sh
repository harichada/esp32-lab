#!/bin/sh
# Host deploy hook for certbot. Installed as
# /etc/letsencrypt/renewal-hooks/deploy/esp32lab and run as root after a
# certificate is issued or renewed. Restarts the container so uvicorn reloads
# the cert it read at process start. The site is briefly down. That gap is
# accepted. This hook does not publish a port.
set -eu
name="${RENEWED_LINEAGE:-}"
name="${name##*/}"
if [ -z "$name" ]; then
  name=129-158-200-25.sslip.io
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
docker restart esp32lab
