#!/usr/bin/env python3
"""Show that deploy/seccomp-bwrap.json is Docker 29.9.3's profile plus the bwrap allows.

Docker 29.9.3 vendors github.com/moby/profiles/seccomp v0.2.4
(commit 245180c51918481c0525424b3ee025d2b435d46c). Fetch that
seccomp/default.json, or pass a local copy with --upstream, and compare.

The only differences are:

- clone: both SCMP_CMP_MASKED_EQ rules change value 2114060288 to 0, so a
  clone that sets namespace flags is allowed. The mask previously required
  those flags to be clear. No finer argument filter is added: the server is
  not root, the container gets no extra capabilities, and it is started with
  no-new-privileges.
- clone3: left as upstream, SCMP_ACT_ERRNO / errnoRet 38 (ENOSYS) without
  CAP_SYS_ADMIN, so glibc falls back to clone.
- unshare, mount, umount2, setns, pivot_root: one new unconditional
  SCMP_ACT_ALLOW group, with no argument filters. pivot_root is absent from
  the upstream profile. bwrap needs these after it has entered its user
  namespace, and Docker cannot express that without also blocking bwrap.
"""

from __future__ import annotations

import argparse
import copy
import json
import sys
import urllib.request
from pathlib import Path

REPO = 'https://github.com/moby/profiles'
COMMIT = '245180c51918481c0525424b3ee025d2b435d46c'
TAG = 'seccomp/v0.2.4'
DOCKER = '29.9.3'
UPSTREAM_URL = f'https://raw.githubusercontent.com/moby/profiles/{COMMIT}/seccomp/default.json'
OURS = Path(__file__).resolve().parent / 'seccomp-bwrap.json'
CLONE_MASK = 2114060288
ADDED_ALLOW = ['unshare', 'mount', 'umount2', 'setns', 'pivot_root']
CHANGED = ['clone', *ADDED_ALLOW]


def fetch(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=60) as resp:
        return json.load(resp)


def expected(upstream: dict) -> dict:
    """Upstream profile, clone flags widened, clone3 left as ENOSYS, plus the allow group."""
    out = copy.deepcopy(upstream)
    kept = False
    widened = 0
    for group in out['syscalls']:
        names = group.get('names') or []
        if names == ['clone3'] and group.get('action') == 'SCMP_ACT_ERRNO' and group.get('errnoRet') == 38:
            kept = True
        if names == ['clone']:
            for arg in group.get('args') or []:
                if arg.get('op') == 'SCMP_CMP_MASKED_EQ' and arg.get('value') == CLONE_MASK:
                    arg['value'] = 0
                    widened += 1
    if not kept:
        raise SystemExit('upstream clone3 ENOSYS rule was not found')
    if widened != 2:
        raise SystemExit(f'expected to widen 2 clone rules, widened {widened}')
    out['syscalls'].append({'names': list(ADDED_ALLOW), 'action': 'SCMP_ACT_ALLOW'})
    return out


def _syscall_names(profile: dict) -> set[str]:
    names = set()
    for group in profile.get('syscalls') or []:
        names.update(group.get('names') or [])
    return names


def explain(upstream: dict, ours: dict) -> list[str]:
    lines = [
        f'source {REPO}',
        f'commit {COMMIT} ({TAG})',
        f'Docker {DOCKER} vendors {TAG}',
        f'upstream {UPSTREAM_URL}',
        'clone: SCMP_CMP_MASKED_EQ value 2114060288 -> 0 on both rules '
        '(namespace flags no longer forced clear)',
        'clone3: stays SCMP_ACT_ERRNO errnoRet 38 (ENOSYS) without CAP_SYS_ADMIN, '
        'so glibc falls back to clone',
        'added SCMP_ACT_ALLOW with no argument filters: ' + ', '.join(ADDED_ALLOW),
        'syscalls whose rules differ from upstream: ' + ', '.join(CHANGED),
    ]
    extra = sorted(_syscall_names(ours) - _syscall_names(upstream))
    if extra != ['pivot_root']:
        lines.append('UNEXPECTED new syscall names: ' + ', '.join(extra))
    return lines


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--upstream', help='path to the upstream default.json; default is to fetch the commit above')
    parser.add_argument('--ours', default=str(OURS))
    parser.add_argument('--write', action='store_true', help='write deploy/seccomp-bwrap.json from this upstream')
    args = parser.parse_args()
    upstream = json.loads(Path(args.upstream).read_text()) if args.upstream else fetch(UPSTREAM_URL)
    want = expected(upstream)
    ours_path = Path(args.ours)
    if args.write:
        ours_path.write_text(json.dumps(want, indent=2) + '\n')
        print(f'wrote {ours_path}')
    if not ours_path.is_file():
        print(f'missing {ours_path}', file=sys.stderr)
        return 1
    ours = json.loads(ours_path.read_text())
    for line in explain(upstream, ours):
        print(line)
    if ours != want:
        print('FAIL: deploy/seccomp-bwrap.json is not upstream plus only those seven changes')
        return 1
    print('OK')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
