---
title: "ADR 0095: Async-operation contracts have one factory and typed adapters"
description: A canonical capability contract can bind differing endpoint envelopes without moving job ownership into Stitchkit.
type: decision
status: accepted
created: 2026-08-21
updated: 2026-08-21
---

# ADR 0095 — Async-operation contracts have one factory and typed adapters

## Context

The runtime-only async-operation descriptor removed repeated transport logic,
but contract-backed applications still hand-authored the same start, status,
wait, cancel, result and artifacts method family. Existing contracts also often
return a start snapshot while follow-up methods accept only an id.

## Decision

`defineAsyncOperationContract` creates one dedicated, Zod-first capability
contract from named id, start-input, start-output and snapshot schemas. Optional
capabilities are present only when declared. It defines HTTP contract shape; it
does not mount routes or run jobs. Canonical shorthand requires an ID schema
whose input and output types are equal because it uses the parsed ID directly
as every follow-up wire input. Literal contract and per-capability scopes are
retained in the generated endpoint types.

`bindContractAsyncOperation` accepts typed input/output adapters at capability
boundaries. In particular, `idFromStart` derives the canonical id from a parsed
start result, and follow-up input adapters derive each endpoint's accepted
envelope from that id. Adapter outputs are parsed by the endpoint schemas before
handler invocation. Schema identity is not a substitute for this runtime
validation. Direct binding remains the schema-identity short form only for a
wire-stable ID: no transform, coercion, default or overwrite anywhere in the
schema, including a same-type effect. Transformed IDs use adapted binding with
an explicit inverse wire projection.

## Consequences

- New operations share one canonical capability vocabulary across runtime-only
  and contract-backed modes.
- Existing `start -> snapshot` and `status/wait -> { id }` contracts bind
  without casts or duplicated transport definitions.
- Storage, authorization, queues, state transitions and job execution remain
  application-owned as required by ADR 0089.
