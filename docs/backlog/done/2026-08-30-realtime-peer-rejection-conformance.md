---
title: Accept peer rejection in realtime conformance observations
description: Keep the realtime probe schema aligned with the canonical rejected-event reasons so a real peer refusal can be observed instead of failing normalization.
type: task
status: done
created: 2026-08-30
updated: 2026-08-30
completed: 2026-08-30 15:08 +0000
---

## Зачем

`RealtimeRejectedEvent.reason` includes `rejected-by-peer`, while
`RealtimeRejectionObservationSchema` accepts only the four earlier local validation reasons.
`createRealtimeProbeDriver` passes the canonical event through that narrower schema, so a real
peer rejection can fail observation parsing instead of producing the declared conformance result.

This is an existing baseline mismatch, not part of the proposed live synchronization API.

## Результат

Realtime conformance accepts every canonical rejection reason and preserves peer/local fault and
phase without weakening validation or adding a parallel reason registry.

## План

- [x] Derive or align the observation reason schema with the canonical realtime rejection reason.
- [x] Add a regression fixture that sends an invalid frame to a mismatched peer and observes
      `rejected-by-peer` through `createRealtimeProbeDriver`.
- [x] Keep the public observation shape, reference and generated documentation synchronized.

## Acceptance

- [x] A real peer rejection produces `outcome: realtime_rejected` with
      `reason: rejected-by-peer` instead of throwing during observation normalization.
- [x] Existing unknown-event, arguments, acknowledgement and missing-acknowledgement cases retain
      their exact outcomes.
- [x] Completed evidence names the exact test file and case.

## Что сделано

- `RealtimeRejectionObservationSchema` now reuses the canonical direction, phase, reason and fault
  schemas instead of maintaining a narrower reason registry.
- `packages/core/tests/realtime-rejection-visibility.test.ts` — `a real peer refusal is normalized
  by the realtime conformance driver`, `retains exact local outcomes for unknown events and
  missing acknowledgements`.
- `packages/core/tests/surface-conformance-kit.test.ts` — `normalizes a real bound transport across
  event, ack, rejection and disconnect scenarios` retains exact invalid-argument and invalid-
  acknowledgement observations.
