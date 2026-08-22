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

The sample contained a plugin/infra runtime, a service-oriented chat runtime
and a smaller generation-agent runtime. Selected generic-candidate source was
roughly ten thousand lines before tests. Whole-folder LOC is not treated as
removable: domain prompts, tools, persistence mappings and transports stay in
the applications.

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
