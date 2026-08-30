---
title: Review live-state synchronization and optional realtime extensions
description: Decide the smallest reusable live-state mechanism while preserving existing transport, delivery and application ownership boundaries.
type: task
status: done
created: 2026-08-30
updated: 2026-08-30
completed: 2026-08-30 15:08 +0000
pipeline: live-state-synchronization
order: 0
depends-on: —
---

## Зачем

Applications using native browser WebSocket and Bun server sockets repeat schema validation,
subscription ownership, synchronization and slow-consumer handling. A Socket.IO-only typed
surface does not cover those applications, although much of the machinery is independent of
the wire protocol. Reuse should remove repeated correctness mechanisms without introducing
a universal networking framework.

This began as an intake proposal for architectural review, not an accepted architecture or an
instruction to begin implementation or publication. Child proposals may remain active or move to
icebox as the review resolves them. Review can accept, narrow, merge or reject each outcome. Native transport work requires an
explicit decision about ADR 0008 and ADR 0069; do not reinterpret their current prohibition
as if an exception already existed.

## Current review disposition

The program is a bounded architecture review, not an eight-feature implementation queue.
Current source evidence supports one potential missing mechanism: transport-neutral
snapshot/event synchronization. It does not support a second framework-owned realtime engine
or a generic lowest-common-denominator adapter.

The accepted implementation proposal contains two active slices:

1. use two real source bindings to prove the unsafe snapshot/subscribe gap, then extract a
   minimal synchronization controller with deterministic internal conformance;
2. publish the proven Socket.IO and typed HTTP-stream compositions as packed adoption recipes.

The generic adapter, native WebSocket engine, standalone shared-subscription resource,
standalone network-delivery layer and separate public conformance kit remain preserved as frozen
intake hypotheses. Their files state concrete defrost evidence instead of being silently treated
as accepted dependencies.

## Verified starting point

Source review on 2026-08-30 inspected the core manifest at 0.70.1; the initial design analysis
used 0.69.0. Re-check the current exported package before implementation. This intake did not
run runtime probes, benchmarks or tests and does not claim a reproduced transport defect.

Already present:
- Directional Zod realtime contracts and Socket.IO runtime validation:
  `packages/core/src/realtime/`, `packages/core/src/browser/socket-io.ts`.
- Socket.IO on Bun and native lane composition:
  `packages/core/src/server/socket-io.ts`, `packages/core/src/server/websocket.ts`.
- Emitter-based React Query integration: `packages/core/src/react/cache-bridge.ts`.
- Socket.IO retained topics replay one last payload to late local subscribers, while
  `createActivityProjection` publishes absolute revisioned snapshots through a coalescing sink.
  These solve local latest-value delivery; neither defines a remote snapshot/stream boundary,
  replay cursor or gap recovery.
- Bounded ordered/latest channels and credit windows:
  `packages/core/src/application/channel.ts`.
- Typed HTTP streams, cancellation and terminal-frame validation:
  `packages/core/src/browser/contract-stream.ts`.
- Agent-specific snapshot/event and control machinery:
  `packages/core/src/agent-runtime/control-schema.ts`,
  `packages/core/src/agent-runtime/harness-control.ts`.
- Realtime manifests/probes, request-scoped phase observation and managed server/application
  lifecycle. These are extension points, not missing features to implement again.

Relevant accepted decisions: [0008](../../decisions/0008-thin-wrappers.md),
[0020](../../decisions/0020-raw-websocket-lane.md),
[0069](../../decisions/0069-realtime-contracts-validate-without-owning-delivery.md).

## Verified external boundaries

Official documentation checked on 2026-08-30 supports the narrow review:

