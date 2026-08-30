---
title: Integrated agent harness profile
description: Compose the optional harness leaves into one minimal profile while preserving every lower-level entrypoint.
type: task
status: done
created: 2026-08-30
updated: 2026-08-30
priority: P1
completed: 2026-08-30 04:01 +0000
pipeline: composable-agent-harness
order: 6
depends-on: 2026-08-30-bounded-harness-resource-discovery.md, 2026-08-30-agent-approval-continuations.md, 2026-08-30-agent-control-client-and-view.md, 2026-08-30-agent-output-artifacts-and-coding-transactions.md
---

## Зачем

Individual primitives preserve composability, but a host should not have to rediscover their
correct wiring to obtain a small coding harness with skills, controls, permissions and recovery.
That wiring should be executable reference composition, not a new god factory that hides ownership.

## Результат

- Existing optional entrypoints compose selected resources, tools, approvals, artifacts, control
  protocol and view projection over `createHeadlessAgentHarness`.
- Every feature is opt-in. Omitting a leaf means no dependency, background work or implied access.
- Runnable references demonstrate structured control and canonical resync; a transport, terminal
  renderer and process lifecycle may be supplied by any application.
- Capability/provenance evidence states exactly which profile was applied to each run.

## План

- [x] Prove the smallest reference configuration from existing public entrypoints; add no integrated
  factory unless packed use demonstrates an irreducible lifecycle invariant.
- [x] Compose leaves without re-export collisions, hidden defaults or duplicated lifecycle.
- [x] Add one realistic skills-plus-coding scenario with search, approval and referenced output;
  cover interruption/resync in the shared runtime/control regression suite.
- [x] Update VISION, architecture, ADR index, guide, API reference, package docs, generated agent
  docs, changelog and optional-entrypoint inventory.
- [x] Run full Bun/Node packed consumers and the complete repository gate.

## Acceptance

- [x] A consumer can use only `mountAgent`, only `createAgentRuntime`, selected harness leaves or the
  integrated profile with no forced migration.
- [x] One end-to-end packed scenario discovers and reads a skill, finds and patches a file, requests
  approval, preserves and reads referenced output; control regressions reconnect from the same
  canonical snapshot/event contract.
- [x] No provider-specific gateway, product prompt, renderer, daemon or deployment policy ships.
- [x] Public exports, docs and release notes name exact tested behavior and optional dependencies.

## Что сделано

- Harness remains a composition of optional public leaves; no integrated god factory, daemon,
  renderer, provider gateway or PTY supervisor was added. ADR 0131 records direct-identity boundaries.
- `packages/core/tests/agent-harness-public.test.ts` — `switches caller-provided models without changing direct tool or resource identity`;
  `packages/core/tests/agent-harness-example.test.ts` and `packages/core/tests/headless-agent-runner.test.ts` cover reference composition/control.
- Packed Bun/Node proof lives in `packages/core/scripts/consumer-lane/fixtures/node/src/headless-harness.mjs`.
