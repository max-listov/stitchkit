---
title: Executable agent harness composition and capability map
description: Provide a minimal typed harness recipe using existing runtime primitives and isolate demonstrated API gaps.
type: task
status: done
priority: P1
created: 2026-08-28
updated: 2026-08-28
completed: 2026-08-28
---

## Why

The runtime already exposes model resolution, prompt composition, scoped tools,
admission policies, history projection/compaction, durable store operations and events.
A consumer still needs a coherent executable composition showing how these pieces
form a headless harness without an additional execution loop or parallel session queue.

This is a composition/documentation enhancement, not a claim that these primitives
are absent. Begin with the current source; do not add aliases for capabilities that exist.

## Source reference

Study Pi at https://github.com/earendil-works/pi, inspected commit
6c87d9a026677b601e8278030dcf1ad97fe0bd86 (MIT; retain notices if any code is reused):

- packages/agent/src/agent-loop.ts: execution loop, steering and follow-up boundaries.
- packages/coding-agent/src/core/agent-session.ts: session orchestration over agent core.
- packages/coding-agent/src/core/resource-loader.ts: typed resources and diagnostics.
- packages/coding-agent/src/core/session-manager.ts: append-only JSONL tree and context projection.
- packages/coding-agent/src/modes/rpc/rpc-mode.ts: transport boundary (inspect before drawing conclusions).

Pi steering is not an alias for interrupt-next: steer waits for current tool calls;
interrupt-next terminates the active run and prioritizes the next durable admission.
Document this distinction. JSONL persistence, tree branching and a terminal UI are
not requirements for this implementation.

## Result and boundaries

An executable, tested headless harness example and a capability matrix:
available export / recipe composition / actual API gap / application responsibility.
Prefer existing public exports. Introduce small generic primitives only for demonstrated
gaps; keep workspace discovery, application prompts, permissions and UI out of the runtime.
No second provider SDK, scheduler, process manager or mandatory plugin framework.

## Plan

- [x] Clone/read the reference at the specified commit and map patterns to current public exports.
- [x] Inspect packages/core/src/agent-runtime.ts and AgentRuntimeConfig in runtime.ts,
  composeAgentPrompt, defineModelRegistry, createAgentRuntimeStore and tool fencing.
- [x] Define startup, run admission, queue/interrupt, cancel, recovery and shutdown composition
  using injected model/tool/resource/store ports. Import must not start a process or open a DB.
- [x] Show typed resource input/provenance/diagnostics without hardcoded paths or hidden globals.
  Filesystem trust/discovery remains the embedding application's policy.
- [x] Demonstrate ordered reasoning/text/tool events and canonical snapshots with reconnect/dedup
  guidance; distinguish transient UI deltas from durable history and terminal evidence.
- [x] Demonstrate context budget vs cumulative usage, compaction and context_overflow.
  Explain TTFT/throughput measurement limits; do not derive exact tokens from character counts.
- [x] Add deterministic coverage for scoped concurrent sessions, queue/interrupt distinction,
  tool failure, terminal acceptance, recovery and resource/context isolation.
- [x] If an API gap is proven, document its minimal reproduction and implement the generic
  change with regression coverage; do not solve it through a private consumer hook.
- [x] Verify full gates, packed imports on supported Bun/Node, browser-safe boundaries,
  docs/ADR/API metadata as applicable; publish a verified release for package changes.
  Return exact version/SHA/exports and executable commands. Docs-only findings must be labelled.

## Acceptance

- [x] An embedding application can run the example using public APIs without copying a loop.
- [x] Existing queue/history/compaction semantics are preserved, not approximated by Pi names.
- [x] Optional dependencies stay optional; no filesystem or provider package leaks into browser imports.
- [x] Reference-derived patterns, actual additions and explicitly deferred capabilities are distinct.

## Что сделано

- Reference commit `6c87d9a026677b601e8278030dcf1ad97fe0bd86` was inspected and mapped in
  `docs/guide/agent-runtime.md`; Pi steering is explicitly distinct from durable
  `interrupt-next`, and JSONL trees, UI and application policy remain deferred.
- `packages/core/examples/headless-agent-harness.ts` composes public runtime, model, tool, store,
  prompt-budget and injected resource ports without import-time process, filesystem or database work.
- `packages/core/tests/agent-harness-example.test.ts` —
  `isolates scoped resources and reports their diagnostics` proves concurrent resource isolation.
- Existing regression evidence remains canonical: `packages/core/tests/agent-runtime-coordinator.test.ts`
  — `interrupt-next settles the active run then precedes ordinary pending work`; and
  `packages/core/tests/agent-runtime-parity.test.ts` —
  `applies required terminal output before commit without rejecting non-success endings` and
  `redacts internal tool failures from application events`.
- The public API reference, guide, READMEs and generated `llms.txt` surfaces describe lifecycle,
  events, recovery/dedup, context versus cumulative usage and TTFT/throughput limits.
- `bun run verify` passed the complete local release gate, including packed Bun/Node, Next/browser,
  consumer, starter, PostgreSQL and supervised lanes; release `0.68.8` carries the result.
