---
title: MCP SDK v2 is one stateless hard cut
description: Adopt split SDK v2 packages, one stateless transport and explicit modern protocol policies.
type: decision
status: active
created: 2026-08-09
updated: 2026-08-09
---

# 0068 — MCP SDK v2 is one stateless hard cut

## Decision

Stitchkit uses the split TypeScript SDK v2 packages and protocol `2026-07-28`.
HTTP is stateless only and exposes one closeable `{ fetch, close }` handler.
The official SDK may serve its supported legacy stateless era through the same
handler, but Stitchkit keeps no v1 API, stateful transport, alias or shim.
This official dual-era boundary remains the default while the SDK's own v2
client still opens in the legacy era unless version negotiation is explicitly
enabled. Removing it would reject otherwise supported hosts without making the
framework core cleaner; applications that control every host can select
`legacy: 'reject'`.

Modern cache hints, routing metadata and MRTR are explicit policies on the same
contract/runtime surface. OAuth uses deterministic pre-registered → CIMD →
explicit-DCR resolution; CIMD is the default and DCR is opt-in.

## Consequences

- Consumers migrate imports and route/shutdown ownership in one breaking minor.
- Static descriptors may be prepared once; per-request auth/context never is.
- Unsupported continuity/subscription capability is neither emulated nor
  advertised.
- Legacy support is an SDK-owned wire codec only: it adds no Stitchkit session,
  compatibility wrapper or second framework API.
- Consumer migration is mechanically documented with before → after examples
  and verified from packed Bun and Node projects.

This supersedes ADR 0049's remaining stateful option while preserving its
restart-safe stateless rationale.
