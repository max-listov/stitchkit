---
title: "ADR 0334: The executor wire is strict, and version skew has one rule"
description: "Amends ADR 0316: every object of the executor ↔ server contract refuses a key it does not declare, so a release that adds a wire key names it with its direction; the server is upgraded first, and a server writes an added reply key only to an executor whose hello declares the capability for it. A contract test parses today's shape with the schemas of earlier releases."
type: decision
status: accepted
amends: ["0316"]
created: 2026-11-27
updated: 2026-11-27
---

# ADR 0334: The executor wire is strict, and version skew has one rule

**Relations:** Amends [ADR 0316](0316-agent-executor-drivers-and-contract.md) — its contract clause said what the operations are and nothing about two releases meeting on them. Serves **I3**, **I8**, **I9** and **I13**.

## Context

The executor and the server are two processes an application deploys separately, often on
different machines, so for a while they run different releases of this package. Every object of
their contract is a `z.strictObject`: a key the reader does not declare fails the whole message.
`protocol` is the literal `1` on both sides and negotiates nothing.

Release 0.130.0 added keys in both directions — `capabilities` on every engine a `hello`
announces, the `status` delta, `threadDisposition`, five usage figures, and `scope`,
`updatedInput` and `interrupt` on an interaction reply — and 0.131.0 added `plan` and `scope` to
plan limits. The migration of 0.130.0 named the `status` delta alone. A driver writes
`capabilities` on every `info()`, so an executor upgraded before its server had its handshake
refused, and the release notes did not say why.

Loosening the objects was considered and rejected: a strict profile and a strict report are what
keep a path, a token or a misspelt field from travelling unnoticed (ADR 0316, decision 2), and a
reader that drops unknown keys would silently drop a `threadDisposition: 'broken'` it was meant to
act on.

## Decision

1. **The wire stays strict, and an added key is a wire change.** A release that adds a key, a
   union member or an enum value to a message of the contract names each one, with the direction
   it travels and the release that added it, in the version-skew table of the API reference and
   in its migration — also when the TypeScript change is additive. Removing or renaming a key, or
   narrowing a value, needs a new `protocol` number.
2. **The reader is at least as new as the writer.** For `hello`, `claim`, `renew`, `release` and
   `report` the reader is the server: upgrade the server before any executor. An older executor
   keeps working against a newer server, because every added key is optional and it writes none.
3. **The server writes an added key only to an executor that declared it can read it.** The reply
   keys follow the capabilities of the engine in that executor's `hello`: `scope: 'session'` needs
   `sessionApproval`, `updatedInput` needs `updatedToolInput`, `interrupt` needs `interruptOnDeny`.
   An engine announced without `capabilities` comes from an executor older than those keys and is
   sent none of them.
4. **The rule is held by a test, not by memory.** `packages/core/tests/fixtures/executor-wire/`
   keeps the JSON Schema of every message as earlier releases declared it
   (`packages/core/scripts/executor-wire-snapshot.ts` writes one from a release's sources). A
   contract test restores those schemas, lists what today's schemas declare beyond each, proves on
   a real message that the older schema refuses every listed addition, and fails when the list in
   the API reference differs. A new key therefore cannot ship unnamed.

## Consequences

- An operator reads one table to learn which side to upgrade first and what an older peer refuses.
- A server built on the contract owns the per-executor decision of decision 3; this package holds
  no connection state for it and offers the capabilities as the fact to decide on.
- Adding a wire key costs a row in the table and a line in the test's expectations.
