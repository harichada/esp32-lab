#!/bin/bash
# Starts the sign-in lab, and the plain-HTTP IP origin when AUTH_E2E_IP=1.
# One signal stops both.
set -euo pipefail
cleanup() { kill 0 2>/dev/null || true; }
trap cleanup EXIT INT TERM
cd "$(dirname "$0")/../.."
if [ "${AUTH_E2E_IP:-0}" = "1" ]; then
  AUTH_E2E_HTTPS_ORIGIN="http://localhost:${AUTH_E2E_PORT:-18941}" \
    "${PYTHON:-python3}" tests/auth_e2e/ip_server.py &
fi
"${PYTHON:-python3}" tests/auth_e2e/auth_server.py
