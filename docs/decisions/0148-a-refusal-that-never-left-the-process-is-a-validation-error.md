---
title: A refusal that never left the process is a VALIDATION_ERROR with status 0
description: Every argument the client refuses while planning a request raises one ApiError shape at one timing, and argument validation itself stays on the server because a caller's arguments and the server's input are not the same values.
type: decision
status: active
created: 2026-09-02
updated: 2026-09-02
---

# 0148 — A refusal that never left the process is a `VALIDATION_ERROR` with status 0

## Decision

Every argument the typed client refuses while planning a request raises
`ApiError('VALIDATION_ERROR', 0, { issues })` — one shape, from the funnel every method passes
through, so both transports answer a rejected call identically and always as a rejection, never as a
synchronous throw.

`status: 0` already means *this never reached the server* (`REQUEST_ABORTED`, `REQUEST_TIMEOUT`), so
a caller separates the two worlds with no new field and no new name:

```
err.code === 'VALIDATION_ERROR' && err.status === 0    refused here, nothing was sent
err.code === 'VALIDATION_ERROR' && err.status === 400   refused by the server
```

`details.issues` carries the same `{ path, code, message }` a `400` carries, and `zodIssues` /
`ZodIssueSummary` are reachable from the browser entry, so one rendering serves both.

**And the client does not validate arguments against the contract.** That is the other half of this
decision, and the half that will be re-proposed if it is not written down.

## Why

### One shape, one timing

The client refuses at eight sites while planning a request. Those refusals used to leave in three
shapes across two timings: a plain `Error` rejected on the bare-fetch path, the same plain `Error`
thrown **synchronously** on the Ky-backed path — so `api.upload({}).catch(handler)` never reached the
handler — and a missing multipart file as `UNKNOWN_ERROR`, the code whose whole meaning is *this
client cannot tell you what happened*, on the one refusal where dispatch provably never happened,
while the client guide instructs the reader never to conclude anything from that code.

A consuming application named the cost of this as "contract-first exists to prevent N shapes of one
thing". The complaint was correct and its target was us: the framework produced the shapes.

And the divergence was worse than either behaviour would have been alone, **because the guide is
one**. A reader who learned the client on one transport and moved to the other carried a `.catch()`
with them that no longer caught — not through carelessness, but because one document promised one
behaviour while two existed. That is the argument for unifying rather than for choosing the better
half: no documentation can be true of both at once. (Named in this form by the consuming session that
carried the earlier lock defect.)

The divergence survived because the assertions that appeared to pin it could not fail. `expect(fn)
.toThrow()` in bun:test passes for a function that merely **returns** a rejected promise — measured:
`expect(() => Promise.reject(new Error('boom'))).toThrow('boom')` is green. Two tests written that
way read as pinning the synchronous throw and pinned nothing. Timing is therefore asserted by
capturing the call, and the gate additionally asserts that **the server was never contacted** —
without which every other assertion would pass on a change that refuses and sends anyway.

### Argument validation stays on the server

A caller's arguments and the server's `input` are not the same value, so a local check is not "the
server's gate, run early" — it is a second, differently-behaved gate. Four independent reasons, each
measured, none of them about version skew:

1. An argument object is the intersection of `params`, `input` and any multipart file fields, so
   `input` is one factor of it. Parsed over the whole object it strips the keys it does not own or,
   being `.strict()`, refuses them: a contract with `params: { id }` and a strict `input` refuses
   `{ id, text }` while the server accepts it. A scoped client (`stripPrefixKeys`) breaks the same way.
2. A query string and a multipart body carry **strings** while the caller holds live values, so
   `z.coerce.boolean()` called with `false` parses locally to `false` and reaches the handler as
   `true`.
3. `z.preprocess(v => JSON.parse(String(v)), Schema)` — the idiom the contracts guide documents for
   multipart — **throws** out of `safeParse` rather than failing cleanly.
4. A plain JSON body is not the safe exception: it crosses `JSON.stringify`, so `z.date()`, `z.map()`,
   `z.set()`, `z.bigint()` or `NaN` accept locally and are refused by the server. This one fails in
   the safe direction, but it passes traffic the server will reject.

It cannot be made default either: `implementRemote` pushes already-parsed, output-typed values back
through the same client, so any codec or `.transform()` field would refuse every proxied call.

## Alternatives refused

- **A `validateInput(op, args)` helper.** Refused. Not because it duplicates a name — that objection
  is weaker than it sounds — but because it cannot reproduce what the transport actually sends, per
  the four reasons above. An opt-in helper does not collapse N shapes; it adds one, and one that is
  right for POST-JSON and quietly wrong for query strings, path params, multipart and scoped clients
  is worse than none, because it is believed.
- **Refusing only "the structural" — a missing field, a wrong primitive — and leaving enum, range and
  format to the server.** Refused, and withdrawn by the consumer who proposed it: Zod offers no such
  split, so honouring it means walking the schema and re-applying a subset of the rules by hand — a
  second implementation beside `safeParse`, which moves skew from between versions to between two
  code paths inside one release.
- **A new field distinguishing a local refusal from a server one.** Unnecessary: `status: 0` already
  does it, is documented, and is asserted.

## Consequences

- Breaking for anyone matching the message text of a client-side refusal, and for a Ky-backed call
  site that relied on the synchronous throw. Both now arrive as a rejected `ApiError`.
- A caller renders one issue list for both origins of a validation failure.
- `packages/core/tests/client-parity.test.ts` fails if either transport diverges in shape or timing,
  if a refusal loses its issue paths, or if a refused call contacts the server.
