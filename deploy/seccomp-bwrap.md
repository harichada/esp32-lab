# Compile-sandbox seccomp profile

`seccomp-bwrap.json` is the default Docker seccomp profile plus the calls bubblewrap needs, so it can make its mount and pid namespaces without `--privileged` and without extra capabilities.

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

1. **clone** — both `SCMP_CMP_MASKED_EQ` rules (generic, and the s390 rule) change `value` from `2114060288` (`0x7E020000`, the namespace-flag mask) to `0`. `(flags & 0) == 0` matches every flag combination, so a clone that sets `CLONE_NEWNS`, `CLONE_NEWPID`, `CLONE_NEWNET`, and the other bits that mask used to reject is allowed. Nothing else in those rules changes. There is no finer argument filter. The lab server is not root, the container is given no extra capabilities, and it is started with `--security-opt no-new-privileges`. Docker's filter cannot say "these flags only after the user namespace exists" without also blocking the `clone` bubblewrap uses to create that namespace.

2. **clone3** — unchanged from upstream: `action: SCMP_ACT_ERRNO`, `errnoRet: 38` (ENOSYS), and it does not apply to a process that has `CAP_SYS_ADMIN`. This container does not have that capability, so glibc's `clone3` fails with ENOSYS and glibc calls `clone` instead. `clone` is the filtered call. An unconditional allow would skip that fallback.

3. **unshare, mount, umount2, setns** — upstream allows these only with `CAP_SYS_ADMIN`. A new group allows them with no capability filter and no argument filter. Bubblewrap calls them only after it is inside the user namespace it just created. Lab Admin accepted leaving them unfiltered for that reason: a non-root server, no extra capabilities, and `no-new-privileges` already stop a process in the container from using them to take the host.

4. **pivot_root** — not in the upstream profile. The same new group allows it, also with no argument filter, because bubblewrap needs it inside that user namespace and an argument filter would reject the call bubblewrap makes.

The new group is exactly:

```json
{"names": ["unshare", "mount", "umount2", "setns", "pivot_root"], "action": "SCMP_ACT_ALLOW"}
```

No other syscall, architecture map, or default action differs. The container is still started with `--security-opt seccomp=<this file>` and `--security-opt no-new-privileges`, and without `--privileged` or `--cap-add`. The profile is copied to `/home/opc/seccomp-bwrap.json` and passed on `docker run`. It is not baked into the image. The live ARM server image is built from `docker/arm64/Dockerfile`.
