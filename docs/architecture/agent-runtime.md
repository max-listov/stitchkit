---
title: "Agent application runtime architecture"
description: Current ownership, state transitions, linearization points and resilience boundaries of the optional server-only agent runtime.
type: architecture
status: active
created: 2026-08-22
updated: 2026-08-23
---

# Agent application runtime architecture

`stitchkit/agent-runtime` is one optional server-only execution protocol for a tool-using language
model. It is not a generic job framework. `mountAgent` remains an independent lower-level surface.

## Ownership

| Concern | Owner | Source of truth |
|---|---|---|
| Canonical message/run shapes | Stitchkit | Zod schemas in `packages/core/src/agent-runtime/schemas.ts` |
| Transition validation, revisions, idempotency and compaction replacement | Stitchkit | reducer in `store-driver.ts` |
| Atomicity and durable rows | application adapter | one `AgentRuntimeStoreDriver.transaction` over head, runs, admissions and history |
| Process-local queue, interrupt, supersede and settlement | Stitchkit | `coordinator.ts` |
| Distributed ownership | application adapter | lease plus optional monotonic `fencingToken` persisted with the run |
| Model allowlist/default | application | registry declarations and selection policy |
| Provider construction/usage normalization | provider adapter | isolated provider entrypoint |
| Prompt order/budget and whole-turn slicing | Stitchkit | `prompt.ts` |
| Domain prompt text and tools | application | typed callbacks |
| Headless resource composition and applied profile evidence | Stitchkit facade | `agent-runtime/harness` over the same runtime |
| Resource discovery and containment | Stitchkit optional leaf | explicit roots, shared contained walker and bounded lazy reads |
| Resource trust, root IDs and precedence | application/host | declared roots and provenance policy |
| Coding-tool authorization and concrete limits | application/host | `agent-runtime/coding-tools` configuration |
| Control protocol, leases and pure view projection | Stitchkit optional leaf | harness and browser-safe schemas/reducer |
| Process placement, restart, control transport/authentication and OS isolation | external supervisor | outside Stitchkit |
| External effect idempotency | application | stable run/call identity and business transaction |
| Canonical application events | Stitchkit | `events.ts` |
| Transport, replay buffer and UI | application | publisher/sink adapter |
| Official terminal host composition | generated Agent starter | OpenTUI view over canonical harness snapshots/events; no second loop |
| Operator telemetry | Stitchkit protocol plus application sink | `observability.ts` |

No state mutation has two owners. History adapters expose storage primitives; they cannot perform an
independent run transition around the reducer.

## Durable states and transitions

| From | Action and linearization point | To | Side effects allowed after |
|---|---|---|---|
| absent | `acceptInputAndAssignRun` CAS commits input, admission identity and queued run | `queued` | post-commit admission event |
| `queued` | `acquireRun` CAS verifies predecessor order and increments revision/fencing token | `running` | model step and fenced tool admission |
| `running` | `checkpointRunAssistant` CAS verifies owner, token and revision | `running` | checkpoint event |
| `running` | `requestRunInterrupt` CAS | `interrupt_requested` | process signal; never successor admission |
| acquired | execution settles and no managed callback remains owned by the loop | acquired | terminal CAS only |
| acquired | `commitRunTerminal` CAS writes final assistant and terminal reason | terminal | terminal event, lane release, successor start |
| acquired | recovery with explicit stale-owner evidence | `abandoned` | terminal projection |
| acquired | recovery with explicit replay-safe evidence | `queued` | later acquisition; no automatic effect replay |

Terminal states are `completed`, `interrupted`, `superseded`, `failed`, `cancelled`
and `abandoned`. An
`AbortSignal` is only a cooperation request and cannot advance durable state. A hung predecessor
therefore blocks its keyed lane until it settles; `close({ forceTimeoutMs })` may bound caller
waiting but does not pretend the external effect stopped.

Provider completion and durable interrupt may race on the acquired run revision. A losing terminal
CAS reloads the snapshot: an existing terminal winner is canonical, while a still-owned
`interrupt_requested` record is retried as `interrupted`; a still-owned `running` record remains
retriable when unrelated aggregate-head CAS operations move. Any ownership or fencing change fails
closed. The lane releases only after a terminal outcome is observed. A canonical winner settles
the losing ticket, but only the execution that applies the terminal mutation emits terminal
delivery and operator metrics.

