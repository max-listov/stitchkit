---
title: Lock owners are process instances
description: Exclusive lock recovery compares kernel boot and process birth identities before treating a reused PID as an owner.
status: accepted
created: 2026-09-28
---

# Lock owners are process instances

## Decision

A PID identifies a process-table slot, not a lifetime. The exclusive lock records
an optional process identity alongside its existing machine attribution. Both
the protected lock and its reclaim guard use the same record and diagnosis.

Linux uses `/proc/sys/kernel/random/boot_id`, field 22 of `/proc/<pid>/stat`, and
PID/time namespace identities. The caller's own `NStgid` status verifies the proc
mount's PID namespace without requiring permission to inspect PID 1. A proc mount
that cannot be attributed to the caller supplies no evidence. Darwin uses `kern.bootsessionuuid`
and `proc_pid_rusage(RUSAGE_INFO_V0).ri_proc_start_abstime` through the existing
packaged Node-API binding. The shared binding lives in `internal`; recovery
never imports the agent runtime. These are kernel lifetime identifiers, not
wall-clock estimates, command names or elapsed-time thresholds.

Only after machine attribution may a different boot or process birth prove the
recorded owner gone. A different namespace, missing native/proc evidence, unknown
platform or malformed process identity refuses recovery. Null marks an explicitly
unmeasured modern identity; an absent field marks a legacy record. Legacy records
retain the conservative PID/zombie probe: a live reused PID cannot be distinguished
and requires quiescent operator recovery. No timestamp-based migration can invent
the missing identity. New acquisitions persist the modern record automatically.

The journal retains `refuse` by default; `reclaim-stale` opts into recovery.
`withExclusiveLock` retains its explicit ownerless-file grace policy; a malformed
process identity inside an otherwise readable owner is never treated as ownerless.
Reclamation retains the exclusive guard, re-reads under it, and respects inode
identity when releasing a file. Diagnosis distinguishes lifetime evidence from
legacy PID reachability. Kernel token collisions cause a conservative refusal,
never age-based takeover.

References: [Linux proc stat](https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html),
[Linux namespace process IDs](https://man7.org/linux/man-pages/man5/proc_pid_status.5.html)
and [Darwin resource API](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/resource.h).

Invariants: I8, I10, I12, I13.
