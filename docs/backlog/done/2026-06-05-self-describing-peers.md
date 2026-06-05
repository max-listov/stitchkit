---
title: Self-describing optional peers — actionable error + feature→peer matrix
description: Optional peers (socket.io, @socket.io/bun-engine, …) don't auto-install. A missing one surfaced as a raw `Cannot find module` at bootstrap. Turn it into an actionable "install X" error, and document a feature→packages install matrix so peers are discoverable up front.
type: task
status: done
created: 2026-06-05
updated: 2026-06-05
completed: 2026-06-05 03:00
related: docs/decisions/0008-thin-wrappers.md
---

# Self-describing optional peers

**Type: DO (code + docs, thin).** Root of the migration blocker B1: a consumer's
backend crashed at bootstrap with a bare `Cannot find module '@socket.io/bun-engine'`.

## Problem

stitchkit's only runtime dependency is `ky`; everything else (socket.io,
`@socket.io/bun-engine`, MCP SDK, ai, react, srvx) is an **optional peer** — the
correct design (ADR 0008/0011/0013: thin wrappers, you own the version, pay only
for what you use; `bun-engine` is Bun-only so it *cannot* be a hard dep). Bundling
would be the anti-pattern.

But optional peers are **not auto-installed**, and the failure mode was poor:
`createSocketIOServer` does `await import('@socket.io/bun-engine')`, so a missing
peer surfaced as a raw `Cannot find module` at production bootstrap — the consumer
had to reverse-engineer which package to add. There was also no single
"feature → packages" map.

The fix is **discoverability**, not bundling: stitch should *tell you* what it
needs, when it needs it.

## Acceptance

- [x] A missing optional peer throws an actionable error naming the package +
      install command, not a bare `Cannot find module`.
- [x] A feature→packages install matrix in getting-started (incl. the Bun vs Node
      Socket.IO engine split).
- [x] No `as` casts; `bun run verify` green.

## Что сделано (2026-06-05)

- [x] **`importPeer()` helper** (`server/socket-io.ts`) — wraps the dynamic
  `import('socket.io')` / `import('@socket.io/bun-engine')`; on a module-not-found
  (`isModuleNotFound`) rethrows `"[stitchkit] createSocketIOServer needs the
  optional peer \"X\" — install it: bun add X"` (preserving `cause`), else rethrows
  the original.
- [x] **Docs** — getting-started "Dependencies" rebuilt as a **feature → install**
  matrix (Bun server vs Node `serveNode`+srvx, Socket.IO Bun = `socket.io` +
  `@socket.io/bun-engine`, Node = `socket.io`, MCP, agent, react), with install
  commands + the actionable-error note. `realtime.md`/deployment already note the
  Bun/Node engine split. CHANGELOG.
- [x] **Scope note:** wrapped the *dynamic* peer imports (the real B1 case).
  Static-import peers (MCP SDK in `/tools`, srvx in `/node`) fail at entrypoint
  load and are covered by the matrix rather than a wrapper.

**Verdict:** peers stay peers (right); stitch is now self-describing. Ships in **0.7.0**.
