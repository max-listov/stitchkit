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

`canonicalJson` использует единый serializer исторических digest: object keys в UTF-16 code-unit
order, включая integer-like keys; array order сохраняется. Optional object members с undefined
опускаются. Top-level/array undefined, sparse arrays, functions/symbols/BigInt, non-finite numbers,
negative zero, cycles, user prototypes, accessors, non-enumerable/symbol members отказаны до
serialization. Приложение валидирует свою schema первым; canonical boundary не заменяет её.

Defaults: depth 100 (maximum 100), nodes 100 000, UTF-8 bytes 1 MiB. Превышение или не-JSON data —
TypeError; неверные options — Zod validation error. Это browser-safe leaf без Node/Bun/crypto,
agent-runtime/testing или optional peers. Native и browser используют один algorithm; hashing
остаётся platform adapter. Переносите только serializer recursion, сохраняя proof schemas и
verification boundary. Существующие внутренние historical normalization/digest fixtures не меняются;
новый public boundary сознательно отказывает неоднозначным values вместо фиктивной совместимости.
