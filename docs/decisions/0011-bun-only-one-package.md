---
title: "ADR 0011 — Bun-only, published as one small package"
type: decision
status: accepted
created: 2026-05-20
updated: 2026-05-20
---

# ADR 0011 — Bun-only, published as one small package

- **Status:** Accepted
- **Date:** 2026-05-20

## Context

stitchkit ships to npm as an open-source package. That raised three questions:
which runtimes to support, how to package the code, and how to keep quality
green across contributors.

## Decision

**Bun-only.** stitchkit targets Bun and only Bun. It uses `Bun.serve()`,
`bun:test` and other Bun APIs directly; there is no Node or Deno compatibility
shim. `package.json` declares `engines.bun >= 1.2`. A compatibility layer would
dilute every decision in this document — ADR 0001 exists *because* the target is
a single fast runtime.

**One package, subpath exports.** Published as a single package, `stitchkit`,
with subpath exports — `/server`, `/tools`, `/react`, `/contract` — and a
browser-safe root entry. `ky` is the only runtime dependency. Everything else is
a **peer dependency**: `zod` (required), and `@modelcontextprotocol/sdk`, `ai`,
`socket.io`, `socket.io-client`, `@socket.io/bun-engine`,
`@tanstack/react-query`, `react-query-kit`, `react` (all optional). Peers
guarantee the consuming app shares one instance of each.

**Built output.** Consumers receive built `dist/` — `bun build` for JavaScript,
`tsc` for declarations — not raw `src/`. The TypeScript config is split:
`tsconfig.json` typechecks `src` and `tests`, and `tsconfig.build.json` emits
declarations from `src` only.

**Quality gate.** Biome handles lint and format. A CI workflow runs lint,
typecheck, tests and build. Two git hooks enforce the same locally: `pre-commit`
auto-formats staged files and blocks the commit on any warning; `pre-push` runs
the full `verify` suite. Dirty code cannot reach the remote.

## Consequences

- Small, dependency-light, Bun-native.
- Not usable on Node or Deno — a deliberate, accepted limitation.
- One published package keeps installation and versioning simple; subpath
  exports keep browser bundles free of server code.
