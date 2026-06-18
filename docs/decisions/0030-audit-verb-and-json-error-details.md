---
title: "ADR 0030 — Audit verb, sanitised error details, and complete error-code logging"
type: decision
status: accepted
created: 2026-06-18
updated: 2026-06-18
---

# ADR 0030 — Audit verb, sanitised error details, and complete error-code logging

- **Status:** Accepted — extends [ADR 0029](0029-audit-endpoint-identity-and-dimensions.md)
  (audit completeness), [ADR 0026](0026-stitch-error-code-registry.md) (error
  model), [ADR 0022](0022-endpoint-identity.md); keeps the core generic per
  [ADR 0002](0002-generic-core.md).
- **Date:** 2026-06-18

## Context

After [ADR 0029](0029-audit-endpoint-identity-and-dimensions.md) a consuming
project moved its HTTP audit onto `createAuditHook`, then reported the remaining
edges of running **one** audit pipeline across HTTP and tools:

- **Tool events have no verb.** A tool `RequestEvent` carries `method: "TOOL"`, so
  a single "audit only writes" filter cannot tell a read from a write — forcing a
  second, hand-rolled tool audit (`afterToolCall`, where `endpoint.method` is
  available) beside `createAuditHook`.
- **`setRequestError({ details })` forced a type round-trip.** A consumer's domain
  error extends `AppError`, whose `details` is `Record<string, unknown>`; passing
  `appErr.details` into `setRequestError`'s `JsonValue`-typed `details` (added in
  0.11.0) failed to typecheck, so the consumer laundered it with
  `JSON.parse(JSON.stringify(appErr.details))`.
- **`errorDetail` was HTTP-only and unsanitised.** A failed tool call carried
  `errorCode` / `errorMessage` but not the structured detail an HTTP failure did,
  and the HTTP `errorDetail` was emitted raw (a potential secret leak).
- **The access log dropped the error code when `onError` returns its own
  Response.** 0.10.0 rendered `errorCode` only on the framework-default error
  path; a project with a custom `onError` (its own envelope) saw `← 400` with no
  code.

## Decision

- **`RequestEvent.httpMethod`** — the operation's contract verb, set on **tool**
  events (from the `endpoint` the hook receives), so one filter spans both
  surfaces: `(event.httpMethod ?? event.method) !== 'GET'`. Omitted on HTTP
  events, where `method` already is the verb. The raw verb is exposed, **not** a
  derived `isMutation` flag — the core reports the fact, the app decides what a
  mutation is (ADR 0002). This lets a project fold its tool audit into the single
  `createAuditHook`.
- **`setRequestError` accepts `details: unknown`, sanitised into `errorDetail` at
  emit.** The error handler passes its detail raw — an `AppError.details`, a
  `ZodError`'s issues, anything — and `createAuditHook` runs it through
  `sanitizePayload` (the same masking/capping as `payload`) before it lands on
  `RequestEvent.errorDetail`. The consumer's manual `JSON.parse(JSON.stringify())`
  round-trip is exactly that sanitisation, now built in — no pre-laundering, and
  `errorDetail` can no longer leak a secret.
- **`errorDetail` on tool events** — emitted from a failed `ToolResult.details`
  (sanitised), symmetric with the HTTP path.
- **The access log renders `errorCode` on every error path** — including when a
  custom `onError` returns its own Response, via a side-effect-free `errorCode(err)`
  extractor (no re-normalise, no double log).

## Alternatives considered

- **`isMutation: boolean` on the tool event** instead of the verb. Rejected —
  baking the read/write judgement into the core is a domain call; the verb is the
  raw fact, and the app derives the rest.
- **Narrow `AppError.details` (and the error helpers / `ErrorEnvelope.details`) to
  `JsonValue`** — the consumer's literal request. Rejected: it ripples into every
  boundary that builds an `AppError` from **untyped network data** (the typed
  client parsing an error envelope, `implementRemote` reconstructing a remote
  error) — those legitimately hold `unknown` / `Record<string, unknown>`, so the
  narrowing is a breaking change that pushes casts to the boundaries. Accepting
  `unknown` at `setRequestError` and sanitising at emit removes the round-trip
  additively, without touching the error model, and adds secret-masking on top.

## Consequences

- **Additive — no breaking change.** New `RequestEvent.httpMethod`, tool
  `errorDetail`, a wider `setRequestError` input, a sanitised `errorDetail`, and an
  access-log fix. Ships in 0.12.0.
- **A project can run a single `createAuditHook` across HTTP and tools** with one
  read/write filter and symmetric, sanitised structured error detail — and pass an
  `AppError`'s `details` straight to `setRequestError`.

## Declined (recorded so it is not re-proposed each cycle)

- **An optional `resolveIdentity` phase before validation** — the consumer's
  highest-priority ask, its fourth request. Its concrete case resolves a
  `projectId` via a **DB lookup**; running that before body validation re-opens the
  fail-fast / DoS hole the current order closes (a malformed request would hit the
  database). The need ("attribute a pre-handler failure to an actor") is real but
  only valid for **cheap** (token / header) identity, and must not be designed on a
  DB-lookup case. The consumer's duplication is solvable in their app — cache the
  `botId → projectId` lookup, or carry `projectId` in the auth token so `onError`
  reads it from a header for free. A framework phase waits for a second,
  independent consumer with cheap identity.
