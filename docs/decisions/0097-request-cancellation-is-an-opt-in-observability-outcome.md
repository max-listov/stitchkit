---
title: "ADR 0097: Request cancellation is an opt-in observability outcome"
description: "Client disconnects remain neutral access completions and become structured RequestEvents only for sinks that explicitly opt into cancellation rows."
type: decision
status: accepted
created: 2026-08-21
updated: 2026-08-21
---

# ADR 0097 — Request cancellation is an opt-in observability outcome

## Context

ADR 0063 made one framework-owned HTTP completion the source for access logging
and `RequestEvent`. The released event model has only `ok: boolean`: emitting a
client disconnect as `ok: false` makes it indistinguishable from an application
failure to an existing sink, while `ok: true` falsely calls incomplete work a
success. Omitting the event removes false incidents but also removes structured
cancellation counts.

HTTP runtimes provide a narrow trustworthy discriminator: the request's own
signal is aborted and the thrown value is either an `AbortError` or the exact
`request.signal.reason` object, directly or through a standard `cause` chain.
Bun uses `DOMException AbortError`; the real Node/srvx bridge aborts with an
`Error` carrying `ECONNRESET`. A dependency may preserve that same object as an
outer error's `cause`. Name, message or code alone is never enough because
application-internal aborts remain server failures.

## Decision

The HTTP dispatcher classifies the two-signal case as a `client_closed`
completion with transport status `499`. It bypasses application `onError`, error
normalisation and request-error recording. Access logging always records the
completion at `info`; `499` has that meaning framework-wide and is not a
contract/OpenAPI response.

Cause traversal is identity-only, cycle-safe and limited to eight links. An
active request, an unrelated cause, a cycle, or a reason beyond that bound stays
on the ordinary application-error path. JSON body reads with a configured size
limit race each pending stream read against the request signal: a mid-stream
close throws the canonical reason and starts best-effort reader cancellation,
rather than returning partial input or waiting for transport cleanup.

Structured request cancellation is additive and opt-in:

- `RequestObservabilityConfig.includeCancelled` defaults to `false`;
- an opted-in cancellation row carries `outcome: 'cancelled'`, `ok: false`,
  `statusCode: 499`, identity/trace/timing and no application error fields;
- ordinary success and failure rows omit `outcome` and retain their existing
  runtime shape;
- cancellation uses the existing request sink manager, so filtering, capacity,
  diagnostics, ordering, flush and close semantics do not fork.

`ok` remains the legacy success bit: cancellation did not succeed, but an
opted-in consumer checks `outcome` before treating `ok: false` as an application
failure. Default-off emission prevents legacy sinks from receiving this new row
class without choosing that interpretation.

Tool transport semantics do not change. MCP already carries protocol outcomes
such as `cancelled` inside `RequestEvent.mcp`; Agent/CLI do not expose one generic
caller-disconnect fact equivalent to an HTTP request signal. A future shared
outcome requires transport evidence rather than inference from error text.

## Consequences

- Browser reloads and physical client disconnects no longer create false 500s,
  error logs or application audit failures.
- Mid-upload disconnects cannot leave bounded JSON body reads pending or parse a
  partial body as an application request.
- Operations teams retain an always-on `499/info` access count and may opt into
  structured cancellation rows.
- Adding the optional field and config is source-compatible; enabling the flag
  is an explicit behavioral choice for the sink.
- A sink that enables cancellations must branch on `event.outcome` before the
  legacy `event.ok` field.
