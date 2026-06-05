---
title: Generic opaque cursor codec — encodeCursor / decodeCursor
description: stitchkit owned the {items,nextCursor} envelope + createCursorQuery but not the cursor codec, so every consumer re-implemented base64(JSON) encode/decode (3 projects, even intra-project dup). Lift the generic codec into stitch — browser+UTF-8-safe base64url, Zod-validated — keeping the keyset WHERE clause in the app.
type: task
status: done
created: 2026-06-05
updated: 2026-06-05
completed: 2026-06-05 07:50
related: docs/decisions/0002-generic-core.md
---

# Generic opaque cursor codec

**Type: DO (code, generic).** Surfaced while reviewing cursor pagination across
consuming projects during migration.

## Problem

stitchkit owns the pagination **envelope** (`Paginated` / `paginatedSchema`) and
the **client** (`createCursorQuery`), but left the `nextCursor` **format** to the
server — correctly opaque, but with **no codec**. So every consumer hand-rolled
the identical `base64url(JSON.stringify({ sortValue, id }))` encode + safe-decode:

- three consuming projects each have one, differing only in field names
  (`{ v, id }` / `{ ts, id }` / `{ id, t }` / `{ c, id }`);
- even **within** one project it was duplicated (a shared `pagination/cursor.ts`
  plus an ad-hoc re-roll in an audit service).

Two latent bugs hid in the hand-rolled versions: `Buffer`-based ones are **not
browser-safe** (break in the typed client / edge), and naïve `btoa(JSON)` ones
**corrupt non-ASCII** sort values (a name, an emoji).

## Decision

Lift the **generic codec** into `contract/pagination.ts`, next to the envelope it
completes. Keep the keyset WHERE clause in the app (it is ORM-specific) — this is
only the string ⇄ value codec, so the generic core stays domain-free (ADR 0002).

```ts
encodeCursor(value: unknown): string
decodeCursor<T>(cursor: string | null | undefined, schema: ZodType<T>): T | null
```

base64url over UTF-8 via `btoa`/`atob` (not `Buffer`) — server / client / browser
safe; a non-ASCII sort value round-trips. `decodeCursor` Zod-validates and returns
`null` for a missing / malformed / wrong-shape cursor (garbage in a URL = "no
cursor", never a throw).

## Acceptance

- [x] `encodeCursor` / `decodeCursor` in `contract/pagination.ts`, exported from
      `stitchkit` (root, browser-safe). No `as`.
- [x] base64url + UTF-8 safe (`btoa`/`atob` + `TextEncoder`/`TextDecoder`), not
      `Buffer`.
- [x] `decodeCursor` validates against a Zod schema; missing/garbage/invalid → `null`.
- [x] Tests + docs + CHANGELOG. `bun run verify` green.

## Что сделано (2026-06-05)

- [x] **Codec** — `contract/pagination.ts`: `encodeCursor`/`decodeCursor` +
  internal `toBase64Url`/`fromBase64Url` (UTF-8-safe base64url). Exported from
  `contract/index.ts` → root `stitchkit`.
- [x] **Tests** — `tests/cursor.test.ts`: round-trip (string + numeric sort
  value), URL-safety (no `+/=`), **UTF-8** round-trip (the correctness win),
  missing → `null`, garbage/non-JSON → `null`, wrong shape → `null`.
- [x] **Docs** — `guide/contracts.md` (Pagination — keyset example with the WHERE
  clause kept in the app), `api/reference.md` rows, `CHANGELOG` `[Unreleased]`.
  No new ADR (additive, completes existing pagination under ADR 0002).
- [x] **Снять у консьюмеров:** replace each project's hand-rolled cursor codec
  with the import (keep their keyset WHERE builder); drop the intra-project dup.

Ships in the next release batch (additive — no breaking change).