## History and context

Canonical history retains provider envelopes, signed approval parts and storage-neutral file references. Projection omits
crash drafts, leading assistant records and incomplete tool chronology by explicit decision.
`selectAgentHistory` removes only whole old provider-valid turns, protects system/summary,
incomplete and configured recent turns, and reports one decision per message. If token provenance is
unavailable it does not invent a count or silently truncate.

Compaction summarizes outside the transaction, then replaces one exact contiguous range through
snapshot CAS. A configured retry reloads, reselects and re-summarizes; a stale summary is never
reapplied. Failure leaves the original history canonical.

Failed terminal evidence remains omitted by default. An explicit `AgentHistoryEvidencePolicy` may
include a marked partial failed assistant; projection, token budgeting and compaction consume the
same policy so no hidden record reserves budget or reappears unmarked through a summary.

## Models and loop

Registry preflight checks availability, provider presence and required capabilities before durable
admission when wired through `models.preflight`. Discovery is an optional versioned snapshot with
source/observation time and explicit staleness validation. The application still owns which model
is allowed and selected.

The managed loop is the only AI SDK stream switch. It disables whole-call retries, accumulates
text/reasoning/tools/sources/files/provider envelopes, uses bounded checkpoints, applies dynamic
step and named stop policy, and commits exactly one terminal state by CAS. Tool fencing runs before
the handler and again before accepting its result; stale control errors are never model-facing.

`createHeadlessAgentHarness` is a facade over this same loop, store and coordinator. It resolves a
caller-provided model per run, loads bounded typed resources, composes them through the canonical
prompt budget and records an observation-only applied profile containing the actual model
descriptor, resource provenance and direct tool names. It owns no daemon, catalog discovery,
credentials or second recovery state. Signed approval requests end one run before an effect; an
exact durable tool-role response starts a successor, and the existing fence owns execution. Its optional coding tools remain ordinary direct runtime
tools; their path root constrains file resolution but is not an OS sandbox for allowed executables.

## Delivery and observability

Durable event IDs derive from `(runId, event type, snapshotVersion)`. Transient events use
`(runId, runtimeEpoch, sequence)`. `advanceAgentRuntimeEventCursor` reports duplicates and gaps; a
gap is recovered by loading the canonical snapshot, not by assuming infinite process replay.
`createAgentRuntimeEventSink` supplies bounded failure-isolated delivery and a projection/redaction
hook. It is not a transactional outbox.

The multi-session control cursor scopes durable versions per conversation and transient sequences
per run. Control connection close releases only its observer/controller attachment; harness
shutdown is a separate host action.

Operator events use a separate schema and sink lifecycle. Terminal IDs deduplicate naturally;
missing usage/cost stays unavailable, and raw internal causes are excluded unless an operator-only
sink explicitly opts in.

## Recovery and schema evolution

The durable head contains only conversation identity and a monotonic version. Normalized run rows
own revision, state, ownership and an optional retained terminal assistant; normalized admission
receipts own the idempotency key, canonical input and assigned identities. Product history may
physically delete compacted rows. A duplicate terminal submission is reconstructed from its receipt
and run record, not from active history.

`runtime.recover()` scans indexed active states in the normalized run store. Queued work resumes only when no acquired
predecessor blocks it. Acquired work defaults to skip; requeue and abandon require explicit evidence.
Each run returns its own outcome so one corrupt record does not hide the rest of the pass.
The harness adds no replay rule: completed tool evidence reopens from the canonical store, while
requeueing an acquired run still requires the runtime's explicit replay-safe evidence. External
effects remain idempotent only when the application uses stable run/call identity at its own
transaction boundary.

Current records write `schemaVersion: 1`. Adapters migrate older rows at read time, validate the
current exported schema, and write only the current version. Unknown future versions fail closed.

## Proof surfaces

- Source regression tests cover protocol/store, loop, fencing, coordination, compaction, delivery,
  observability and hostile history.
- `runAgentStoreConformance` executes the same atomicity/race contract against memory and external
  transactional adapters, including duplicate terminal recovery after physical compaction.
- Public bounded barriers/traces from `stitchkit/testing` run from packed Bun and Node consumers.
- The official PostgreSQL/Prisma fixture proves duplicate/coalesced admission, stale checkpoint,
  terminal race, compaction conflict, constant-size heads, normalized recovery and rollback on real transactions.
