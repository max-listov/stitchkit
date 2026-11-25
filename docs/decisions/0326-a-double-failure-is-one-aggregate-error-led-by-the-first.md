---
title: "ADR 0326: A double failure is one AggregateError led by the first failure"
description: "When an operation fails and the cleanup it owes fails too, the rejection is one AggregateError whose errors list the first failure, then the cleanup's, and whose cause is the first failure; neither failure is dropped, and the cleanup's never stands in for the first."
type: decision
status: accepted
created: 2026-11-25
updated: 2026-11-25
---

# ADR 0326 — A double failure is one AggregateError led by the first failure

Serves **I13**. Generalises the rule [ADR 0107](./0107-a-rollback-spends-a-declared-budget.md)
set for one path (a failed startup whose rollback fails too) to every operation that owes a cleanup.
Amends the failure class of stable entrypoints `stitchkit` (`createSessionCredentials().login()`) and
`stitchkit/agent-runtime/sqlite/bun` / `stitchkit/agent-runtime/sqlite/node` (a transaction or schema
initialization whose `ROLLBACK` fails), both stable
([ADR 0198](./0198-stable-is-earned-and-kept-on-a-budget.md)).

## Context

An operation that fails often owes a cleanup: a transaction its `ROLLBACK`, a login the clear of the
session it half-wrote, a spawned child its stop. When the cleanup failed as well, the library answered
in three ways:

- the cleanup's error replaced the first (a SQLite `ROLLBACK` failure hid the error that ended the
  transaction);
- the first error was thrown and the cleanup's was lost (a storage write whose clear failed too);
- one path already threw an `AggregateError`, without saying which error came first.

A caller could not find the failure that mattered, and an operator reading the log saw the symptom of
the cleanup instead of its cause.

## Decision

1. **One rejection.** An operation whose own failure is followed by a failure of the cleanup it owes
   rejects with one `AggregateError`.
2. **The first failure leads.** `errors[0]` is the operation's failure and the cleanup's failures
   follow in the order they happened; `cause` is the operation's failure.
3. **Nothing stands in.** A cleanup's error is never thrown in place of the first, and neither is
   dropped. A cleanup that succeeds leaves the first failure thrown as it is, with its own class.

## Consequences

- Code that branched on the class of the first failure reads it from `cause` when the rejection is an
  `AggregateError`:
  [`double-failure-aggregate-error`](../guide/upgrading.md#double-failure-aggregate-error).
- A new path that owes a cleanup follows the same shape; its test asserts `errors[0]` and `cause`.
