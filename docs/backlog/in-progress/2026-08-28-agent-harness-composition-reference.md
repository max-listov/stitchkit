---
title: Executable agent harness composition and capability map
description: Provide a minimal typed harness recipe using existing runtime primitives and isolate demonstrated API gaps.
type: task
status: in-progress
priority: P1
created: 2026-08-28
updated: 2026-08-28
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

- [ ] Clone/read the reference at the specified commit and map patterns to current public exports.
- [ ] Inspect packages/core/src/agent-runtime.ts and AgentRuntimeConfig in runtime.ts,
  composeAgentPrompt, defineModelRegistry, createAgentRuntimeStore and tool fencing.
- [ ] Define startup, run admission, queue/interrupt, cancel, recovery and shutdown composition
  using injected model/tool/resource/store ports. Import must not start a process or open a DB.
- [ ] Show typed resource input/provenance/diagnostics without hardcoded paths or hidden globals.
  Filesystem trust/discovery remains the embedding application's policy.
- [ ] Demonstrate ordered reasoning/text/tool events and canonical snapshots with reconnect/dedup
  guidance; distinguish transient UI deltas from durable history and terminal evidence.
- [ ] Demonstrate context budget vs cumulative usage, compaction and context_overflow.
  Explain TTFT/throughput measurement limits; do not derive exact tokens from character counts.
- [ ] Add deterministic coverage for scoped concurrent sessions, queue/interrupt distinction,
  tool failure, terminal acceptance, recovery and resource/context isolation.
- [ ] If an API gap is proven, document its minimal reproduction and implement the generic
  change with regression coverage; do not solve it through a private consumer hook.
- [ ] Verify full gates, packed imports on supported Bun/Node, browser-safe boundaries,
  docs/ADR/API metadata as applicable; publish a verified release for package changes.
  Return exact version/SHA/exports and executable commands. Docs-only findings must be labelled.

## Acceptance

- [ ] An embedding application can run the example using public APIs without copying a loop.
- [ ] Existing queue/history/compaction semantics are preserved, not approximated by Pi names.
- [ ] Optional dependencies stay optional; no filesystem or provider package leaks into browser imports.
- [ ] Reference-derived patterns, actual additions and explicitly deferred capabilities are distinct.
