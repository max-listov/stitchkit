---
title: Preserve coding-tool containment when a parent directory changes during authorization
description: Refuse read and patch operations when a previously resolved ancestor is replaced by an outside symlink before the filesystem effect.
type: task
status: in-progress
created: 2026-08-30
updated: 2026-08-30
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

- [ ] Reproduce parent replacement during asynchronous authorization with deterministic barriers.
- [ ] Refuse escaped reads and writes/patches without exposing or modifying outside fixture data.
- [ ] Audit search, resource reads, new-file writes and patch temporary-file creation for the same
      ancestor-identity boundary; cover the reachable siblings with regression tests.
- [ ] Preserve regular bounded read/search and valid digest-guarded patch behavior, including
      concurrent stale-content refusal.
- [ ] Document supported platform guarantees and any fail-closed limitations explicitly.
- [ ] Execute actual packed Bun and Node consumers and publish the corrected core artifact.
      Record release version, source SHA, artifact integrity and exact test names.

## Related independent mechanism

`../in-progress/2026-08-30-coding-command-descendant-cancellation.md` owns subprocess cancellation.
It is not a duplicate of this filesystem boundary; both need passing public-consumer evidence.
