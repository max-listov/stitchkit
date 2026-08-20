---
title: "ADR 0087: Surface conformance is a manifest plus explicit probes"
description: Deterministic discovery snapshots and consumer-supplied drivers prove transport parity without owning a test runner.
type: decision
status: accepted
created: 2026-08-20
updated: 2026-08-20
---

# ADR 0087 — Surface conformance is a manifest plus explicit probes

## Context

Contracts and runtime tools share execution guarantees, but consumers rebuilt
ad-hoc assertions for HTTP, MCP, Agent and CLI discovery, validation, errors and
cancellation. A framework-owned black-box runner would need to own application
startup and credentials.

## Decision

`stitchkit/testing` exposes two layers:

1. `buildSurfaceManifest` derives actual HTTP topology, mounted tool names,
   CLI-only commands, extensions and versioned canonical schema digests.
   `assertSurfaceManifestSnapshot` reports deterministic drift.
2. `assertSurfaceDiscovery` compares real discovery results with that manifest,
   while `runSurfaceProbes` executes explicit consumer drivers against bounded,
   caller-declared scenarios. Each probe has setup/teardown, an AbortSignal,
   timeout and a normalized outcome schema.

The kit never starts servers, invents credentials, or claims parity for a
transport absent from the explicit driver map. Diagnostics have a fixed byte
cap.

## Consequences

- Schema property insertion order does not change digests; meaningful schema or
  topology changes do.
- CLI-only and extension surfaces remain visible instead of being forced into a
  false four-way intersection.
- Consumers retain control of real runners and authentication fixtures.
