---
title: Preserve coding-tool containment when a parent directory changes during authorization
description: Refuse read and patch operations when a previously resolved ancestor is replaced by an outside symlink before the filesystem effect.
type: task
status: done
created: 2026-08-30
updated: 2026-08-30
completed: 2026-08-30 11:31 +00:00
priority: P0
---

## Reproduced boundary failure

Published `stitchkit@0.69.0`, source `5eb57b159de92e2ba708d189b96911b565b4af82`, Bun 1.3.14
on macOS. The public `createAgentCodingTools` definitions execute through public `mountAgent`.
All paths in this reproduction are disposable siblings under one temporary directory; no user
data or services are involved.

1. Create `workspace/nested/source.txt` and a separate `outside/source.txt`.
2. Supply an asynchronous `authorize` callback that signals entry, waits for a test barrier,
   then returns true. It does not change the requested relative path or grant outside access.
3. Start `read_file({path:'nested/source.txt'})`. After the callback is entered, another actor
   renames `workspace/nested` to `workspace/original-nested` and replaces `workspace/nested`
   with a symlink to `outside`. Release authorization.
4. The tool returns the contents of `outside/source.txt`, although that path was never authorized.
5. Repeat using `apply_patch`, placing identical original contents in both source files and the
   corresponding correct `baseSha256` in the request. The patch succeeds and modifies
   `outside/source.txt`; the original workspace file remains untouched.

Positive controls: normal bounded read succeeds, `../outside/source.txt` is refused and a stale
base digest is refused. The failure is specifically a race after resolution/validation, not
acceptance of an obviously escaping input. Observed results:

```json
{
  "parent-swap-read-refused": {"escapedRead":true,"refused":false},
  "parent-swap-patch-refused": {"escapedWrite":true,"refused":false}
}
```

## Root mechanism

`packages/core/src/agent-runtime/coding-tool-paths.ts` resolves and validates an absolute path
before awaiting authorization. `coding-tool-files.ts` subsequently opens that path, and
`coding-tool-search-patch.ts` re-reads and atomically replaces it. `O_NOFOLLOW` protects only
the final path component, not mutable ancestors. The patch's content digest cannot distinguish
an outside file with identical original contents. Its in-process path lock does not bind directory
identity or exclude another actor's rename/symlink replacement.

## Required result

Published direct tools must preserve their declared filesystem root and authorized target identity
through the actual effect, or refuse when that guarantee cannot be maintained. This is not a
request to sandbox arbitrary host-authorized executables. Do not solve it by requiring consumer
wrappers, weakening the boundary to path-spelling alone, or using a one-time repeated realpath check
as proof against a remaining check/use race.

## Acceptance

- [x] Reproduce parent replacement during asynchronous authorization with deterministic barriers.
- [x] Refuse escaped reads and writes/patches without exposing or modifying outside fixture data.
- [x] Audit search, resource reads, new-file writes and patch temporary-file creation for the same
      ancestor-identity boundary; cover the reachable siblings with regression tests.
- [x] Preserve regular bounded read/search and valid digest-guarded patch behavior, including
      concurrent stale-content refusal.
- [x] Document supported platform guarantees and any fail-closed limitations explicitly.
- [x] Execute actual packed Bun and Node consumers and publish the corrected core artifact.
      Record release version, source SHA, artifact integrity and exact test names.

## Related independent mechanism

`../in-progress/2026-08-30-coding-command-descendant-cancellation.md` owns subprocess cancellation.
It is not a duplicate of this filesystem boundary; both need passing public-consumer evidence.

## Что сделано

- `packages/core/src/agent-runtime/contained-files.ts` now traverses opened directory descriptors;
  reads pin the file, writes and patches pin their parent, and search/resource traversal opens each
  child before descending. Identity changes after async authorization fail closed.
- `packages/core/tests/agent-coding-tools.test.ts`, cases `refuses read, new-file write and patch when
  authorization loses parent identity` and `search skips a parent replaced by an outside symlink
  after authorization`, cover deterministic swaps without reading or modifying outside data.
- `packages/core/tests/agent-harness-public.test.ts`, case `resource discovery refuses a symlinked
  ancestor instead of reading outside its root`, covers harness resources. Existing regular read,
  search and concurrent stale-base cases remain green.
- Linux `/proc/self/fd` and macOS/FreeBSD `/dev/fd` guarantees plus the fail-closed platform limit
  are documented in the Agent guide, API reference and `Released migration: 0.70.0`.
- Full `bun run verify` passed on tree `e23094e6b7f3`; exact-SHA CI run `33308956173` passed.
- Published as `stitchkit@0.70.0`, source
  `d2478418469ae8ebb8dfce195e621c637422d178`, integrity
  `sha512-2aVY8ZlqVqRnw6tmJkavFRgFQJ2Qq+IZqygFwCqgyksD7232jQEZmoJ7r8dZBDL/XS55Nc1ftKAQdbH3WldNVQ==`.

Completed: 2026-08-30 11:31 +0000
