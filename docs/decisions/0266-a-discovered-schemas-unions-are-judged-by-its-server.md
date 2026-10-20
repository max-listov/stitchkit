---
title: "ADR 0266: A discovered schema's unions are judged by its server"
description: "A schema restored from a connection's foreign document is the remote's presentation; a local refusal that is only a union's sends the value, and the remote's refusal is the answer."
type: decision
status: accepted
created: 2026-10-20 08:13 +07:00
updated: 2026-10-20 08:13 +07:00
---

# ADR 0266 — A discovered schema's unions are judged by its server

**Invariants:** I2, I13. Follows [ADR 0205](0205-flat-tool-collisions-retain-structural-alternatives.md).

## Context

A connection restores each discovered tool's JSON Schema into Zod (`zodObjectFromJsonSchema`)
and parses the call's arguments against it before sending them, so a CLI coerces argv to the
right types and refuses a missing field without a round trip. That schema is the remote's
presentation, not its contract. ADR 0205 joins a discriminated union into one object for
models: the discriminator becomes an enum and a field every variant shares becomes an
unlabelled `anyOf` of the variants' shapes. Every accepted value still passes; which shape
goes with which discriminator value is gone by design.

Parsed locally, such an `anyOf` is a plain union, and a wrong value inside it can only be
refused with every branch listed. A consuming project's lesson tool with a 12-variant block
union answered a missing `artifactId` with `No union branch matched — branch 1 … and 6 more
branches`, while its server, holding the original schema, answered `data.artifactId`.

Putting the correlation back into the schema — `oneOf` with a `const` discriminator, or a
discriminator map — would undo the reason the join exists (weaker models drop `oneOf`), and a
map would be a vendor keyword outside the one schema profile every provider is served
([ADR 0047](0047-one-mcp-schema-validation-profile.md)).

## Decision

A schema restored from a foreign document is marked at the boundary as one whose unions the
remote judges. When the local parse of a call fails, the `invalid_union` refusals of such a
schema are set aside: if nothing else was refused, the coerced arguments are sent unchanged
and the remote's refusal is what the caller sees; if something else was, only that is
reported. A schema authored in this process keeps its full verdict, union summary included.

## Consequences

A wrong value inside a union of a discovered tool costs one round trip and is named by the
server exactly as on its own transports. A missing field, a wrong scalar or an unknown key
outside a union is still refused before anything is sent, and no longer carries union lines
beside it. A foreign server that does not validate its input sees the values its own schema
advertised as acceptable; that is its contract to keep. Proven end to end against a real
stitchkit MCP server with `flattenUnionInput` in `tests/connections-remote-union-verdict.test.ts`.
