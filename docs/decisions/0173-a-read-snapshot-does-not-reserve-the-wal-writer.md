---
title: "ADR 0173: A read snapshot does not reserve the WAL writer"
description: "Agent-runtime reads declare read access on the existing transaction boundary; SQLite uses a deferred snapshot while mutations reserve the writer slot before their CAS read."
type: decision
status: accepted
created: 2026-09-07
updated: 2026-09-07
---

# ADR 0173 — A read snapshot does not reserve the WAL writer

## Context

`AgentRuntimeStoreDriver.transaction` originally carried no access intent. The
SQLite leaf therefore used `BEGIN IMMEDIATE` for every operation. That is the
correct boundary for a mutation that reads state before its compare-and-swap:
it reserves the writer slot before the read and cannot fail later while trying
to upgrade a stale WAL snapshot. It is the wrong boundary for `loadSnapshot`,
`loadRun` and `listActiveRuns`: a reader requested the only writer slot and
failed with `SQLITE_BUSY` even though WAL still exposed a coherent committed
snapshot.

A second `readTransaction` driver method would give one operation two names and
make every existing adapter choose a new implementation. Replacing
`BEGIN IMMEDIATE` globally with `BEGIN` would move contention into a mutation
after its reads, where the outcome is harder to classify safely.

## Decision

The existing driver method accepts an additive access hint:

```ts
transaction(work, { access: 'read' })
```

Absent options mean write access, preserving the contract and behavior of
existing one-argument adapters. The aggregate store declares read access for
`loadSnapshot`, `loadRun` and `listActiveRuns`; mutations and purge retain the
write default.

The SQLite leaf runs both modes through one serialized queue and close barrier.
Read access uses `BEGIN`; write access uses `BEGIN IMMEDIATE`. Both commit on
success and roll back on failure. Recovery and conversation readers use the
same read runner, so a multi-query catalog page also observes one WAL snapshot.
The hint declares transaction intent; it is not a security boundary and cannot
prevent a custom adapter from writing inside a read callback.

## Consequences

- An external WAL writer may stay active while agent snapshots and bounded run
  views read the last committed state.
- A mutation still fails promptly when another writer owns the slot. The store
  never retries an operation with an uncertain effect.
- Existing custom drivers remain source compatible and keep their conservative
  transaction semantics until they choose to honor the access hint.
- The same FIFO owns reads and writes on one synchronous connection, preventing
  interleaved transaction statements and ensuring `close()` drains accepted
  reads before closing the connection.