- [Socket.IO delivery guarantees](https://socket.io/docs/v4/delivery-guarantees/) preserve
  message order when messages arrive, but default arrival is at-most-once; missed server events
  and stronger recovery remain application concerns.
- [Socket.IO connection-state recovery](https://socket.io/docs/v4/connection-state-recovery/)
  explicitly says recovery can fail and the application must still synchronize client and server
  state. Adapter support also differs, so transport recovery cannot be the controller's only fact.
- [Bun WebSocket backpressure](https://bun.sh/docs/runtime/http/websockets#backpressure) reports
  local send outcomes (`-1` queued under pressure, `0` dropped, positive bytes handed off), not
  peer processing. Browser WebSocket has no incoming pause/resume backpressure API. These facts
  justify keeping pressure observations local and make a native paired engine materially larger
  than a schema wrapper.

## Результат

An explicit decision separates event contracts, transport capabilities, optional live-state
synchronization and UI cache projection. Each accepted module has a bounded owner and an
independent adoption path. At least two distinct generic examples demonstrate real reuse.

## Historical intake order

The initial proposal split the subject into seven implementation-shaped tasks:

| Order | Task | Dependency and boundary |
| --- | --- | --- |
| 1 | [Contract and capabilities](../icebox/2026-08-30-realtime-contract-capability-boundary.md) | Architecture decision first; owns common types and adapter contract |
| 2 | [Native WebSocket adapter](../icebox/2026-08-30-native-websocket-realtime-adapter.md) | Accepted task 1; owns native framing/client/server, not synchronization |
| 3 | [Snapshot/event synchronization](2026-08-30-live-snapshot-event-synchronization.md) | Accepted task 1; owns recovery state, not storage or sockets |
| 4 | [Shared subscriptions](../icebox/2026-08-30-shared-subscription-resource-lifecycle.md) | Accepted task 1; owns sharing and cleanup, not cache reducers |
| 5 | [Bounded network delivery](../icebox/2026-08-30-bounded-realtime-delivery-policies.md) | Accepted task 1; reuses channel/credit mechanisms |
| 6 | [Diagnostics and conformance](../icebox/2026-08-30-realtime-adapter-observability-conformance.md) | Specify with task 1; complete evidence against accepted tasks 2–5 |
| 7 | [Integration recipes](2026-08-30-realtime-composition-adoption-recipes.md) | Finalize after accepted mechanisms and task 6 evidence |

This table is retained as intake history. It is not the current dependency map and does not
authorize implementation.

## Refined implementation order

| Order | Active slice | Decision boundary |
| --- | --- | --- |
| 1 | [Snapshot/event synchronization](2026-08-30-live-snapshot-event-synchronization.md) | Begin with two test-local real-boundary proofs, extract only their repeated state machine, reuse bounded channels internally, and prove controller-owned guarantees with deterministic fixtures |
| 2 | [Executable adoption recipes](2026-08-30-realtime-composition-adoption-recipes.md) | Replace the proof-local repetition with the accepted controller, run packed Socket.IO and HTTP-stream fixtures, and publish final guide/reference material |

The five frozen hypotheses remain independently reviewable and may be restored only when their
own defrost condition is met. No accepted ADR needs a successor unless later evidence actually
selects a second framework-owned transport or broadens the current contract boundary. A new
additive ADR is still required if the live-state controller becomes public because its source
consistency contract and state machine are a new architectural decision.

## Independent validation findings

Two validators received the same read-only prompt and independently agreed on the current map.
Both found the same plan blockers, now incorporated:

- the earlier recipes-first task mixed pre-design proof with post-controller documentation and
  created a lifecycle dependency cycle;
- current agent control proves duplicate/gap reduction but not an atomic snapshot/attach boundary;
- application channels are published through the server-oriented `stitchkit/application` entry,
  while the controller must be browser-safe and support opaque cursors;
- a source contract must guarantee a continuous boundary, not merely expose separate `snapshot`
  and `subscribe` methods;
- public synchronization conformance is premature until more than one independently maintained
  source binding needs it.

The preferred public location is the existing browser-safe root `stitchkit` entrypoint. The
controller may import the browser-clean internal bounded channel module directly; consumers do not
acquire `stitchkit/application`, and the numeric latest snapshot sink is not generalized to opaque
cursors.

## Conveyor 2/2 with stop

- [x] Maintainer review compared every proposal with the current exports and accepted ADRs.
- [x] Plan validator A reviewed all eight tasks and current source with no file edits.
- [x] Plan validator B received the identical scope and prompt with no file edits.
- [x] Validator findings are reconciled into one refined disposition.
- [x] Stop for approval before public API design or implementation; implementation began only
      after explicit approval.
- [x] Implementation validator A reviewed the completed implementation read-only and found no
      remaining concrete blocker after the final coverage regression.
- [x] Implementation validator B reviewed the completed implementation read-only and found no
      remaining concrete blocker after the final race fixes.

## Scope exclusions

No application domain models, durable event database, distributed broker, automatic command
retry, global state store, UI component library or process supervisor. Authentication policy,
authorization decisions, cursor/storage implementation and side-effect idempotency remain
application-owned. Generic admission hooks and isolation invariants may be framework-owned.

Vite HMR remains the Vite protocol; no application realtime framing around it. DNS, VPN,
deployment topology and private consumer migrations are outside this program. No performance
claim follows merely from choosing native WebSocket.

## Acceptance for review

- [x] Each child outcome is accepted, narrowed, merged or rejected with its reason.
- [x] The decision states that accepted ADRs remain historical and a public controller requires a
      new additive ADR rather than a rewrite.
- [x] Reuse versus new API is explicit, including the limits of agent-specific synchronization.
- [x] Capability, runtime, dependency and wire-compatibility boundaries are recorded.
- [x] Implementation/release criteria and any migrations are scoped only after review.

## Что сделано

- Accepted one browser-safe `createLiveStateController` primitive and executable Socket.IO,
  HTTP-stream, managed-application and React Query compositions; preserved the five broader
  transport hypotheses in icebox with explicit defrost evidence.
- Two independent implementation validators audited the final tree with identical read-only
  scope. Their last verdicts were both release-ready with no concrete blocker.
- Exact runtime evidence is recorded in the two completed child tasks and the independent
  realtime rejection task; the packed consumer lane passed against the built package.
