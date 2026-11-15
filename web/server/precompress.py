#!/usr/bin/env python3
"""Write sibling .gz files for static assets. Stdlib only.

    python3 server/precompress.py

COMPRESS_ENABLED defaults off. server.py never gzips a response itself: when
the flag is on and the client accepts gzip, it sends one of these files for
.js, .css, .svg, .wasm and .json only. HTML and everything under /api are
skipped here so a precompressed page or auth body cannot exist.

Caddy on staging should use the same allow-list (see web/README.md). The
single-core Python process does no per-request compression either way.
"""
import gzip
import sys
from pathlib import Path

EXTS = {'.js', '.css', '.svg', '.wasm', '.json'}
SKIP_DIRS = {'tests', 'node_modules', '__pycache__', '.git'}


def write_gz(root, compresslevel=9):
    """Create ``path.gz`` next to each static asset under ``root``. Returns how many were written."""
    root = Path(root)
    written = 0
    for path in sorted(root.rglob('*')):
        if not path.is_file():
            continue
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        rel = path.relative_to(root)
        if 'api' in rel.parts:
            continue
        if path.suffix.lower() not in EXTS:
            continue
        if path.name.endswith('.gz'):
            continue
        data = path.read_bytes()
        gz = gzip.compress(data, compresslevel=compresslevel, mtime=0)
        if len(gz) >= len(data):
            continue
        dest = Path(str(path) + '.gz')
        dest.write_bytes(gz)
        written += 1
    return written


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    root = Path(argv[0]) if argv else Path(__file__).resolve().parents[1]
    n = write_gz(root)
    print(f'wrote {n} gzip files under {root}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
