---
title: "ADR 0299: CORS is decided per request origin, credentials included"
description: A handler may answer CORS for each exact request origin with an allowance with or without credentials, once per request, failing closed; a safelisted text body needs an origin trusted with credentials.
type: decision
status: accepted
created: 2026-11-21 19:53 +08:00
updated: 2026-11-21 19:53 +08:00
---

# ADR 0299 — CORS is decided per request origin, credentials included

Amends the allow-list in [ADR 0165](0165-a-safelisted-body-is-accepted-only-from-an-allowed-origin.md). Serves **I9** and **I12**.

## Context

`cors` names its origins statically and carries one `credentials` flag for all of
them. A consuming project issues short bearer tokens to pages on other sites, per
key and per origin, and keeps cookie sessions for its own pages. To let a
partner's preflight through it would have to add the partner to the one list —
and the one flag would then let that site send cookies. The origins also live in
the application's data, not in its configuration.

## Decision

`HandlerConfig.cors` accepts a `CorsOriginPolicy`: `origin` is a function from
the exact request origin to `false` or `{ credentials: boolean }`, sync or async.
`credentials` beside it is refused at construction: the answer carries it.
The answer is not `PolicyDecision` ([ADR 0155](0155-one-decision-vocabulary-and-an-unanswered-question-is-an-error.md)):
that vocabulary votes allow, deny or defer on whether work runs, while this
one says what a browser may read and with which credentials — a deferral has
no meaning here, and an allowance has a property a vote does not.

- **Once per request.** The handler decides before any work and every exit reads
  that one answer: preflight, the `onRequest` short-circuit, raw routes, raw,
  stream and data endpoint responses, error envelopes, `onError` responses, `404`,
  `405` and `499`.
- **The exact origin.** A grant names the requesting origin; the policy cannot
  answer with another origin or `*`. It is asked only for a serialized origin —
  scheme and authority — never for a missing header or `null`.
- **Caches.** Every response under a policy carries `Vary: Origin`, a denial
  included, so a shared cache never serves one origin's answer to another.
- **Fails closed.** A throw, a rejection or an answer of another shape grants
  nothing and runs nothing: the request is refused through `onError` with the
  cause, and the response carries no allowance.
- **Not authorization.** A denial on an actual request does not stop the
  endpoint, exactly as with a static list: CORS decides whether a page may read
  the answer, authorization decides whether the work runs.

Under a policy, a safelisted `text/plain` body (ADR 0165) is read only from an
origin granted **with credentials**. A simple request is sent with cookies before
CORS is consulted; an origin the application did not trust with credentials must
not be able to act through the user's session by posting text.

## Consequences

- Static configurations answer exactly as before; the policy is a third shape of
  the same option, not a second mechanism.
- `corsHeaders` and `corsPreflightResponse` stay static helpers: a policy belongs
  to the handler, which owns the request it answers.
- Socket.IO keeps its own `cors`.
