---
title: "ADR 0205 — Flat tool collisions retain structural alternatives"
description: Object and array alternatives keep their field and item schemas while the containing discriminated union remains an object.
type: decision
status: accepted
created: 2026-09-27 19:05 +07:00
updated: 2026-09-27 19:05 +07:00
---

# ADR 0205 — Flat tool collisions retain structural alternatives

- **Status:** Accepted — amends the no-nested-union collision rule of ADRs 0033
  and 0065; preserves the presentation/runtime boundary of ADR 0050.
- **Invariants:** I3, I8.

## Context

A field shared by discriminated-union variants can be an object in one variant
and an array in another. Advertising only `type: ['object', 'array']` discards
the object vocabulary and array `items`. A provider requiring an item schema
rejects the tool before execution. Empty `items` also hides the model's contract
when two array alternatives have different element structures.

## Decision

The shared presentation join retains distinct structural alternatives in a
property-level `anyOf` whenever the provable kinds include an object or array.
Each alternative retains its items, properties, required keys, bounds and key
policy. Structurally identical alternatives are deduplicated; shared outer
descriptions and conditional-required hints belong to the joined property.

The containing discriminated union still becomes one object. Its discriminator
is an enum and only fields required by every variant remain required. Plain
scalar collisions retain their conservative type/enum widening. An unprovable
kind remains unconstrained instead of acquiring a guessed structure.

This is a union of already projected schemas, without a Cartesian expansion or
a second recursive projection pass. Every value accepted by an original branch
is still accepted by the presentation; discriminator-to-field correlations are
intentionally absent there. The original Zod schema alone owns runtime parsing.

## Consequences

Flat mode guarantees an object for a structurally identifiable discriminated
union, not the absence of every nested `anyOf`. A consumer must accept nested
structural alternatives; disabling flatten globally is unnecessary. Manifest,
MCP and Agent use the same owning implementation. No public option, runtime
validator or transport-specific schema patch is added.

Tests exercise production manifests and mounted AI SDK schemas, nested arrays,
nullable and optional fields, both object shapes and runtime rejection of a
value belonging to the wrong discriminator branch.
