---
title: "ADR 0220: Compose existing agent owners"
description: "Compose contract tools, authenticated realtime control, React views and exact-run behavioral checks."
type: decision
status: active
created: 2026-09-30 22:45 +07:00
updated: 2026-09-30 23:03 +07:00
participants:
  - role: authored
    harness: Codex
    model: GPT-6
    at: 2026-09-30 22:45 +07:00
---

# ADR 0220 — Compose existing agent owners

## Decision

Ergonomic agent APIs compose the existing harness, tool mount, control server, realtime
transport and reducers. They introduce no competing loop, store, WebSocket engine or
product message projection. Full per-run callbacks stay available. Resource readers are
selected explicitly so convenience cannot widen tool allowlists.

The trusted control protocol can carry runtime identity and tool evidence; it is not a
browser input protocol. Browser requests derive a strict user-only schema. The server
binding requires authorization for each operation and delivery and derives context from
verified identity. Denial releases only that conversation on a shared socket. Detach
cancels pending attachment work, including a snapshot or authorization still in flight.

Browser controllers use canonical snapshots/events, bounded buffers and request queues,
correlated acknowledgements and connection generations. They do not replay mutations
with unknown outcomes. React subscribes to an externally owned controller. Optional
server/realtime, React and full mount-tool declarations stay in dedicated evolving leaves.
The harness-tools leaf preserves every mount option and presenter type without imposing
MCP declaration peers on the base harness.

Behavior assertions inspect one durable run and match tool call/result IDs. A completed
state can include policy/provider stops, so successful completion requires terminal
reason success. Pending approvals are not accepted output.

## Evidence and consequences

Consumer-shaped tests retain dynamic identities, lifecycle hooks and fences, exercise
real Socket.IO control and verify negative outcomes. Packed fixtures preserve Bun/Node
and optional-peer boundaries. Applications with custom loops or projections keep them;
the compositional path is optional. The starter tracks published dependencies and does
not import new framework exports before their release.

Serves I1, I2, I7, I8, I9, I10, I12, I15.
