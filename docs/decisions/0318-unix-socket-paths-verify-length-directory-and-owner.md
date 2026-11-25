---
title: "ADR 0318: Unix socket paths verify length, parent directory ownership and peer owner"
description: "createServer({ unix }) and createUnixClientTransport enforce the cross-OS 103-byte sun_path limit, reject symlinks and group/world-writable or foreign-owned parent directories, and verify the target socket's owner before connecting with non-retryable UNIX_TARGET_REFUSED."
type: decision
status: accepted
amends: ["0116"]
created: 2026-11-24
updated: 2026-11-24
---

# ADR 0318 — Unix socket paths verify length, parent directory ownership and peer owner

Serves **I8**, **I10** and **I12**. Amends [ADR 0116](./0116-a-selected-unix-transport-never-becomes-tcp.md) and builds on [ADR 0303](./0303-a-host-beside-its-window-is-an-ordinary-server.md).

## Context

`createServer({ unix })` and `createUnixClientTransport({ socketPath })` accepted any absolute path string. Two classes of failure followed in real local deployments:

1. **Silent platform divergence on `sun_path`:** macOS caps `sockaddr_un.sun_path` at 104 bytes (103 UTF-8 bytes plus NUL), whereas Linux allows 108 bytes. Paths accepted on Linux failed only on Darwin, and long temp directories failed late inside bind/connect with opaque OS errors.
2. **Shared-directory and foreign-socket trust hazards:** binding or connecting to a socket inside `/tmp` or another group/world-writable or foreign-owned directory lets another local user pre-create or swap the socket path or symlink, redirecting authenticated local operator traffic to an untrusted process.

## Decision

1. **Cross-OS 103-byte UTF-8 ceiling:** Both `createServer({ unix })` (`stitchkit/server`) and `createUnixClientTransport({ socketPath })` (`stitchkit/server`, `stitchkit/node`) reject socket paths exceeding **103 UTF-8 bytes** before any filesystem or network call.
2. **Parent directory ownership and mode verification:** Both sides resolve and verify the parent directory before binding or connecting: it must be a real directory (not a symlink), owned by the calling effective UID, with `(mode & 0o022) === 0` (no group or world write bits). There is no opt-out flag.
3. **Target socket owner verification on connect:** `createUnixClientTransport` verifies the target socket's owner UID matches the caller before connecting. Any refusal throws non-retryable `UNIX_TARGET_REFUSED` with `delivery: 'not-dispatched'`, keeping delivery certainty intact (ADR 0116).

## Consequences

- Sockets in shared directories such as `/tmp`, sockets under symlinked parent directories, and sockets owned by another user (including root-owned system daemons accessed by a non-root caller) are refused loudly instead of silently connecting or binding.
- Callers place per-user sockets under a `0700` runtime directory owned by the same user (`$XDG_RUNTIME_DIR` or an app-owned state directory).
