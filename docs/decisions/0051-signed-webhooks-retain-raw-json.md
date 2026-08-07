---
title: Signed HTTP webhooks retain raw JSON text on demand
description: An HTTP-only contract endpoint may preserve the decoded JSON text for HMAC verification while keeping normal Zod validation.
type: decision
status: accepted
created: 2026-08-07
updated: 2026-08-07
---

# 0051 — Signed HTTP webhooks retain raw JSON text on demand

## Context

HMAC webhook providers sign the original request payload, including whitespace.
The contract router read that text, parsed JSON, ran the input schema and then
discarded the text before lifecycle hooks or the handler ran. A consumer had to
move the webhook to `rawRoutes` and give up contract validation, or clone and
side-channel the request from the global `onRequest` hook.

## Decision

- A `POST`/`PUT`/`PATCH` JSON endpoint may declare `rawBody: true`.
- The endpoint is HTTP-only and must declare `input`; multipart and tool
  decoration/exposure are rejected at contract definition time.
- The router writes the exact decoded text it already read to `ctx.rawBody`
  before JSON and Zod parsing. The handler type guarantees `rawBody: string`
  and `req: Request`; `onError` can read the retained text after either parser
  rejects it.
- Endpoints without the flag do not retain the text after parsing.
- `maxJsonBodyBytes` is an optional route/server ceiling. When configured, the
  stream is cancelled as soon as it crosses the cap, before full buffering.
- No new pre-parse lifecycle hook: raw-body retention solves the data-ownership
  gap without adding another global execution phase.

## Consequences

Signed webhooks keep contract validation, OpenAPI and the normal lifecycle.
Retention is explicit because the parsed object and original text coexist for
the request lifetime. The value is UTF-8 decoded request text, matching JSON
webhook HMAC APIs; it is not a generic binary-upload surface. Multipart keeps
its independent streaming parser and upload limit.
