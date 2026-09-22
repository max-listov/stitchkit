# 0195 — A declaration the host can see belongs in the snapshot

**Status:** Accepted
**Date:** 2026-09-22

## Context

The surface snapshot exists so that a change to the public contract cannot reach
a consumer without a human reading the diff. `mcp.inputRequired` is such a
change: an operation that gains it starts asking a question before it runs, and
an operation that loses it stops. A host codes against both.

The snapshot did not record it. `operationFingerprint` computed the declared
rounds and used them only to detect two conflicting declarations of one
operation; `operationFrom`, which builds what is actually written to the file,
had no field for them. Measured on 0.92.0: the same operation with and without a
declared round produced byte-identical manifests. A consumer was holding the
link "declared → state key configured" with a test of their own, because our
gate did not hold it.

## Decision

An operation row carries `mcp`. It is `null` when no MCP policy is declared, a
list of `{key, message, schema}` when the rounds are fixed, and the marker
`'resolved-per-call'` when a resolver decides them.

The marker is not a convenience. A dynamic policy has no list to write down —
that is the point of it — and recording an empty list would make a tool that
resolves its questions indistinguishable from a tool that asks none. What is
fixed at declaration time is *that* it resolves, and that is what is recorded.

One function, `mcpRoundsOf`, produces this shape for both the snapshot and the
fingerprint. They answer different questions — is this change visible to review,
do these two declarations conflict — and a shape that drifted between them would
let a contract change pass one gate and fail the other.

`manifestVersion` is `3`. A committed snapshot on an older version is refused by
name, with the remedy in the message, rather than failing a schema literal with
"expected 3, received 2".

## Consequences

Every committed snapshot is regenerated once, and the first regeneration is
large: the field is added to every operation row, most of them `null`.

Declaring, removing or editing a round now moves the snapshot, which is the
whole point — and a project that previously kept its own test for the link
between a declaration and its runtime configuration can drop it.

The schema digest of a round's shape is recorded, not the schema. Widening what
a question accepts moves the digest, which is the signal review needs; the
snapshot stays a fingerprint and not a second copy of the contract.
