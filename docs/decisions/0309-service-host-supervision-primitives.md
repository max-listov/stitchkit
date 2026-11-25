---
title: "ADR 0309: Host service supervision and verified artifact activation primitives"
description: "Peer-free evolving server entrypoint stitchkit/service-host unifies manifest-verified versioned artifact activation, Linux systemd and macOS launchd unit rendering/reload with rollback, and live PID/Unix-socket identity checks on top of stitchkit/files and stitchkit/process."
type: decision
status: accepted
created: 2026-11-23
updated: 2026-11-23
---

# ADR 0309: Host service supervision and verified artifact activation primitives

## Context

Long-running local and server daemons repeatedly reimplement three OS-facing mechanics and hit the same platform hazards independently:

1. **Verified artifact directories and atomic version switching:** checking `manifest.json` SHA-256 inventories without following symlinks or reading special files, rejecting extra or missing entries and empty directories, staging into immutable `releases/<key>/` trees, and atomically flipping/rolling back `current` without mutating running processes.
2. **Cross-platform service manager units (`systemd` and `launchd`):** escaping `%`, `$`, `\`, `"`, and rejecting newline/trailing-backslash directive injections in `.service` files; detecting foreign `<unit>.d/*.conf` drop-ins across systemd's real `UnitPath` even when `LoadState=not-found`; escaping XML 1.0 in `.plist` files; reloading `launchd` jobs via `bootout` + settle + `bootstrap` (never `kickstart -k`, which ignores plist edits); and automatically rolling back if the new process fails to start or loses stability during its stability window.
3. **Live supervised process and Unix-socket ownership verification:** checking a live PID's birth identity, `exe`, `argv`, and listening Unix socket ownership (the listener bound to the filesystem node the path resolves to, among the sockets in `/proc/<pid>/fd/*`; the node, not the path string, so a symlinked directory, a hard-linked second name and an unlinked stale name are each judged by what `connect` would reach), then re-confirming `probeProcessOwner` after all checks to close PID-reuse TOCTOU windows while cleanly separating `runtime-unavailable` from `runtime-conflict`.

## Decision

Add a new peer-free, server-only `evolving` entrypoint `stitchkit/service-host` composed over existing Stitchkit owners (I8, I11):

- Reuses `readRegularFile`, `readRegularFileSync`, `parseJsonBytes`, `fileIdentity`, `writeFileAtomic`, `stagingName`, `realPathWithinDir`, `runNativeCommand`, `observeProcessInstance`, and `probeProcessOwner` from `stitchkit/files`, `stitchkit/internal`, and `stitchkit/process` without duplicating any file or process primitives (I8).
- Exposes injectable typed host adapters (`SystemdHostAdapter`, `LaunchdHostAdapter`, `ProcessIdentityAdapter`) beside real Linux/macOS default adapters so all invariants are deterministically unit-tested without root on every OS.
- Remains a pure opt-in supervision toolkit: `stitchkit/contract`, `stitchkit/server`, and `stitchkit/application` never depend on `stitchkit/service-host` or require any external daemon manager (I11).
- A service manager is asked what it loaded, never assumed to have loaded what was written: installing a systemd unit compares `FragmentPath` with the written path before the write and again after `daemon-reload`, and reloading a launchd job compares the plist's `Label` with the job's label before anything is unloaded. A rollback restores the bytes that were read and the state the service was in.

## Consequences

- Daemon projects adopt one verified implementation for artifact activation, `systemd`/`launchd` rendering and rollback, and PID/socket identity verification.
- Platform hazards (foreign drop-ins under `not-found`, `kickstart -k` ignoring plist changes, systemd trailing-`\` continuation injection, symlinked socket paths, and PID reuse) are tested once in core gates.
