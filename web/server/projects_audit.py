"""Read-only count of projects that have no owner secret.

A legacy project is a ``*.json`` file whose stem has no non-empty
``<stem>.secret`` sidecar. ``SIM_PROJECTS_LEGACY_OPEN=0`` makes those
projects read-only. When this count is 0, that setting is safe to ship:
every project already has an owner secret, and new projects still receive
one from ``POST /api/projects``.

From ``web/``::

    python3 -m server.projects_audit --count-legacy <dir>

Prints one integer on stdout. Does not create or modify files.
"""
import argparse
import sys
from pathlib import Path


def count_legacy(directory) -> int:
    """How many project files in ``directory`` have no owner secret."""
    folder = Path(directory)
    if not folder.is_dir():
        raise NotADirectoryError(str(folder))
    count = 0
    for entry in folder.iterdir():
        if not entry.is_file() or entry.suffix != '.json':
            continue
        side = folder / f'{entry.stem}.secret'
        if not side.is_file():
            count += 1
            continue
        try:
            text = side.read_text(encoding='utf-8')
        except OSError:
            count += 1
            continue
        if not text.strip():
            count += 1
    return count


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description='Read-only project volume checks. Never writes.')
    parser.add_argument('--count-legacy', metavar='DIR', required=True, help='directory of project JSON and secret sidecars')
    args = parser.parse_args(argv)
    try:
        print(count_legacy(args.count_legacy))
    except NotADirectoryError as exc:
        print('not a directory: %s' % exc, file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
