---
title: Extend realtime diagnostics and conformance across adapter and synchronization capabilities
description: Preserve the public synchronization-conformance proposal until independent maintained source bindings require it.
type: task
status: icebox
created: 2026-08-30
updated: 2026-08-30
pipeline: live-state-synchronization
order: 94
depends-on: —
defrost: Two independently maintained synchronization source bindings repeat the same public conformance and diagnostics integration beyond the controller's internal deterministic fixtures.
---

## Зачем

An identical API does not prove identical behavior. Applications need to know whether the
connection is open, their state is synchronized, messages were refused, and why recovery
occurred. Diagnostics must describe observations rather than infer delivery or network RTT.

This proposal extends existing proof/observation surfaces. It does not claim Stitchkit lacks
realtime conformance or per-request phase hooks.

## Existing foundation

- [Realtime manifests and probes](../done/2026-08-21-realtime-surface-conformance.md):
  `createRealtimeProbeDriver`, contract snapshots and bounded behavioral scenarios.
- [Request-scoped correlation](../done/2026-08-30-realtime-request-phase-caller-correlation.md):
  local observer identity without changing native ACK or wire IDs.
- `packages/core/src/realtime/request.ts`, `realtime/contract.ts` and
  `packages/core/src/observability/`.

## Current review disposition

Frozen as a separate public surface. The synchronization task owns deterministic fixtures for the
guarantees introduced by its controller: snapshot boundary, duplicate/gap classification,
generation fencing, bounded buffering, resync and cleanup. Packed Socket.IO and HTTP-stream
evidence belongs to the adoption task. Neither requires adding synchronization as a transport to
the existing surface conformance enum.

Defrost only after two independently maintained source bindings repeat a public conformance need
that cannot remain in the controller suite and packed adoption fixtures. Connection information
may be source metadata, but a future kit must not normalize unrelated transport engines into false
equivalence.

The current `RealtimeRejectedEvent.reason` / `RealtimeRejectionObservationSchema` mismatch is a
baseline bug, not synchronization work, and is tracked separately.

## Результат

A synchronization conformance kit and metadata-only hooks extend the existing surfaces. Optional
source capabilities are explicit, but no matrix row exists merely to represent a frozen adapter.
Rejected or unavailable capabilities produce explicit unsupported outcomes where relevant, not
silent test skips.

## План

- [ ] Define source connection metadata versus synchronization phase, resync reasons, queue
      pressure/refusal, coalescing and known/unknown loss observations.
- [ ] Preserve local request correlation; do not introduce a second request identity system.
- [ ] Bound cardinality/retention and isolate observer exceptions/rejections. No payloads,
      credentials or raw auth failures in default telemetry.
- [ ] Parameterize synchronization fixtures only by capabilities used by the controller, with
      explicit unsupported outcomes instead of skipping essential assertions silently.
- [ ] Cover malformed payloads, source refusal, timeout, source restart and disconnect during
      in-flight synchronization. Transport-specific protocol and ACK cases remain in their
      existing transport suites.
- [ ] Cover snapshot/subscribe race, duplicate/gap recovery, stale generation callbacks, opening
      cancellation, repeated attach/detach and pressured consumers.
- [ ] Use real transport/packed browser and server fixtures for boundary claims; deterministic
      state-machine tests supplement them and do not replace them.
- [ ] Document each timestamp's observation boundary; engine handoff/decoder receipt is not
      physical network timing, durable processing or exactly-once delivery.

## Acceptance

- [ ] Equivalent declared synchronization-source capabilities pass the same behavioral assertions.
- [ ] Differences and unsupported capabilities are explicit in the public matrix.
- [ ] Failure paths expose stable bounded metadata without secrets or observer-induced failures.
- [ ] Reconnect and cleanup probes demonstrate no accumulating owned timers/listeners/resources.
- [ ] Completed evidence names exact test files/cases and packed runtime/browser scenarios.
- [ ] No probe owns caller credentials, foreign processes or unbounded setup/teardown.
