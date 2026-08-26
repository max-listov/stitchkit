---
title: "ADR 0103: Every entrypoint declares how settled it is"
description: "Two declared maturity levels — stable and evolving — so a consumer chooses a surface knowing how often its shape moves, without slowing the surfaces that are still finding it."
type: decision
status: accepted
created: 2026-08-24
updated: 2026-08-24
---

# ADR 0103 — Every entrypoint declares how settled it is

## Context

The package publishes sixteen entrypoints of very different ages. The contract,
HTTP server, typed client, MCP tools and CLI have not broken in months. The
agent runtime appeared in 0.56.2 and within thirty-six hours went through three
breaking minors — 0.57.0 and 0.59.0 redefined the store contract, 0.58.0 changed
the default history projection and operator-event redaction; fifty-one minutes
separated two of them. The application kernel shipped a day later.

None of that is a defect. Pre-1.0 the shape is being found, every break is
marked in the changelog with a before → after snippet and a migration section,
and the caret keeps a consumer from crossing one on a plain install.

The defect was that a reader could not tell the two apart. Both new surfaces are
documented in the same tone, in the same guide structure, with no signal
anywhere — table, guide header, VISION — that one has settled and the other is
actively moving. A consumer choosing between `mountAgent` and
`stitchkit/agent-runtime` was making a real decision without the fact that most
determines its cost.

Splitting the volatile surfaces into their own npm packages would carry the
signal, but the isolation such a split usually buys is already in place:
separate entrypoints, optional peer dependencies, a bundle matrix that fails on
an accidental runtime edge, and a dependency direction the core never reverses.
A second package adds a second version, a second release lane and duplicated
gates to communicate something a column can say.

## Decision

Every published entrypoint declares one of two maturity levels.

**Stable** — the shape changes rarely, and only for a reason worth a migration.
**Evolving** — the shape is still being found and may be redefined in any minor,
always with a `### ⚠️ Breaking changes` entry and a migration section, never
silently.

The declaration lives in three places: the entrypoint table in the getting
started guide, the header of the guide for each evolving surface (above its
first code example), and `VISION.md`. A machine check requires every key in
`package.json#exports` to appear in the table with a level; a new entrypoint
cannot be published without declaring one.

Today: `stitchkit`, `/contract`, `/server`, `/node`, `/tools`, `/cli`,
`/remote`, `/files`, `/observability`, `/testing` and `/react` are stable.
`/agent-runtime`, `/agent-runtime/openrouter`, `/application`,
`/application/grammy` and `/application/opentelemetry` are evolving.

**"No consumer depends on it yet" is never an argument for exercising this
permission.** The authority to redefine an evolving surface is this ADR, which
does not rest on a fact nobody can check: a package on a public registry cannot
enumerate who installed it, so the claim is unfalsifiable in principle — and it
was made twice in one afternoon in this repository and was false both times, a
consumer having already existed. The cadence a surface has actually kept is
published beside it in the entrypoint table and derived from the changelog
(`scripts/surface-cadence.ts`), because a permission is not a plan and the
question a reader is really asking is how often it happens. → ADR 0111.

Promoting a surface from evolving to stable is a decision of its own and
requires its own ADR. Demotion does not exist: a stable surface that needs to
move breaks in a minor like any other, which is what the level already permits.

The level changes no versioning policy. A minor still carries breaking changes
and a patch is still additive, uniformly, for every entrypoint.

## Consequences

- A consumer choosing a surface knows how often to expect a migration, and can
  weigh `mountAgent` against `stitchkit/agent-runtime` on that basis.
- The declaration legalises the pace rather than restraining it: an evolving
  surface may keep moving quickly without the churn reading as instability.
- Publishing a new entrypoint requires a deliberate statement about it, because
  the check refuses one without a level.
- Two surfaces carry a visible invitation to break them, which is a cost paid
  knowingly: the alternative was breaking them just as often while implying
  otherwise.
