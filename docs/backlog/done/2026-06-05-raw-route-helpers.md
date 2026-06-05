---
title: Raw-route ergonomics — respondJson / errorResponse / parseBody
description: RawRoute is the primitive but ships no batteries. Consumers that drop to raw routes (file streaming, webhooks, public SDK endpoints) re-implement JSON responses (204 on null), the error envelope (AppError → JSON + traceId) and Zod body parsing in every route. Add a thin set of helpers reusing the existing error normalization + observability.
type: task
status: done
created: 2026-06-05
updated: 2026-06-05
completed: 2026-06-05 02:07
---

# Raw-route ergonomics helpers

**Type: DO (code, thin).** New idea — surfaced while reviewing a consuming
project's raw routes during its stitchkit migration. Not part of the 0.6.0 batch.

## Problem

`RawRoute` gives full `Request → Response` control for things that can't be a
clean contract (file streaming, webhooks, public SDK endpoints). But dropping to
a raw route loses everything the contract pipeline does for free, so every
consumer re-writes the same three things in each raw route:

- **JSON response** — `Response.json(data)`, with `204` for `void`/null;
- **error envelope** — turn a thrown `AppError` into the framework's
  `{ error: { code, message, details?, hint? } }` JSON + the current `traceId`;
- **body parse** — `schema.safeParse(await req.json())` → typed value or `400`.

It's boilerplate that belongs in the framework, not copy-pasted per route.

## Proposal

Three small, optional helpers in `stitchkit/server` — built on what already
exists (`normalizeError`, `AppError`, `getTraceId` from `stitchkit/observability`):

```ts
respondJson(data: unknown): Response
// Response.json(data); 204 (no body) when data is null/undefined

errorResponse(error: unknown): Response
// normalizeError(error) → the framework's error envelope + x-request-id / traceId

parseBody<T>(req: Request, schema: ZodType<T>): Promise<T | null>
// schema.safeParse(await req.json().catch(() => null)) → data | null
```

A consumer's raw route then reads:

```ts
handler: async (req, ctx) => {
  const body = await parseBody(req, MySchema)
  if (!body) return errorResponse(badRequest('invalid body'))
  try {
    return respondJson(await myService(body))
  } catch (err) {
    return errorResponse(err)
  }
}
```

## Scope — thin and consistent

- Reuse the **existing** error envelope (`normalizeError` / `AppError.toJSON`),
  not a new shape — so raw routes and contract routes return identical errors.
- `errorResponse` stamps the current `traceId` (via `stitchkit/observability`)
  the same way the contract pipeline does.
- Keep it minimal — a raw route is "you're in control"; these are conveniences,
  not a second pipeline. No auto-auth, no schema gate beyond `parseBody`.

## Acceptance

- [x] `respondJson` — JSON for data, `204` for null/undefined.
- [x] `errorResponse` — `AppError` and generic `Error` both → the framework
      envelope with the right status + `traceId` (`getTraceId`) when in a request context.
- [x] `parseBody` — valid → typed data; invalid / non-JSON → `null` (no throw).
- [x] Exports from `stitchkit/server` + `docs/guide/server.md` (Raw routes) +
      `docs/api/reference.md` rows. No `as` casts.
- [x] `bun run verify` green — 414 tests.

## Что сделано (2026-06-05)

- [x] **`server/raw.ts`** — `respondJson` (JSON / `204`), `errorResponse`
  (`normalizeError` → envelope + `x-request-id` via `getTraceId`), `parseBody`
  (`safeParse(await req.json().catch(()=>null))` → `data | null`). Reuses the
  existing error model — raw and contract routes return identical errors.
- [x] **Exports** — `server/index.ts`.
- [x] **Tests** — `tests/raw-helpers.test.ts` (envelope for AppError/generic/thrown
  helper, `traceId` in/out of request context, 204, parse valid/invalid/non-JSON).
- [x] **Docs** — `guide/server.md` (Raw-route helpers) + `api/reference.md` rows +
  `CHANGELOG`. No new ADR (thin conveniences over existing primitives).

Ships in the **0.6.0** batch.
