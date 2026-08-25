---
title: "ADR 0106: A refused realtime frame answers its sender"
description: "A frame that fails the receiver's schema used to be dropped where it landed, so a version skew looked like a network fault; it now answers on the acknowledgement channel, and protocol identity is named as a handshake concern."
type: decision
status: accepted
created: 2026-08-25
updated: 2026-08-25
---

# ADR 0106 — A refused realtime frame answers its sender

## Context

`docs/guide/realtime.md` documents a convention for distributed producer/consumer
pairs: put a literal generation first in the first payload object, and Zod —
which validates object fields in declaration order — identifies an incompatible
peer before the rest of its payload is interpreted. The guide closed with an
honest boundary: *"this stays an application convention, not a core API: only
the application knows which field denotes protocol compatibility."*

A consumer running a distributed pair followed it through three incompatible
envelope changes and then abandoned it. Two observations drove that.

**The refusal was invisible to the sender.** A frame that failed validation was
dropped where it landed: the receiver reported `onRejected`, and the sender
learned nothing at all. It waited out its deadline and reported a timeout. So a
version skew presented as *healthy machines, unexplained timeouts* — symmetrically,
in both directions, on every plane at once, which reads as a network fault. The
practical consequence is worse than the diagnosis: **there is no deployment
order in which two generations coexist**, so the `v` field was paying a cost on
every single frame to produce information nobody could act on.

**Detecting it was brittle.** The guide's own recipe for telling "wrong
generation" from "malformed payload" was to inspect the internals of the
`ZodError`:

```ts
first?.code === 'invalid_value'
  && first.path.length === 2
  && first.path[0] === 0
  && first.path[1] === 'v'
```

Three conditions — about the shape of `ZodError`, about the position of a field
in a tuple, about `v` being declared first — for a fact that is binary. Two of
them were about Zod rather than about the protocol.

The consumer's proposal was to move identity comparison into the handshake. But
their own report noted the third option, which is the one that treats a cause
rather than a symptom: **make the refusal visible to the sender**, and much of
the argument against the convention disappears.

## Decision

**A refused frame answers its sender, and protocol identity is named as a
handshake concern rather than given an API.**

- When an inbound frame fails the receiver's `args` schema **and the event
  carries an acknowledgement**, the receiver answers that acknowledgement with a
  reserved envelope (`@stitchkit/realtime-rejected`) instead of dropping the
  frame. The sender's `request()` rejects with `RealtimeRequestRejectedError`
  immediately — carrying `reason`, the peer's message, and the refused fields as
  already-flattened `RealtimeRejectionIssue[]` (`path: '0.v'`). Both ends see
  the refusal; neither waits for a deadline.
- The envelope is recognised **before** the application's `ack` schema is
  applied. Parsing it as an acknowledgement would report "the peer answered with
  something invalid", which is true of the bytes and false about what happened.
- The envelope's contents are **validated on arrival**, like any other frame.
  That it describes a validation failure does not exempt it from being
  validated, and the issue list is capped: a refusal is a signal, not a report.
- The back-channel is **whatever is on the wire**, not whatever this side's
  contract knows about. Reading the callback through the receiver's own
  `definition.ack` looked equivalent and was not: in a sender-first rollout —
  the sender's contract has gained an acknowledgement, the receiver's copy has
  not — the callback is physically present, the frame is refused on arity, and
  the refusal had nowhere to go. That is an ordinary contract evolution, and it
  produced the exact timeout this decision exists to remove.
- **The reason is a string on the wire, not a closed union.** A closed union is
  a mechanism that cannot version itself forward: a peer on a later release
  refusing for a reason this one has never heard of would fail recognition, fall
  through to the application's acknowledgement schema, and surface as "the peer
  answered with something invalid" — the very mischaracterisation the ordering
  above exists to prevent.
- **The issue list is capped where the envelope is built**, not only where it is
  read. The reader's cap protects this process from a large refusal; it does
  nothing about sending one, and the number of issues is chosen by whoever sent
  the bad frame — fifty malformed array entries produced fifty issues on the
  wire before this was fixed.
- Two limits remain, documented rather than papered over. A **fire-and-forget**
  event has no back-channel, so its refusal stays local — no convention in the
  payload can change that. An **event the receiver's contract does not contain**
  has no listener, so there is nothing on that side to answer with.
