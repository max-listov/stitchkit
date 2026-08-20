---
title: "Portable managed-file primitives on Bun and Node"
description: Evidence and threat-model boundary for opened reads and atomic no-replace/replace commits.
type: research
status: complete
created: 2026-08-20
updated: 2026-08-20
---

# Portable managed-file primitives on Bun and Node

## Evidence

- Bun documents `node:fs` as fully implemented and recommends it for directory
  operations: [Node.js compatibility](https://bun.sh/docs/runtime/nodejs-compat),
  [File I/O](https://bun.sh/docs/runtime/file-io).
- Node documents `fsPromises.link(existingPath, newPath)` as hard-link creation,
  `rename(oldPath,newPath)` as rename, `open` numeric flags, and explicitly says
  `copyFile` atomicity is not guaranteed:
  [Node filesystem API](https://nodejs.org/api/fs.html).
- Local probes on supported Bun 1.3.14 and Node 22 verified the common subset:
  hard-link commit fails with `EEXIST`, same-filesystem rename replaces the
  destination, and `O_NOFOLLOW` rejects a symlink target. The same operations
  are exercised in `managed-file-boundary.test.ts` and the real Node smoke.

## Conclusion

The portable implementation can guarantee containment against untrusted
canonical relative input and pre-existing symlinks when the bound root is
application-owned. Neither runtime exposes a portable descriptor-relative
component walk equivalent to a complete `openat2` policy across Linux, macOS and
Windows, so concurrent hostile directory replacement is not claimed. Reject is
implemented as same-directory temp plus hard-link; replace as same-directory
temp plus rename. Both provide atomic visibility on the supported filesystem;
only explicit file sync addresses durability, and directory-entry durability is
not promised.

## Windows boundary

`fs.constants.O_NOFOLLOW` is not portable to Windows, so the implementation
uses it only when the runtime exposes the flag. The remaining realpath/root
containment still applies, but this research did not validate Windows device
names (`CON`, `NUL`, and related aliases), trailing dots/spaces or filesystem
normalization. `ManagedFilePathSchema` consequently makes no Windows-security
claim. Adding Windows support must begin with an explicit path-policy decision
and a real Windows conformance lane rather than treating a missing flag as
equivalent behavior.
