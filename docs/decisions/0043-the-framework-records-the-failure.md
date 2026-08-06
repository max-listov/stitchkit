---
title: "ADR 0043 — The framework records the failure; the project overrides it"
type: decision
status: accepted
created: 2026-08-06
updated: 2026-08-06
---

# ADR 0043 — The framework records the failure; the project overrides it

- **Status:** Accepted — applies [ADR 0042](0042-the-audit-row-may-name-the-cause.md)'s
  rule to the HTTP path; extends [ADR 0012](0012-observability-module.md)
- **Date:** 2026-08-06

## Context

ADR 0042 taught the **tool** row to name the cause of a failure. Checking what
that left behind found the perch had simply moved rather than gone:
`create.ts` called `setRequestEndpoint` and never `setRequestError`, so the HTTP
row's error fields stayed empty unless the project wrote an `onError` hook *and*
remembered to record inside it.

A project that wired `createAuditHook` and nothing else was therefore getting
richer records from its MCP tools than from its HTTP API — the reverse of the
asymmetry ADR 0042 set out to remove, and created by that fix.

A second, quieter hole sat in the same function. `respondError` has two branches:
a custom `hooks.onError` returning its own `Response`, and the framework default.
A project that customises the envelope and forgets `setRequestError` recorded an
empty error on **every** audited failure, with nothing to indicate it.

## Decision

`respondError` records the failure onto the request context itself. It is the one
place both branches pass through, and it already holds the raw `err` on both, so
this is one insertion rather than a restructure.

**Precedence — the project wins.** The write happens after `onError` has had its
turn and only when the context carries no error yet. A project that curates
`setRequestError` keeps its value; a project that wires nothing still gets a row.
`setRequestError` becomes an *override*, not the wiring.

**The message follows ADR 0042's rule, shared rather than re-implemented.**
`recordedErrorMessage` in `internal/errors.ts` is now the single expression of
"the raw message goes in only where the envelope was scrubbed to
`INTERNAL_SERVER_ERROR`", called by both the HTTP path and the tool audit. One
rule, one place, two transports — which was the point of ADR 0042 and would have
been quietly lost by writing the condition twice.

**The response is untouched, and so is stderr.** This writes to a server-side
record. Two constraints hold it there, both pinned by tests:

- The envelope the caller receives is byte-identical on both branches.
- The custom-`onError` branch must not gain a `console.error` line. That branch
  deliberately avoids `normalizeError` (which logs the raw cause) and uses the
  side-effect-free `errorCode`; the recording obeys the same discipline, taking
  the normalised error only when the default branch already computed one.

## What this does not touch

The **access log** is unaffected, and that was checked rather than assumed:
`collectExtraLogFields` reads `userId`, `serviceName`, `action` and `dimensions`
from the context and never `ctx.error`. The completion line takes its code from
`logDone` as before, so filling the context changes nothing a log scraper sees.

That is the right split, not an accident worth preserving by luck: an audit row
is a record the project keeps, while an access log is frequently shipped
elsewhere. If the log line ever wants the cause, it should be an explicit choice
with its own argument.

## Consequences

- An audited HTTP failure names its cause with no wiring, matching the tool row.
- The custom-`onError` branch stops being a silent hole.
- `setRequestError` changes meaning from "how you record an error" to "how you
  override what was recorded". The guide says so; the behaviour is compatible
  either way, since a project already calling it keeps winning.
- One more consumer of `recordedErrorMessage`. If a third transport ever needs a
  record, it takes the rule from there rather than inventing a third variant.
