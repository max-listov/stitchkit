---
title: Generic application primitives
description: Declare lifecycle, access, exact values, audit, delivery and exports without moving application infrastructure into Stitchkit.
type: guide
status: active
created: 2026-09-01
updated: 2026-10-01 21:03 +07:00
---

# Generic application primitives

`stitchkit/primitives` is an optional browser-safe leaf. It declares values and policies; it does
not own a database, transaction, scheduler, durable queue, transport or document generator.

## Lifecycle and access

```ts
import { defineLifecycle, defineOwnerScope, definePermissionMatrix } from 'stitchkit/primitives';
import { z } from 'zod';

const lifecycle = defineLifecycle({
  name: 'document',
  states: ['draft', 'published'],
  roles: ['author'],
  transitions: {
    publish: {
      from: 'draft',
      to: 'published',
      by: ['author'],
      payload: z.object({ note: z.string() }),
    },
  },
});

const permissions = definePermissionMatrix({
  roles: ['reader', 'author'],
  operations: ['read', 'publish'],
  grants: {
    reader: { read: true, publish: false },
    author: { read: true, publish: true },
  },
});
```

Persist `transition(...).event` in the same application transaction as the next state. A state is
an immutable branded value; `transition()` produces the next one. `availableTransitions()` and
`transition()` read the same declaration.

`defineOwnerScope` resolves one owner from authenticated identity. Reading across owners is a
separate `acrossAllOwners(identity)` call and permission. Pass the resulting branded `OwnerScope`
to the data adapter. This proves the scope was explicit; Stitchkit cannot prove what SQL an
arbitrary adapter emits. `scanOwnerFilterRisks` maps existing caller-named manual filters before a
migration.

## Exact values and deadlines

`defineMoney(currency)` stores integer minor units as a JSON string. Arithmetic keeps the currency
literal in the type; division and rational shares return an explicit remainder. It does not own
exchange rates.

`defineUnitSystem` stores exact canonical decimal strings. Every conversion is an application
rational with an id. A converted `QuantityProjection` is `derived` and carries both its source and
conversion id; a form/database value can be marked `recorded`. Whether a derived projection is
persisted or recomputed is an application decision.

`defineDeadlinePolicy` requires an explicit `now`, IANA timezone and elapsed/calendar-day boundary.
It returns the due instant, signed remaining days, overdue days and caller-owned category key.
`queryBoundary(now)` returns instants suitable for a data-adapter predicate; reminders and
escalations are not included.

## Audit and delivery

Put an audit decision beside each operation:

```ts
meta: { audit: audit.record(z.object({ changed: z.array(z.string()) })) }
// or
meta: { audit: audit.omit('read-only projection') }
```

`assertAuditDeclared(contract)` refuses silence. `createAuditRecord()` validates the change and
returns a `DomainEvent`; the same id/value can feed both the journal and delivery.

`defineDomainEventDelivery().plan(event)` is pure. Save that event and its destinations in the
application's transaction. After commit, call `dispatch(event.id)`: the dispatcher accepts only an
id and obtains actual work from `DomainEventOutbox.claim`. A transport returns `delivered`,
`retryable`, `terminal` or `unknown`; the dispatcher calls the matching outbox transition. Only
`retry` may schedule another claim, while `unknown` is held for inspection instead of guessed into
a retry. The application owns retention and scheduling. There is deliberately no scheduler or
distributed lease.

## Exports

`defineExportOperation` supplies one input and one result schema to an ordinary contract endpoint.
A small result can be `ready` with a `ManagedFileRef`; a larger result can be `pending` with the id
of the application's existing async operation. The input, scope, metadata and tool identity do not
change. The application creates bytes and owns operation persistence; the managed-file boundary
streams them.

## Canonical JSON

```ts
import { canonicalJson } from 'stitchkit/primitives'

const bytes = canonicalJson({ '2': 'two', '10': 'ten', optional: undefined, nested: [1, null] }, {
  maxDepth: 20, maxNodes: 10_000, maxBytes: 64 * 1024,
})
// {"10":"ten","2":"two","nested":[1,null]}
// Native crypto or browser WebCrypto hashes these same UTF-8 bytes.
```

`canonicalJson` is the one serializer behind the digests: object keys sort by UTF-16 code unit,
integer-like keys included; array order is kept; object members that are `undefined` are omitted.
It refuses, before serializing, a top-level or array `undefined`, sparse arrays, functions, symbols,
BigInt, non-finite numbers, negative zero, cycles, user prototypes, accessors and non-enumerable or
symbol members. Validate your own schema first; the canonical boundary does not replace it.

Defaults: depth 100 (the maximum), nodes 100 000, UTF-8 bytes 1 MiB. Invalid options throw a Zod
validation error. A refused value throws `CanonicalJsonError`, a `TypeError` whose `reason` is a
`CanonicalJsonRefusal`; branch on the reason, never on the message:

| `reason` | Meaning |
|---|---|
| `depth` | The value is nested deeper than `maxDepth`. |
| `nodes` | The value has more nodes than `maxNodes`. |
| `bytes` | The output is longer than `maxBytes` in UTF-8. |
| `cycle` | The value contains a cycle. |
| `negative-zero` | The value contains `-0`, which JSON cannot carry. |
| `not-json` | The value is not bounded plain JSON: sparse arrays, non-finite numbers, non-plain objects, accessors. |

`depth`, `nodes` and `bytes` are the caller's limits being exceeded; the other three say the value is
not JSON data at all.

```ts
import { CanonicalJsonError, canonicalJson } from 'stitchkit/primitives'

try {
  canonicalJson(payload, { maxBytes: 4096 })
} catch (error) {
  if (error instanceof CanonicalJsonError && error.reason === 'bytes') {
    // too large: reject the request
  } else throw error
}
```

The leaf is browser-safe: no Node, Bun or crypto, no `agent-runtime/testing`, no optional peers. Native
and browser code run the same algorithm; hashing stays a platform adapter. A consumer that needs the
same bytes moves only the serializer recursion and keeps its own proof schemas and verification
boundary.
