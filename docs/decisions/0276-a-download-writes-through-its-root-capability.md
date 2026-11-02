---
title: "ADR 0276: A download writes through its root capability"
description: Select the configured output root once, pin its directory, and atomically replace children without following leaf or ancestor links.
type: decision
status: accepted
created: 2026-11-01
updated: 2026-11-02
---

# ADR 0276 — A download writes through its root capability

## Context

A lexical containment check decides whether a filename is inside an output directory;
`writeFile` still follows an existing symlink at that name. Checking with `lstat` first
leaves a race before opening, and resolving a parent path again lets an actor replace
an ancestor between the check and write. Reopening the output root for each media file
also lets one command silently change its authority while awaiting a response.

The coding tools already need descriptor-relative filesystem access on Linux and macOS.
CLI code must share that mechanism without importing the separately bounded agent runtime.

## Decision

The generic contained directory, handle and writer primitives live in `internal`, a leaf
shared by the runtime and tools. One writer sequence serves both platforms: an exclusive open,
a full write, an optional descriptor chmod, and for a replacement a rename from the shared
staging name. Linux reaches entries through descriptor paths; Darwin through the packaged
directory-relative native operations. Exclusive creation opens the final name, so a filesystem
without hard links still creates files.

The configured root is authority selected once before fetching. Initial root aliases are
allowed: the caller chose that directory. Canonicalization selects an existing prefix;
opening it walks each canonical component from the filesystem root with nofollow directory
operations. Intermediate directories need search permission, not listing permission:
Linux uses [`O_PATH`](https://man7.org/linux/man-pages/man2/open.2.html), and Darwin uses
[`O_SEARCH`](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/fcntl.h).
A read capability is requested only by callers that list the selected directory. Missing components are created through pinned parents and then opened with
nofollow. A symlink introduced after selection causes refusal rather than redirection.
After pinning, the descriptor remains the selected root object for the entire batch,
including when that object is renamed. This is an object boundary, not a guarantee that
its original pathname remains attached to it.

Media names are direct children. An exclusive staged file is written fully before atomic
publication. Replacing a leaf symlink, dangling link or hard link replaces that directory
entry, never writes through it. A directory refuses replacement. Existing ordinary-file
permission bits are retained; new downloads use `0666 & ~umask`. Permissions are applied
to the new file descriptor, never through the final path.

Unsupported platforms refuse filesystem downloads; there is no path-based fallback.
macOS bundles package the native backend with `createNativePackaging`. Other CLI operation
paths stay portable. Network pinning, credentials, byte caps and deadlines remain with
the existing guarded transport. A download refusal never changes a successful operation
into a reason to replay it: stdout keeps that result and the exit reports partial failure.

## Alternatives

- Resolve and check every path before writing: rejected because the path can change afterward.
- Open the final file with nofollow and truncate it: rejected because hard links still share
  an external inode, and partial writes would damage an existing result.
- Add a CLI-specific writer or import coding tools: rejected because one duplicates the
  security engine and the other crosses the agent-runtime boundary.
- Fall back on unsupported platforms: rejected because success would claim a boundary the
  platform implementation has not established.

## Consequences

This breaks callers of `--output-dir`, marked and migrated in 0.115.0. Windows and other
unsupported platforms lose downloads, because any fallback there would claim a boundary it
cannot hold. A macOS bundle or compiled binary needs the native backend at build time, because
the boundary cannot exist without it. CLI commands without downloads are unaffected. A replacement is a new file, so it needs write
permission on the directory, belongs to the process user and cannot land on a bind-mounted file.

## Verification

The installed public CLI proof checks external bytes, link replacement, permission bits,
root replacement during HTTP response delivery, a multi-file batch and partial refusal.
Unit controls replace a canonical ancestor before root opening and prove it cannot redirect
creation. The same binary writer accepts empty content and subarrays without decoding them.
Existing Darwin artifact controls exercise successful and unavailable CLI download paths in
packed, relocated and embedded artifacts; actual Darwin execution belongs to that host lane.

Serves **I8**, **I12**, **I13** and **I15**.
