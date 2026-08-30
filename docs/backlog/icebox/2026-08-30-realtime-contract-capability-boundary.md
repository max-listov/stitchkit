---
title: Define a transport-neutral realtime contract and explicit adapter capabilities
description: Preserve the rejected universal-adapter proposal and the evidence required to reconsider it.
type: task
status: icebox
created: 2026-08-30
updated: 2026-08-30
pipeline: live-state-synchronization
order: 90
depends-on: —
defrost: Two independently maintained application-owned bindings duplicate the same validated server/client capability boundary not covered by bindRealtimeClient or the live synchronization source.
---

## Зачем

Zod event schemas should not need duplication when an application chooses a different wire
protocol. The existing contract registry is largely independent, while acknowledgement
callbacks, request handling and validated emitter targets reflect Socket.IO semantics.
A common method name alone cannot guarantee equivalent delivery or recovery.

This began as a proposal requiring architecture review before implementation. The program review
and scope exclusions remain recorded in
`../done/2026-08-30-realtime-adapters-and-live-sync-program.md`.

## Current review disposition

Frozen. A generic `RealtimeAdapter` would currently abstract one framework-owned transport and
one hypothetical transport, producing either Socket.IO-shaped leakage or a lowest-common-
denominator API. The active live-sync review instead defines only the source operations proven by
its two examples and leaves transport contracts intact.

The browser surface already contains the structural `RealtimeClientTransport` /
`bindRealtimeClient` boundary for caller-owned transports, although it remains intentionally
Socket.IO-shaped. A future proposal must demonstrate what repeated capability boundary that API
and the narrow synchronization source both fail to express.

This proposal returns only when two independently maintained application-owned bindings contain
the same validated client/server capability machinery and both existing boundaries are
demonstrably insufficient.
At that point a successor ADR may change ADR 0008/0069; those historical decisions are not edited.

## Existing foundation

`packages/core/src/realtime/contract.ts` defines directional registries, tuple schemas and
acknowledgements. `realtime/socket.ts` validates emitter targets. ADR 0069 deliberately keeps
delivery/replay/transport selection outside the contract. ADR 0008 selects Socket.IO;
ADR 0020 only permits composition of application-owned raw lanes.

## Результат

The original intake proposed retaining one Zod-first event source of truth and defining the smallest shared
adapter interface. Separate subscription/emission, connection lifecycle and optional
request/ack/recovery capabilities. Adapter-specific rooms and distributed adapters remain
explicit extensions, not required methods or silent no-ops.

The decision chooses among keeping Socket.IO-only, adding a limited native event adapter,
or broadening synchronization independently of transport. Reusing the current implementation
is preferred to introducing a parallel contract registry.

## План

- [ ] Compare the alternatives, adoption evidence, maintenance burden and compatibility cost.
- [ ] Write and index a successor ADR if the selected scope changes ADR 0008/0069; update current
      contributor guidance and vision only when that decision is accepted.
- [ ] Specify direction, schema input/output transforms, rejection ownership, cancellation,
      handler isolation and capability discovery/validation.
- [ ] Distinguish local validation, local transport acceptance, peer acknowledgement and durable
      application processing. None implies the next.
- [ ] Specify contract/schema version versus native wire version and mismatched-peer behavior.
- [ ] Keep Bun types in the Bun server adapter; shared/browser imports must stay Web-compatible.
- [ ] Preserve optional dependencies and Socket.IO engine ownership of heartbeat/reconnection.
- [ ] Define the source/wire migration policy without compatibility aliases or a second registry.

## Acceptance

- [ ] Unsupported request/ack/recovery capabilities are rejected at typing or initialization,
      never implemented as a no-op or false success.
- [ ] Existing inbound/outbound/ack validation and emit-only target semantics are preserved or
      have an explicit reviewed migration with regression evidence.
- [ ] Native-only usage does not import Socket.IO; server-only usage does not import React.
- [ ] The contract does not mandate storage, room authorization, HTTP RPC replacement or Node
      native-server support that has not actually been implemented.
- [ ] A decision and common contract are inspectable before dependent adapter work begins.
