#!/bin/bash
# Starts the sign-in lab on loopback. One signal stops it.
set -euo pipefail
cleanup() { kill 0 2>/dev/null || true; }
trap cleanup EXIT INT TERM
cd "$(dirname "$0")/../.."
"${PYTHON:-python3}" tests/auth_e2e/auth_server.py
