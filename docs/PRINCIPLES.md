---
title: "stitchkit — Principles"
description: What stitchkit is, the invariants every decision answers to, and what it says no to.
type: principles
status: active
created: 2026-09-23
updated: 2026-09-23
---

# What stitchkit is

**One contract, every surface.** An operation is declared once with `defineContract()` — method,
path, Zod schemas, scope, exposure. The HTTP route, the MCP tool, the agent tool, the CLI command and
the typed client are projections of that one declaration, so they cannot drift. Everything else in
the package exists to serve that idea or is an optional, separately bounded product beside it.

## Invariants

Each ADR in the [index](./decisions/README.md) names the invariant it serves, or is marked `P`
(a practice or incident record) or superseded.

| Id | Invariant | Established by |
|----|-----------|----------------|
| I1 | Declare an operation once; derive every surface and the client from it, never hand-write one twice. | 0005, 0007, 0016, 0018, 0168, 0196 |
| I2 | Give every surface the same validation, auth, errors and observability as HTTP; declare any exception. | 0014, 0027, 0038, 0045, 0087 |
| I3 | Make the schema the source of truth: types are inferred, casts live only at named boundaries. | 0003, 0050, 0058 |
| I4 | Keep the core generic: domain, storage, wording and billing belong to the application. | 0002, 0019, 0110, 0166 |
| I5 | Wrap the stack you already use; never ship a competing engine or a fullstack framework. | 0001, 0008, 0010, 0069 |
| I6 | Keep the core Web Fetch-clean; Bun and Node are adapters around it. | 0013, 0032, 0120 |
| I7 | Keep optional peers optional: a provider or peer lives in an isolated subpath leaf, proven from the packed artifact. | 0011, 0090, 0122, 0160 |
| I8 | Extend the owner that already exists; one mechanism per job, no parallel path, alias or shim. | 0028, 0055, 0059, 0170, 0199 |
| I9 | Make every declared option load-bearing; an unanswered question is an error, not a default. | 0076, 0115, 0155, 0176 |
| I10 | Bound everything: buffers, streams, deadlines, capacity and retained state have a declared finite limit. | 0057, 0107, 0118, 0125 |
| I11 | Compose one process; durable jobs, supervision, deployment and the project declaration never become conditions. | 0089, 0102, 0104, 0144 |
| I12 | Decide trust before work: authorize before parsing, fence every lane, keep unchecked trust visible. | 0072, 0151, 0172, 0193 |
| I13 | Report only what was observed: the cause stays inside, a safe error goes out, nothing is synthesised. | 0012, 0042, 0109, 0189 |
| I14 | Every entrypoint declares its maturity; stable is earned and kept on a budget; a break is marked, migrated, never silent. | 0068, 0103, 0111, 0198 |
| I15 | Treat the agent runtime as a separate product with a one-way boundary and one atomic store. | 0098, 0100, 0142, 0175, 0197 |

## Not in stitchkit

These bind new work. None of them requires removing what already ships.

- **No provider in the core.** A provider or peer adapter is allowed only as an isolated subpath
  leaf (`…/openrouter`, `…/grammy`, `…/opentelemetry`); `contract`, `server` and `tools` never
  import one.
- **No stable entrypoint without two consumers.** A new entrypoint starts evolving; promotion to
  stable needs two independent consumers and its own ADR (0198). Nothing is demoted for lack of them.
- **No second way to do the same thing.** A new mechanic extends the existing owner (I8), or it
  does not ship.
- **No domain logic.** Business entities, prompts, tables, reports and policy wording stay in the
  application (I4).
- **No deploy infrastructure.** No process supervisor, job queue, scheduler across processes,
  container, host or port policy (I11).

## The agent runtime

`stitchkit/agent-runtime` (with its leaves) is a second product inside the package. The boundary is
one-way: agent-runtime may import the core; the core (`contract`, `server`, `tools`, `application`)
never imports agent-runtime — shared machinery lives in neutral modules both import. Its breaking
changes form their own changelog lane: every breaking entry starts with the entrypoint it breaks, so
a contract-only consumer can see what does not concern it. It stays in this package because a
separate package would have to publish the internal modules it depends on. **Trigger for a physical
split:** a consumer that does not import agent-runtime is blocked by one of its breaking changes, or
the internals it depends on become public for another reason.

Direction lives in [VISION.md](./VISION.md); the release plan in [ROADMAP.md](../ROADMAP.md).
