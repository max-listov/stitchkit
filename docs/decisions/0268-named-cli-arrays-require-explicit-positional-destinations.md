---
title: "ADR 0268: Named CLI arrays require explicit positional destinations"
description: "Named array options cannot coexist with automatic positional inference; an explicit policy owns positional destinations and only its trailing array is variadic."
status: accepted
created: 2026-10-24 18:44 +07:00
updated: 2026-10-24 18:44 +07:00
type: decision
---

# ADR 0268 — Named CLI arrays require explicit positional destinations

**Invariants:** I2, I3, I8, I9, I12, I14.

## Context

An array option consumes one value per occurrence. With automatic schema-order
positionals, `--references alpha.md beta.md gamma.md` can call a handler with
`references: ['alpha.md']` while assigning the two remaining words to unrelated
optional fields. All tokens were consumed and schema validation succeeded, but
the operation the caller asked for was not the operation performed.

Greedily collecting words after an array option merely reverses the guess: a
scalar positional could silently become an array element. Token order cannot
supply a missing field destination.

## Decision

The common CLI argv parser refuses a named array option together with any bare
positional when there is no explicit `positionals` policy. The refusal precedes
field assignment and execution. It uses the canonical schema field resolver,
including short aliases, dotted leaves and wrapped array schemas. Whole JSON
array assignments obey the same rule; `--` ends option recognition without
inventing positional destinations.

Callers repeat named options or assign one whole JSON array and name scalar
fields too. An application may declare exact scalar positional destinations or
one trailing variadic positional array. Supplying both a flag and positional
elements for that trailing array remains an error. An empty policy disables
positionals. Help labels one option value and describes repetition and JSON;
only an explicitly declared positional tail promises a variadic list.

This is an intentional breaking change to the stable CLI surface, with a
mechanical migration. Native and managed commands share this one parser;
already parsed in-process invocations do not reinterpret argv. A partial
dynamic catalogue requires no policy for an absent command to obtain the guard,
and unknown policy targets retain their startup refusal.

## Consequences

Implicit scalar positionals beside a named array must be named or declared,
even when the caller intended the successful old assignment. The grammar does
not depend on argument order or guesses about adjacent words. Public-path
regressions cover refusal before handler and stdin, exact accepted payloads,
partial catalogues, credential-free native commands and help precedence.
