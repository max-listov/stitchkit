---
title: "ADR 0023 — Range-capable file serving (serveFile)"
type: decision
status: accepted
created: 2026-06-05
updated: 2026-06-05
---

# ADR 0023 — Range-capable file serving (`serveFile`)

- **Status:** Accepted — extends [ADR 0013](0013-runtime-agnostic-core.md)
- **Date:** 2026-06-05

## Context

`staticRoute` is the only built-in file path and is deliberately basic: it reads
the whole file into memory and supports no `Range`, no conditional requests. That
is fine for small web assets behind a CDN, but any backend that serves media —
video / audio / large downloads — needs HTTP **Range** so a browser can seek a
`<video>`, and needs conditional requests so the same media is not re-downloaded
on every request. Consumers were hand-rolling RFC 7233 parsing, `Content-Range`
and `If-Range` per raw route — generic HTTP infrastructure with zero domain, the
kind of thing the framework should own (cf. ADR 0002).

`Range` cannot be shipped in isolation: without **`If-Range`** a file that
changes mid-download is silently stitched together from stale and fresh bytes,
and without `ETag` / `Last-Modified` → `304` there is no caching at all. The
conditional-request layer is part of *correct* Range support, not an add-on.

## Decision

Add a **Bun-first** file responder plus its pure, runtime-neutral core.

- **`parseByteRange(header, size)`** (pure) → `{ start, end } | 'unsatisfiable'
  | null`. Single-range only; multiple ranges (`bytes=0-9,20-29`) return `null`
  so the caller serves the full `200` (ignoring an unparseable Range is
  RFC-compliant). No `multipart/byteranges`.
- **`weakETag(size, mtimeMs)`** (pure) → `W/"<size>-<mtime>"`. A **weak**
  validator from size + mtime — cheap (no content hashing), the right trade for
  static files. `If-Range` / `If-None-Match` comparison is exact-string against
  what we emitted (what real clients echo back).
- **`serveFile(req, opts)`** (Bun) — `405` (non GET/HEAD) · `404` (missing) ·
  `304` (`If-None-Match` / `If-Modified-Since`) · `200` (full) · `206` (range) ·
  `416` (unsatisfiable). Always `Accept-Ranges: bytes` + `nosniff`; `HEAD`
  returns headers with an empty body. Streams the range via
  `Bun.file().slice()` — no full read into memory.

The pure helpers never touch `Bun`, so they unit-test standalone and a future
Node `serveFile` can reuse them.

## Boundaries

- **Bun-only**, like `staticRoute`'s streaming would be — it uses `Bun.file`. A
  Node variant (`node:fs.createReadStream` + manual range) is a separate
  follow-up, mirroring the `staticRoute` Node discussion in ADR 0013. The
  contract core stays Web-Fetch-clean; `serveFile` lives in `stitchkit/server`.
- **`staticRoute` is left unchanged** (dual-runtime, basic, in-memory) — only the
  extension→MIME map is extracted to `server/mime.ts` and extended with media
  types, shared by both. Overloading `staticRoute` with a `{ ranges: true }`
  option was rejected: it would leak `Bun.file` into the node:fs path and blur
  the runtime boundary. `serveFile` is the explicit Bun primitive instead.
- **Containment is the caller's job** — `serveFile` takes an explicit `path`. For
  URL-derived paths use `staticRoute` (which enforces `isWithinDir`) or call
  `isWithinDir` first.

## Alternatives considered

- **Extend `staticRoute({ ranges: true })`.** Rejected — mixes Bun-only
  streaming into a deliberately dual-runtime helper.
- **Strong ETag (content hash).** Rejected — hashing large media per request is
  the cost Range serving exists to avoid; a weak size+mtime validator is enough.
- **Multi-range `multipart/byteranges`.** Deferred — rarely used by media players
  (single-range seek dominates); `null` → full `200` is compliant.

## Consequences

- Apps serve seekable, cacheable media with one call — no per-route RFC 7233.
- Additive: `staticRoute` behaviour is unchanged; only its MIME coverage grew.
- Cast-free; the pure parser/validators are reusable by a later Node adapter.
