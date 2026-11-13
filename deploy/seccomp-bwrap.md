# Compile-sandbox seccomp profile

`seccomp-bwrap.json` is the default Docker seccomp profile plus seven syscalls, so bubblewrap can make its mount and pid namespaces without `--privileged` and without extra capabilities.

| | |
|---|---|
| Docker | 29.9.3 (`moby/moby` tag `docker-v29.9.3` vendors this profile) |
| Repository | https://github.com/moby/profiles |
| File | `seccomp/default.json` |
| Tag | `seccomp/v0.2.4` |
| Commit | `245180c51918481c0525424b3ee025d2b435d46c` |
| URL | https://raw.githubusercontent.com/moby/profiles/245180c51918481c0525424b3ee025d2b435d46c/seccomp/default.json |

`deploy/check_seccomp.py` fetches that commit (or reads a local copy with `--upstream`) and checks that our file is that JSON plus only the changes below.

## Rule changes

1. **clone** — both `SCMP_CMP_MASKED_EQ` rules (generic, and the s390 rule) change `value` from `2114060288` (`0x7E020000`, the namespace-flag mask) to `0`. `(flags & 0) == 0` matches every flag combination, so a clone that sets `CLONE_NEWNS`, `CLONE_NEWPID`, `CLONE_NEWNET`, and the other bits that mask used to reject is allowed. Nothing else in those rules changes.
2. **clone3** — the rule `action: SCMP_ACT_ERRNO`, `errnoRet: 38` (ENOSYS), `excludes.caps: [CAP_SYS_ADMIN]` is replaced by `action: SCMP_ACT_ALLOW` with no errno and no capability exclude. libseccomp would still apply the ENOSYS rule if it were left in place.
3. **unshare, mount, umount2, setns** — upstream allows these only with `CAP_SYS_ADMIN`. A new group allows them with no capability filter.
4. **pivot_root** — not in the upstream profile. The same new group allows it.

The new group is exactly:

```json
{"names": ["unshare", "mount", "umount2", "setns", "pivot_root"], "action": "SCMP_ACT_ALLOW"}
```

No other syscall, architecture map, or default action differs. The container is still started with `--security-opt seccomp=<this file>` and `--security-opt no-new-privileges`, and without `--privileged` or `--cap-add`.
