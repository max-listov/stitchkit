---
title: "ADR 0175: The event ledger is the agent runtime source of truth"
description: "One append-only conversation ledger owns replayable facts; normalized tables and versioned projections remain bounded operational views."
type: decision
status: accepted
created: 2026-09-08
updated: 2026-09-10
---

# ADR 0175 — The event ledger is the agent runtime source of truth

## Context

The normalized runtime store made admission, fencing, recovery and bounded run
lookups efficient, but it could not reconstruct every fact that reached a model.
State injected between steps, retry decisions, child relationships, deferred
input and spilled tool output otherwise needed application-owned side logs. A
second history immediately disagrees with compaction and recovery.

The existing `AgentRuntimeEvent` is a delivery envelope. Its cursor and retry
rules serve reconnecting observers; using it as persistence would couple the
source of truth to a transport projection.

## Decision

Each conversation owns one append-only `AgentStoreEventEnvelope` sequence.
`seq` is monotonic inside that conversation, `eventId` is globally unique, and
the envelope carries a schema version, occurrence time, kind and JSON payload.
Unknown kinds or versions refuse replay unless the whole envelope explicitly
declares `ignorable: true`. Skipping is therefore a property of the producer's
event, never a guess made by an older reader.

Every normalized runtime transition appends its ledger event in the same store
transaction. Every exact provider request is recorded before invocation,
including projected messages and durable state. Declared non-transition facts
use `appendEvent`; no model-visible history may bypass this boundary.

The existing head, runs, admissions and active messages stay as operational
projections. Additional projections declare a name, version, schema, initial
state and deterministic fold. Their checkpoint is `uptoSeq`. A projection may
honestly lag the ledger and report that checkpoint; it may never claim a
sequence the ledger does not contain. Changing its version causes a full fold
from sequence one.

SQLite schema version 2 adds the event ledger, projection checkpoints, spill
objects, schedules, child links and an FTS5 index. Migration from version 1 is
one transaction. Each existing conversation receives one `runtime/baseline`
event containing the normalized state that existed at migration time; fresh
transitions then continue at sequence two. Unknown, partial and unavailable
FTS5 schemas fail explicitly rather than silently dropping a capability.

Conversation archives use canonical JSON with stable object-key order. Import
requires an empty target event log, preserves event identities and sequence,
and must export to the same bytes. Spill payloads remain separate binary
objects referenced from the ledger; retrieval rechecks the authorization of
the operation that created the spill.

State slots, child graphs, schedules, retry boundaries and sandbox probes are
ledger facts. Timer placement, child execution and sandbox implementation are
host capabilities injected into the runtime. Cross-conversation FTS results are
default-denied and require an explicit authorization callback.

## Consequences

- Recovery, audit, export and projections share one reconstructable history.
- Operational reads stay bounded and do not scan the ledger.
- Applications implementing `AgentRuntimeStore` directly add event append,
  bounded read, canonical export and import methods.
- SQLite consumers migrate on open from schema version 1 to 2 and must ship
  SQLite with FTS5 enabled.
- The ledger adds one append per successful runtime mutation and one exact
  request record per provider call.

This ADR extends ADR 0174: `lastOperation` remains the current operation
projection, while the ledger is its append-only history.

## Amendments (2026-09-08, review of the first implementation)

- A migrated conversation is one `runtime/baseline` event at `seq 1`, dated at
  migration time with `asOf` in the payload; event-level addressing of its
  pre-migration history is not available and is not claimed.
- Rows kept beside the ledger by the SQLite companions are written in the
  store's own transaction through the handle's `transaction`; a bare write on
  the shared connection could be rolled back by a conflicting store operation
  while its event was still appended.
- A conversation export is one read transaction over events, companions and
  the snapshot.
- Each retried attempt is a separate `provider/request` under the same `stepNumber`. Each completed
  attempt also appends one `provider/response` with the same run, attempt and step identity plus
  `response: { id, provider? }`. The response ID is assigned by the provider; the optional provider
  is whatever the model's adapter resolves from its own metadata, so the neutral ledger carries no
  gateway's key. Operator `step-finished.response` carries the same
  object, while `run-terminal` deliberately does not copy the last step identity.
- The request record is content-addressed. Reproducing a request body from
  the normalized history is not possible in general — the SDK attaches
  provider metadata to text parts, an application `prepareStep` may add
  messages, file resolution happens at projection time — so the ledger records
  what was sent, once per distinct body (`provider/message`), and a request
  names its bodies by hash. Deduplication across runs is seeded from one paged
  read of the conversation's `provider/message` events at run start, the same
  order of work as reading the history for the prompt. A checkpoint transition
  records the draft's hash and size rather than the draft.
- Children belong to the conversation, not to the run that spawned them. The
  parent run's terminal decides their fate as follows:

  | parent terminal | children |
  | --- | --- |
  | `interrupted`, `cancelled`, `timeout`, `shutdown` | stopped (or `lost` when unreachable) — an explicit stop of the conversation's work |
  | `success`, `policy_stop`, `provider_stop` | left running — the conversation continues and may wait for them |
  | `superseded`, `absorbed` | left running — the successor run of the same conversation owns them now |
  | `provider_failure`, `runtime_failure`, `storage_conflict`, `output_rejected`, `context_overflow` | left running — a retry may follow; their own budgets bound them |

  A purged parent takes no more events; a child settling afterwards records
  its state on its own conversation, or on the row alone if that is purged too.
