---
title: "ADR 0312: Idempotent atomic create, config reloader, windowed event-loop delay and lock diagnosis formatting"
description: "Extends stitchkit/files, stitchkit/service-host, stitchkit/observability, stitchkit and stitchkit/application with opt-in idempotent atomic creation, trusted host systemd drop-ins and reload-safe socket ownership re-snapshots, an in-process config reloader, a windowed EventLoopDelayMonitor, browser-safe repeatLimited, and an exhaustive lock-diagnosis formatter."
type: decision
status: accepted
created: 2026-11-23
updated: 2026-11-23
---

# ADR 0312: Idempotent atomic create, config reloader, windowed event-loop delay and lock diagnosis formatting

Serves **I8**, **I9**, **I10**, **I12** and **I13**. Extends [ADR 0308](0308-daemon-primitives-extend-existing-owners.md) and [ADR 0309](0309-service-host-supervision-primitives.md).

## Context

After `stitchkit/files`, `stitchkit/observability`, `stitchkit/contract` and `stitchkit/service-host` established the initial daemon supervision primitives (ADR 0308, ADR 0309), real consumer migrations surfaced two gaps:

1. **Security and reload hardening in existing primitives:**
   - Crash-resumable installers need an idempotent `writeOnce` mode on `writeFileAtomic` / `writeFileAtomicSync` (`replace: false`) that treats byte-identical existing regular files with matching mode as success instead of failing with `EEXIST`, without weakening the default strict create-exclusive semantics.
   - Linux `systemd` inspection must allow host-wide `<trustedDir>/service.d/*.conf` drop-ins and template drop-ins (`foo@.service.d`) while rejecting untrusted paths, detect `LoadState=masked`, and support verifying an `expectedDigest`.
   - Live Unix-socket ownership verification must survive in-process socket reloads without false `runtime-conflict` verdicts by taking a second `/proc/net/unix` snapshot and re-running `probeProcessOwner` after re-checking `exe`/`argv` or `fd` links.
2. **Three duplicated daemon primitives across fleet projects:**
   - An in-process config-watched reloader that polls a config source, validates a new config **before** stopping the active handle, coalesces concurrent changes, deduplicates broken-digest logs, rolls back on start failure, and integrates with `bindProcessSignals` (`ShutdownTarget`).
   - A windowed `EventLoopDelayMonitor` (sliding buckets over `perf_hooks.monitorEventLoopDelay`) so transient spikes age out instead of holding health degraded until process restart, while shielding callers from runtime quirks (Node's `511 ns` percentile on empty histograms and Bun's occasional `p99 > max`).
   - A human-readable formatter for `DiagnosticJournalLockDiagnosis` covering every orthogonal combination of `attribution × liveness × identity × owner` without guessing liveness from a PID alone, plus browser-safe availability of `repeatLimited`.

## Decision

Extend each existing owning entrypoint without introducing parallel abstractions (I8):

- **`stitchkit/files`:** add explicit opt-in `idempotent?: boolean` on `WriteFileAtomicOptions` (rejected with `TypeError` unless `replace: false`) using `O_NOFOLLOW`, full `0o7777` mode comparison, 0-byte support, one `EEXIST → ENOENT` retry, staged cleanup and directory sync; include `after.mode !== before.mode` in `readRegularFile` identity retry checks.
- **`stitchkit/service-host`:**
  - Harden `checkSystemdUnit` with trusted `<dir>/service.d/*.conf` (for `.service` units), template drop-in recognition, `LoadState=masked` handling, and `expectedDigest`.
  - Harden `verifySupervisedProcess` with `probeProcessOwner` on `exe`/`argv` mismatch and a second `/proc/net/unix` + `probeProcessOwner` pass after `fdRefresh`.
  - Export `startConfigReloader` and `createPolledJsonConfigSource` implementing `ShutdownTarget` (`gracePeriodMs: 0` permitted) with 1-slot coalescing, own `activeDigest` tracking, unconditional late-handle cleanup without parent shutdown abort, optional `rollbackOnStartFailure`, a retry of the last config on every poll while no handle is running, and one `stop` per handle: a `stop` that outlives `stopTimeoutMs` is awaited by later reloads and by `shutdown()` instead of being called again.
- **`stitchkit/observability` & `stitchkit`:** export `createEventLoopDelayMonitor` in `stitchkit/observability` using lazy `process.getBuiltinModule('perf_hooks')`, an O(1) ring buffer (`MAX_EVENT_LOOP_DELAY_BUCKETS = 3600`), empty-histogram and `p99 <= max` guards, and an `unref()`'d bucket timer; re-export browser-safe `repeatLimited` from `stitchkit`.
- **`stitchkit/application`:** export browser-clean `formatDiagnosticJournalLockDiagnosis` with compile-time exhaustiveness across all `DiagnosticJournalLockDiagnosis` branches.

## Consequences

- Installers, brokers and browser clients adopt one verified implementation for idempotent writes, config hot-reload, windowed event-loop latency and lock diagnostics.
- Strict `{ replace: false }` callers keep their existing fail-on-exists contract unless they opt into `idempotent: true`.
- Runtime quirks of `perf_hooks.monitorEventLoopDelay` on Node and Bun are absorbed in one tested adapter.
