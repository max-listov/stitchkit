---
title: "ADR 0027 — Transport-neutral contract execution (bring-your-own transport)"
type: decision
status: accepted
created: 2026-06-05
updated: 2026-06-05
---

# ADR 0027 — Transport-neutral contract execution (bring-your-own transport)

- **Status:** Accepted — upholds [ADR 0008](0008-thin-wrappers.md) and
  [ADR 0020](0020-raw-websocket-lane.md); keeps the core generic per
  [ADR 0002](0002-generic-core.md)
- **Date:** 2026-06-05

## Context

A contract drives the four built-in transports (HTTP, MCP, agent tools, CLI). But
some apps have a transport stitchkit does not own and should not own — a desktop
app whose UI webview talks to its own local Bun sidecar over a raw WebSocket, an
IPC channel, a queue worker. Today such a transport is written from scratch: a
hand-rolled method registry (one map entry per method, re-using the app's Zod
schemas), a client, a server, and bespoke error shapes — the very duplication
`defineContract` removes for the built-in transports. One consuming project
reported ~1000 lines of this, parallel to its stitchkit contracts, because three
things were missing: a way to *execute* a contract method off a non-built-in
transport, an idempotency hint to drive replay-on-reconnect, and retained
("sticky") events so a late subscriber catches up.

The execution core already exists internally: `executeToolMethod` slices the flat
args, validates `params`/`input`, runs the handler, validates the output, and
returns a typed `{ ok, data } | { ok: false, code, details, hint }` envelope. It
is what `mountMcp` / `mountAgent` run — transport-neutral, but not exported.

The tension is ADR 0008 ("never ship a competing WebSocket engine — wrap what you
use"). Shipping a full reliable-RPC-over-raw-WebSocket engine (framing,
handshake, reconnect, a pending-call map, replay policy) *would* be a competing
engine. ADR 0020 already drew the line for the raw-WebSocket lane: stitchkit ships
the **composition primitive**, the raw socket itself is the *app's* `Bun.serve`
WebSocket. This ADR draws the same line for RPC.

## Decision

Expose the existing execution core and the two metadata/utility pieces a
bring-your-own (BYO) transport needs — **not** a transport engine.

- **`createContractDispatcher(services, { source, … })`** (`stitchkit/tools`) —
  builds a `{ dispatch(method, args, context?) }` over one or more `implement()`
  services. `dispatch` runs a method by its contract key through the *same*
  `executeToolMethod` the MCP/agent mounts use, returning the identical result
  envelope (validation, typed error `code`, `beforeToolCall`/`afterToolCall`
  hooks, a `beforeHandle` scope gate). An unknown method is a `NOT_FOUND` result.
  The app keeps its own wire (framing, handshake, reconnect) and calls `dispatch`
  per inbound frame. Exposure is the transport's choice (which services it
  dispatches), not the contract's `expose` (which gates the built-in transports).
- **`TransportSource` is an open union** — `'http' | 'mcp' | 'agent' | 'cli' |
  (string & {})`. The four built-ins keep autocomplete; a BYO transport tags its
  own calls (`source: 'local-ws'`). `source` stays transport-only with no
  framework behaviour (ADR 0002).
- **`idempotent?: boolean` on the contract** rides through to
  `MethodDef.idempotent`. The core attaches **no** behaviour — it is a generic,
  transport-neutral property of an operation (like HTTP `PUT`/`DELETE`). A
  retrying transport reads it: replay an idempotent call after a reconnect (the
  durability guarantee), reject a non-idempotent one rather than re-send it (a
  duplicate would be a second side effect). Unset = "unknown" = treat as
  non-idempotent.
- **`createRetainedTopics()`** (`stitchkit`, browser-safe) — a transport-agnostic
  retained-last-value store for "sticky events": a late subscriber is replayed
  the last payload per topic (MQTT retained / `BehaviorSubject`).
  `createSocketIOClient` gains a `retain` option that uses it, and a BYO lane can
  use it directly.

## Alternatives considered

- **Ship a `localWsLane` reliable-RPC engine** (raw-WS framing + secret handshake
  + reconnect + replay + a generated client/server). Rejected for now: it is a
  competing engine (ADR 0008) and a large, durability-sensitive surface to keep
  stable pre-1.0. The dispatcher removes the bulk of a BYO transport's
  duplication (the registry, the error typing, the validation) while the app
  keeps the ~200 lines of its own wire. If the *wire* itself proves a recurring
  need across multiple desktop consumers, that is a future ADR — built on
  evidence, not on one case.
- **Export `executeToolMethod` raw.** Rejected: it is named for tools and takes a
  resolved `MethodDef`; the dispatcher is the contract-shaped, neutrally-named
  surface (resolve-by-key, multi-service, `NOT_FOUND`) a transport actually
  wants.
- **`replay: 'safe' | 'never'` on the contract** (the consumer's framing).
  Rejected in favour of `idempotent: boolean` — idempotency is the underlying,
  transport-neutral property; "replay on reconnect" is one policy a transport
  derives from it. Naming the property, not the policy, keeps the core generic.

## Consequences

- **Not a competing engine (upholds ADR 0008 / ADR 0020).** stitchkit ships the
  executor, the hint and the sticky helper; the transport is the app's.
- **One mental model.** A BYO transport runs a `defineContract` like every other
  surface — same validation, same error envelope, same hooks.
- **Generic core (ADR 0002).** `source` is a free tag; `idempotent` carries no
  built-in behaviour; the dispatcher imposes no domain model.
- **Cast-free.** No new `as`; `createRetainedTopics` is typed via `Partial<Events>`
  and the socket `retain` wiring widens the (any-typed) listener by plain
  assignment, as the existing client already does.
- **Additive.** New exports plus an opened `TransportSource` union and an optional
  `idempotent` field — no existing call breaks.
