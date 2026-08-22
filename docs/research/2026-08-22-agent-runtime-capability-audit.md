---
title: "Agent runtime capability audit"
description: Evidence and ownership matrix for the optional Stitchkit agent application runtime.
type: research
status: active
created: 2026-08-22
updated: 2026-08-22
---

# Agent runtime capability audit

## Method

Three structurally different consuming runtimes were inspected at their pinned
AI SDK and provider-adapter versions. Public evidence is intentionally
anonymised: this repository records reproducible mechanisms, not consumer
identity or business context.

The sample contained a service-oriented chat runtime (shape A), a durable generation-agent runtime
(shape B) and a smaller provider/generation runtime (shape C). The pinned evidence was:

| Shape | AI SDK | OpenRouter adapter | Inspected generic-candidate LOC | Structural role |
|---|---:|---:|---:|---|
| A | `^7.0.77` | `^3.0.0` | 3,410 | session + prompt + stream + compaction |
| B | `7.0.65` | `3.0.0` | 1,819 | durable loop + context + delivery + compaction |
| C | `^7.0.37` | `^3.0.0` | 190 | provider construction + small generation path |

Counts use exact authored symbol groups, not folders. A includes its coordinator, stream processor,
prompt/result builders, compactor, context-window and provider modules; B includes its session,
loop, stream handlers, context manager, summary, model and provider modules; C includes generation
and provider adapters. Tests, generated files, domain tools, transports and product catalogs are
excluded.

The current framework slice is 4,197 authored source lines, 2,564 source/conformance test lines and
787 packed-fixture lines. One controlled pilot replaces 2,189 lines of the old agent layer with
1,554 lines of adapters/domain wiring (net −635); its focused behavioral boundary suite is 4/4.
This is deletion evidence, not a claim that every application removes the same amount.

## Evidence matrix

| Capability | Repeated evidence | Stable invariant | Variation / owner | Verdict |
|---|---|---|---|---|
| Message history | role/part mapping and incomplete tool chronology in all shapes | the provider sees a valid ordered turn history | domain parts and database rows stay application-owned | framework protocol + projection |
| Provider metadata | multiple shapes persist opaque tool/reasoning metadata | provider-required metadata must round-trip losslessly | adapters validate/version the envelope; delivery hides it | provider adapter capability |
| Durable input/run | input rows, assistant drafts and active-run identity are persisted together or guarded manually | accepted input cannot disappear before scheduling; stale writes cannot win | ORM and distributed lease remain application-owned | aggregate store contract |
| Prompt/context | ordered system/runtime sections and window arithmetic recur | every contribution consumes an explicit budget | domain content and model selection stay application-owned | framework composition mechanics |
| Compaction | threshold, recent-turn protection and structured summary recur | replace one immutable provider-valid range by CAS | summary schema/content is configurable | framework engine + callback |
| Model provider | model factory, capability/context facts and usage extraction recur | construction and normalized provenance are provider concerns | allowlist/default/deactivation policy stays in product | registry + isolated adapter |
| Stream loop | every shape switches over AI SDK stream parts | SDK events become stable engine records and terminal outcomes | stop policy is configurable | framework engine |
| Managed tools | signal/lifecycle integration and late-result checks recur | fence before an effect and before accepting its result | external-effect idempotency stays in application | framework lifecycle composition |
| Session coordination | keyed maps, interrupt, queue/debounce and drain recur | abort is not settlement; successor follows terminal CAS | distributed ownership is an adapter boundary | process-local framework engine |
| Delivery | transient deltas and terminal events are transported differently | transient, checkpoint and canonical events have distinct guarantees | Socket.IO, Telegram, HTTP and UI stay application-owned | neutral events + projection |
| Observability | usage, cost, TTFT and terminal reasons recur | provenance and terminal identity are explicit | sink and retention stay application-owned | framework event + shared sink lifecycle |
| Race proof | existing tests cover only fragments and often rely on timing | partial order must be controlled with barriers | live provider is an optional contract probe | internal conformance harness |

## Traceable symbol evidence

| Capability | Shape A evidence | Shape B evidence | Shape C / falsifier |
|---|---|---|---|
| Coordination | keyed session run/abort/timeout methods | queued successor/session state | absent: must remain optional |
| Stream loop | central stream processor and result builder | run loop and stream event handlers | one-shot generation only; no forced loop abstraction |
| Prompt/context | prompt builder + context-window arithmetic | context manager | absent: domain callback remains valid |
| Compaction | compactor + threshold config | summary service | absent: `none` lifecycle required |
| Models/providers | provider factory and catalog boundary | provider/model modules | independent provider factory confirms adapter repetition |
| Delivery | stable application stream projection | stream event handlers | absent: transport remains consumer-owned |
| Durable store | manual message/run persistence around session | durable agent records and recovery | absent: memory adapter states its limitation |

The falsification rule was applied per row: a capability was not made mandatory merely because it
existed in A or B. C is the negative sample that keeps compaction, coordination and delivery
optional. AI SDK's supported stream/model contracts are the external second source where only one
consumer shape exercised a part.

## Rejected ownership

- No framework ORM schema, worker fleet, generic job queue or distributed lock.
- No product model catalog, business aliases or deactivation rationale.
- No domain prompt text, domain tools, attachment storage or UI event format.
- No automatic retry of a loop after a side-effectful tool without explicit
  replay/idempotency evidence.
- No durable approval/resume state machine in the first version.

## Implementation consequence

The first public slice must be vertical. Protocol schemas without aggregate
store operations, a coordinator without managed-tool fencing, or streaming
events without durable snapshot semantics would preserve the same correctness
gaps in a new package. Those modules remain internal until the packed Bun and
Node fixtures exercise the coherent path.

The vertical slice is now public and the ownership verdicts remain current. Follow-up evidence
refined three details: the framework reducer owns transitions behind storage primitives, model
snapshots have explicit freshness, and delivery exposes stable IDs plus gap detection instead of
promising process replay.
