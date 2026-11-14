#!/bin/sh
# Weekly renewal for the Circuit Lab certificate.
# The dry-run runs first. If it fails, `set -e` stops the script, certbot
# does not replace the live certificate, and the deploy hook does not restart
# the container, so the site keeps serving the certificate it already has.
set -eu
certbot renew --dry-run
certbot renew
