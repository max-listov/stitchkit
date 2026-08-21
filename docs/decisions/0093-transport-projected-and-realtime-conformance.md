---
title: "ADR 0093: Surface manifests are transport projections and include realtime"
description: Manifest v2 records exact named tool projections and realtime schemas while probes observe caller-owned runtimes.
type: decision
status: accepted
created: 2026-08-21
updated: 2026-08-21
---

# ADR 0093 — Surface manifests are transport projections and include realtime

## Context

A single shared tool list overclaimed what role-selected MCP, Agent and CLI
surfaces actually advertised. Realtime contracts were absent entirely, so
event, acknowledgement and rejection drift could not be snapshot-tested with
the existing conformance kit.

## Decision

`buildSurfaceManifest` emits `manifestVersion: 2`. Canonical HTTP operations are
separate from exact `toolSurfaces`. Named MCP surfaces are plain finite
selections under one global preparation policy, exactly like the real mount;
extension filters, flattening, schema validation and multi-round capability are
not configurable per role. Agent has its own reachable presentation policy and
CLI remains a plain selection. One peer-free projector is shared by actual
mounts and manifests. Deterministic sorting and canonical schema digests apply
to every projection.

Configured realtime contract names are retained even when their registries are
empty. Non-empty contracts add direction-specific event rows with argument
input/output schemas and optional acknowledgement input/output schemas.
`assertSurfaceDiscovery` compares only the selected named surface and
caller-observed realtime topology.

Realtime conformance remains an explicit probe model: the caller binds its
existing transport per scenario and supplies contract-specific actions for
valid events, acknowledgements, invalid payloads, disconnects and timeouts. The
driver normalizes real framework errors, isolates late rejection callbacks per
invocation, observes connected state to distinguish pre-invoke from in-flight
disconnect, and disposes subscriptions without disconnecting the foreign
transport. One absolute deadline covers setup, invocation and teardown.
Stitchkit opens no port and invents no credentials or delivery guarantee.

## Consequences

- Manifest v1 snapshots and exhaustive `ConformanceTransport` maps require an
  explicit migration to v2 and `REALTIME`.
- A manifest no longer claims a capability merely because it exists in a
  broader contract.
- Realtime schema drift and runtime behavior can be checked without a second
  WebSocket engine or framework-owned test runner.
