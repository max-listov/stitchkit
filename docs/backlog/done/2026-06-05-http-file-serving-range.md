---
title: HTTP file serving with Range support (serveFile / parseByteRange)
description: staticRoute is "basic, no Range". Add a Range-capable, Bun-first file responder (RFC 7233 — 206 / 416 / Content-Range / Accept-Ranges) plus the conditional-request layer Range correctness needs (ETag / Last-Modified / If-Range / 304) and HEAD. The byte-range parser is pure and standalone-testable.
type: task
status: done
created: 2026-06-05
updated: 2026-06-05
completed: 2026-06-05 02:07
related: docs/decisions/0023-range-file-serving.md, docs/backlog/done/2026-06-05-raw-route-helpers.md
---

# HTTP file serving with Range support

**Type: DO (code, Bun-first).** Surfaced while reviewing a consuming project's
raw-route file handler during its stitchkit migration. **Confirmed scope: full
RFC responder, folded into the 0.6.0 batch** (the migration-era batch; commit on
pause until the migration finishes).

## Problem

`staticRoute` is the only built-in file path and is documented as **"basic,
without Range — put a CDN in front"**. It also reads the whole file into memory.
But any backend that serves media — video / audio / large downloads — needs HTTP
**Range** requests for seeking:

- no `Accept-Ranges` / `206 Partial Content` ⇒ the browser can't seek a `<video>`;
- no `416` on an unsatisfiable range ⇒ non-compliant;
- no `If-Range` ⇒ a file that changes mid-download is stitched from stale + fresh
  bytes (corrupt) — so `Range` cannot ship without conditional requests;
- no `ETag` / `304` ⇒ no caching, media re-downloaded every request;
- consumers re-implement RFC 7233 parsing + `Content-Range` by hand in a raw route.

This is a recurring, generic need (zero domain) — HTTP infrastructure the
framework should own.

## Confirmed design (3 forks resolved)

1. **Scope → full RFC responder.** Range + conditional (`ETag` / `Last-Modified`
   / `If-Range` / `If-None-Match` / `If-Modified-Since` → `304`) + `HEAD` + MIME
   auto-detect. The conditional layer is part of *correct* Range serving, not an
   add-on.
2. **`staticRoute` → left unchanged** (dual-runtime, basic, in-memory). Only the
   extension→MIME map is extracted to `server/mime.ts` and extended with media
   types, shared by both. No `{ ranges: true }` option (it would leak `Bun.file`
   into the node:fs path — blurs the runtime boundary). `serveFile` is the
   explicit Bun primitive instead.
3. **Release → folded into the 0.6.0 batch.**

## API

```ts
// stitchkit/server (Bun-first — uses Bun.file)
serveFile(req: Request, opts: {
  path: string                          // caller owns containment
  contentType?: string                  // auto-detected from path if omitted
  filename?: string                     // → Content-Disposition
  disposition?: 'inline' | 'attachment' // default 'inline'
  cacheControl?: string
  etag?: boolean                        // default true
  lastModified?: boolean                // default true
}): Promise<Response>

// pure, runtime-neutral — exported for direct use + unit tests
parseByteRange(header: string | null, size: number):
  | { start: number; end: number } | 'unsatisfiable' | null
weakETag(size: number, mtimeMs: number): string
```

**Response matrix:** `405` (non GET/HEAD, `Allow: GET, HEAD`) · `404` (missing) ·
`304` (`If-None-Match` / `If-Modified-Since`) · `200` (full — no/ignored Range) ·
`206` (range, `Content-Range` + `Content-Length`) · `416` (unsatisfiable,
`Content-Range: bytes */size`). Always `Accept-Ranges: bytes`, weak `ETag`,
`Last-Modified`, `nosniff`; `HEAD` → all headers, empty body. Range body streams
via `Bun.file().slice(start, end + 1)` — no full read into memory.

`parseByteRange`: single-range only; multiple ranges (`bytes=0-9,20-29`) → `null`
(serve full `200`, RFC-compliant). Suffix `bytes=-n`, open-ended `bytes=a-`,
clamps `end >= size`, `unsatisfiable` when `start >= size` / empty file /
`bytes=-0`, malformed → `null`.

## Scope — generic only

- ✅ Take: RFC 7233 single-range, `200/206/416`, conditional (`ETag` /
  `Last-Modified` / `If-Range` / `304`), `HEAD`, `Bun.file().slice()` streaming,
  shared media MIME map.
- ✂️ Leave out: app error envelopes, named cache "strategies" (plain
  `cacheControl?: string` instead), multipart/byteranges (multi-range), and a
  Node `serveFile` (`node:fs.createReadStream` — separate follow-up, mirrors the
  `staticRoute` Node discussion in ADR 0013). The caller resolves the file path.

## Acceptance

- [x] `parseByteRange` unit tests: full `bytes=a-b`, suffix `bytes=-n`,
      open-ended `bytes=a-`, clamping `end >= size`, `unsatisfiable`
      (`start >= size` / empty file / `bytes=-0`), malformed → `null`,
      no-header → `null`, multi-range → `null`. → `tests/byte-range.test.ts`.
- [x] `serveFile` tests: `200` full, `206` (`Content-Range` / `Content-Length`),
      `416` (`Content-Range: bytes */size`), `Accept-Ranges` always, `304`
      (`If-None-Match` / `If-Modified-Since`), `If-Range` honour/ignore, `HEAD`,
      `404`, `405`, `cacheControl` / `filename` / `etag:false` passthrough.
      → `tests/serve-file.test.ts`.
- [x] No `as` casts. `docs/guide/server.md` note (Range vs `staticRoute`),
      `docs/api/reference.md` rows, `CHANGELOG`, **ADR 0023** + index row.
- [x] `bun run verify` green — 414 tests, lint / tsc / build clean.

## Что сделано (2026-06-05)

- [x] **Pure core** — `packages/core/src/server/file.ts`: `parseByteRange` (single
  range, suffix, open-ended, clamp, `unsatisfiable`, multi-range→`null`),
  `weakETag`, conditional validators (`If-None-Match` / `If-Modified-Since` /
  `If-Range`). No `Bun`, unit-testable.
- [x] **`serveFile`** (Bun) — `packages/core/src/server/file.ts`: `405/404/304/200/
  206/416`, `Accept-Ranges`/`ETag`/`Last-Modified`/`nosniff`, `HEAD`, streams via
  `Bun.file().slice()`. Exported from `server/index.ts`.
- [x] **Shared MIME map** — `packages/core/src/server/mime.ts` (`mimeForPath`),
  extended with media types; `router.ts` `staticRoute` now uses it (local
  `STATIC_MIME` removed).
- [x] **Tests** — `tests/byte-range.test.ts` (parser + etag), `tests/serve-file.test.ts`
  (all statuses + conditional + HEAD).
- [x] **Docs** — `guide/server.md` (Serving files & Range), `api/reference.md` rows,
  `CHANGELOG` `[Unreleased]`, **ADR 0023** + index row.
- [x] **Out of scope** — multipart/byteranges, Node `serveFile`, `staticRoute`
  streaming refactor → deferred (documented in ADR 0023 boundaries).

Ships in the **0.6.0** batch (commit/release on pause until migration finishes).