- On `emit(event, …, callback)` a refusal is reported through `onRejected` and
  the application's callback is **not** invoked — the same shape the pre-existing
  invalid-acknowledgement branch has. `request()` is the contract-aware path and
  the one that rejects with a typed error; an application that hangs its own
  deadline on a bare `emit` callback still sees that deadline expire. Stated
  here because the headline of this decision is only half true on that path.
- **Protocol identity is not a core API.** The typed handshake (`handshake:
  { schema, verify }` on the server, `auth` on the client) already is the place
  where a comparison happens before any frame is interpreted, and a rejection
  there reaches `onConnectError` with `terminal: true` — distinguishable in a
  log from a bad token. What was missing was the name and the written intent, so
  the guide now names it. What the identity *is* — a build version, a contract
  hash, a protocol generation — stays the application's decision (→ ADR 0002).

## Consequences

- A version skew on an acknowledged event is diagnosable at once, from either
  end, without inspecting anyone's error internals. `packages/core/tests/realtime-rejection-visibility.test.ts`
  runs two peers whose contracts differ by one generation and asserts the
  refusal arrives well inside a deadline it would otherwise have consumed.
- The generation convention keeps its place in the guide, but its documented
  detection recipe is now one comparison against a dotted path
  (`packages/core/tests/realtime-protocol-generation.test.ts` pins it).
- **Additive in the exported surface, breaking on the wire — released as a
  minor.** Nothing is removed or renamed, and an application that never sees a
  refused frame observes no change. What changes is what two peers on different
  versions do to each other, and one case of that is silent: an older peer whose
  acknowledgement schema validates nothing (`z.unknown()`, a loose object) reads
  a refusal as a value where it previously read a timeout. "Never break
  silently" is the rule the minor exists to serve, and the caret is the only
  mechanism that makes upgrading one half of a distributed pair a decision
  rather than an accident — so this ships under `### ⚠️ Breaking changes` with a
  migration section, not as a patch. The alternative was cheaper to write and
  more expensive to be wrong about: calling it additive costs a consumer a
  silent misread mid-rollout, calling it breaking costs an upgrade nobody
  strictly needed, and this repository already accepts the second.
- A reserved key travels on the application's own acknowledgement channel. It is
  namespaced (`@stitchkit/realtime-rejected`) so an application acknowledgement
  cannot collide with it by accident, and the ambiguity is documented.
- **A callback that never used to fire now fires.** The receiver invokes the
  peer's raw acknowledgement callback for a refused frame — including when the
  peer is a plain Socket.IO client or anything else that is not stitchkit. For
  such a sender that callback was previously guaranteed never to run on a
  refused frame, and now it runs, carrying a value its own contract does not
  describe. That is the cost of the back-channel being the one that already
  exists; the alternative was inventing a second one.
- **Against a peer that predates this**, the envelope is parsed with that peer's
  own `ack` schema. For a contract-first acknowledgement — a `z.object` — it
  fails, so the older peer raises `RealtimeRequestInvalidAcknowledgementError`
  at once instead of waiting out its deadline: a different error, but still an
  error, and still immediate. The one pairing where this is a step sideways is
  an older peer whose acknowledgement schema validates nothing (`z.unknown()`, a
  loose object): it reads the refusal as a value where it previously read a
  timeout. That needs both halves — an old peer *and* a schema that checks
  nothing, which is the opposite of what a contract-first acknowledgement is
  for — and it is named here rather than left to be discovered.
  `packages/core/tests/realtime-rejection-visibility.test.ts` pins both halves.

## Alternatives considered

- **A framework-owned identity comparison at the handshake.** Rejected: the
  framework would have to decide what identity means, which ADR 0002 keeps out
  of the core, and the consumer's own report puts the work at about twenty lines
  on top of the handshake that already exists. Naming the place was the missing
  half, not building the comparison.
- **Drop the generation convention from the guide.** Rejected: it is correct for
  an acknowledged plane, and with the refusal now visible its main cost — a
  check whose answer could not reach the only party able to act on it — is gone.
- **Answer every refusal, including fire-and-forget.** Not possible without
  inventing a second back-channel, which would be a competing protocol on top of
  Socket.IO. The boundary is documented instead.
