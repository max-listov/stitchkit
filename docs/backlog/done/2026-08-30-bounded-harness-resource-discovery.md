---
title: Bounded harness resource discovery
description: Discover explicit instruction, skill and resource roots with deterministic precedence, provenance and budgets.
type: task
status: done
created: 2026-08-30
updated: 2026-08-30
priority: P1
completed: 2026-08-30 04:01 +0000
pipeline: composable-agent-harness
order: 2
depends-on: 2026-08-30-failed-run-continuation-evidence.md
---

## Зачем

The headless harness accepts a resource loader but every filesystem-backed host still has to
implement traversal, precedence, validation, provenance, symlink containment and diagnostics.
That repeated boundary is security-sensitive and prevents a small harness from supporting skills
without application-specific glue.

## Результат

- An optional server-only loader reads explicitly declared roots and returns the existing
  `AgentHarnessResourceResult`; it does not invent global paths or workspace policy.
- Instructions, skill summaries and ordinary resources have deterministic precedence and immutable
  provenance. Duplicate logical names and ambiguous shadowing fail closed.
- File count, per-file bytes, aggregate bytes, traversal depth and diagnostics are bounded.
- Initial prompts receive only bounded skill name, description and provenance. Exact skill content
  and supporting resources are loaded later through direct typed operations.
- Discovery and refresh are explicit calls. Watching and activation policy remain host-owned.

## План

- [x] Specify caller-assigned root IDs, precedence, supported file shapes, shadowing and containment.
- [x] Implement the loader over the existing harness resource contract.
- [x] Cover symlink escapes, duplicate names, malformed skill metadata, deterministic ordering and
  Bun/Node filesystem behavior.
- [x] Publish the optional entrypoint and update guide/API/generated agent documentation.

## Acceptance

- [x] A packed consumer discovers one instruction, one skill summary and one resource from explicit roots,
  then reads the exact selected skill without eagerly injecting every skill body.
- [x] The applied profile reports exact kind/name and `rootId:relative/path` provenance without
  resource text, absolute host paths or host secrets.
- [x] Invalid or over-budget trees fail before inference and cannot escape declared roots.
- [x] Callers can continue supplying a fully custom loader with no behavior change.

## Что сделано

- Добавлен immutable-per-loader discovery generation с explicit roots, `O_NOFOLLOW` bounded reads,
  provenance, strict duplicate/budget checks и lazy direct `harness_read_resource`.
- `packages/core/tests/agent-harness-public.test.ts` — `discovers explicit roots with lazy exact skill reads and opaque provenance`.
- `packages/core/scripts/consumer-lane/fixtures/node/src/headless-harness.mjs` проверяет instruction,
  skill summary, ordinary resource и exact lazy skill read в packed Bun и Node.
