---
title: Machine identity, not host name, decides whose pid this is
description: The journal lock's liveness guard attributes an owner by a stable machine identity, because a host name is mutable state and a renamed machine was classified as foreign to itself.
type: decision
status: active
created: 2026-09-02
updated: 2026-09-02
---

# 0147 — Machine identity, not host name, decides whose pid this is

## Decision

The diagnostic journal lock records a stable machine identity beside the pid, and `reclaim-stale`
attributes a recorded owner by that identity rather than by `os.hostname()`. The identity comes
from the operating system — `/etc/machine-id` with its dbus fallback, the macOS `IOPlatformUUID` —
or from `DiagnosticJournalConfig.machineIdentity` where the platform offers none.

A refusal now names its reason on the thrown `EEXIST`, readable through
`readDiagnosticJournalLockDiagnosis`: `owner alive`, `another machine`, or `unattributable`.

[ADR 0145](0145-a-reclaimed-lock-is-proven-never-assumed.md) is unchanged in substance — the
reclaim is still a liveness proof and there is still no age or heartbeat variant. This refines one
mechanism inside it: which owners the proof is allowed to be applied to.

## Why the host name was the wrong instrument

0145 wrote the host check as "a foreign `host` is a process this machine cannot probe", which is
sound as intent and wrong as mechanism, because a host name is **mutable state, not identity**. It
changes on a Tailscale or VPN transition, on DHCP handing out a different name, on a `scutil`
change, on a container restart, on a pod rescheduled onto the same volume. In every one of those
the journal path is still local and the recorded pid is still in this kernel's namespace.

The failure was silent and in the worst direction. The guard exists to prevent a *wrong reclaim*,
so it treated "cannot attribute" as "foreign" — but those are different states, and collapsing
them made the safe-looking answer a permanent refusal with no way out. A Mac whose `os.hostname()`
went from `ml-mbp-m5.local` to `ML-MBP-M5.ts.net lan` had its supervisor restart the service **127
times over 1h47m**, every attempt failing on `EEXIST`, against a pid that had not existed for
hours. A human deleting the file was the recovery — the exact outcome 0145 was written to remove.

That is the shape worth remembering: a guard that cannot distinguish "unsafe" from "unknown" will
report the unknown as unsafe forever, and forever is not a state an unattended service can leave.

## Why an identity file of our own would be worse

The obvious alternative — generate a UUID and persist it — fails in exactly the case the guard is
for. Stored beside the journal, it travels with the journal, so two machines sharing a network
filesystem read the same value and each concludes the other's lock is its own. Stored under a home
directory, the same thing happens wherever homes are shared. The identity has to come from the
operating system, because only the operating system can promise it does not travel.

Where the platform promises nothing, the answer is `null` rather than a guess, and attribution
falls back to the host name with the mismatch reported as `unattributable`. That is the same
refusal as before; what changed is that the caller can now say which refusal it got.

## Consequences

- Locks written before this field carry no identity, so they fall back to the host name. The rule
  is stated rather than implied, and `diagnostic-journal-lock.test.ts` covers both halves: same
  name and gone reclaims, different name refuses as unattributable.
- `machineIdentity` is a declared option and therefore load-bearing under the repository's option
  rule, registered against the test that renames a recorded host and reclaims.
- Detection is memoized per process: it reads an OS fact that does not change, and a lock
  acquisition must not pay for it twice. The macOS read spawns `ioreg` at most once, bounded.
- The residual risk is unchanged and points the safe way. An identity mismatch refuses, an unknown
  identity refuses, and PID reuse can only turn a dead owner into a live-looking one. Every error
  in this mechanism costs a refusal, never a reclaim over a live writer.
