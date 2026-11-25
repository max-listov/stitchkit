---
title: "ADR 0313: macOS service-host signed launcher bundles, LaunchServices and TCC responsibility"
description: "Extends stitchkit/service-host launchd helpers and adds the peer-free evolving entrypoint stitchkit/service-host/macos for fail-closed Developer ID codesign, strict C11 launcher .app bundles with atomic RENAME_SWAP install/rollback, Apple squircle AppIcon.icns generation, streaming lsregister maintenance, and TCC responsibility inspection via the Darwin N-API addon."
type: decision
status: accepted
created: 2026-11-23
updated: 2026-11-24
---

# ADR 0313: macOS service-host signed launcher bundles, LaunchServices and TCC responsibility

Serves **I8**, **I10**, **I11**, **I12** and **I13**. Extends [ADR 0309](0309-service-host-supervision-primitives.md).

## Context

Background daemons on macOS require a signed `.app` launcher bundle managed by `launchd` so macOS Privacy & Security (TCC) attributes permissions to a stable Developer ID bundle rather than an unsigned interpreter binary. Across desktop and daemon applications, the same macOS stack was being duplicated:

- Fail-closed Developer ID signing and verification (`codesign --verify --strict` and `codesign -dvvv` chain, `TeamIdentifier`, `Identifier`, `CDHash`) refusing ad-hoc `'-'` or ambiguous identities.
- Generating and compiling a strict C11 launcher executable (`getppid() == 1`, `posix_spawn` without `POSIX_SPAWN_SETEXEC` or runtime `argv` passthrough by default to avoid TCC confused-deputy attacks, signal forwarding with strict syscall return checks).
- Building Apple 824×824 squircle `AppIcon.icns` assets from guarded SVG, framed JPEG, or PNG inputs.
- Idempotent `.app` installation staged inside `*.install.noindex` with pre-swap verification, atomic `renameatx_np(..., RENAME_SWAP)`, and rollback that preserves the previous bundle if rollback itself fails.
- Streaming `lsregister` registration and stale/build-tree cleanup, `plutil -lint` / `plutil -convert json` and `launchctl bootout` helpers, and TCC responsibility verification (`responsibility_get_pid_responsible_for_pid` + `proc_pidpath`).

## Decision

1. **Extend `stitchkit/service-host`** with missing `launchd` primitives shared across platforms: `lintLaunchdPlist`, `readLaunchdPlist` (guarding `plutil` permission errors such as `Code=257`), `bootoutLaunchdJob`, `validatePlist` before write/bootout, `AssociatedBundleIdentifiers`, and `LimitLoadToSessionType`, backed by a shared `plist-xml.ts` encoder.
2. **Add peer-free evolving leaf `stitchkit/service-host/macos`** (`browser: false`, zero overlaps) exporting fail-closed `codesign`, C11 `launcher`, `icon`, `bundle` (`ensureSignedBundle` with `StitchkitBundleSpecDigest`), `launch-services` (streaming `lsregister -dump` with O(1) memory, `maxDumpBytes`, protected system-root guards and `/var`↔`/private/var` canonicalization), and `responsibility` (`inspectResponsibleProcess`, `verifyProcessSubtreeResponsibility` with `observeProcessInstance` TOCTOU re-check).
3. **Extend the existing Darwin N-API addon (`#stitchkit-darwin-native`)** instead of using runtime-specific FFI (`bun:ffi`): add `renameSwapAt` (pinned `dirfd` + `renameatx_np(..., RENAME_SWAP)`), `responsiblePid` (dynamic `dlsym` lookup for `responsibility_get_pid_responsible_for_pid`), and `processPath` (`proc_pidpath`), keeping new native bindings optional at load time with explicit `EOPNOTSUPP` fallback until native `.node` binaries are rebuilt on macOS CI.

## Consequences

- Both Bun ≥ 1.4 and Node ≥ 22.3 on macOS share one audited, fail-closed implementation for signed `.app` daemon launchers, LaunchServices hygiene, `launchd` plist inspection/bootout, and TCC responsibility checks.
- Pure state machines, parsers, C11 generation (`gcc -fsyntax-only -std=c11 -Wall -Wextra -Werror`), rollback preservation, and security refusals run deterministically on Linux and macOS CI; Darwin syscall and `codesign`/`lsregister`/`plutil` integration checks run on `macos-15`.
- Linux consumers importing `stitchkit/service-host` do not pull macOS bundle/codesign code.
