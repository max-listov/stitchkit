---
title: "ADR 0281: Static files are served by one responder"
description: staticRoute answers a contained file through serveFile, and serveFile runs on Bun and Node, so every file path has ranges, validators and a streamed body.
type: decision
status: accepted
created: 2026-11-03
updated: 2026-11-03
---

# ADR 0281 — Static files are served by one responder

Amends [ADR 0023](0023-range-file-serving.md) and [ADR 0013](0013-runtime-agnostic-core.md). Serves **I6**, **I8**.

## Context

ADR 0023 kept two file paths: `staticRoute`, dual-runtime and basic, reading the whole file into memory with no
`Range`, no validators and no `Cache-Control`; and `serveFile`, which had all three but only on Bun. The split
existed to keep `Bun.file` out of the route that also runs on Node.

A consuming project served its previews and videos through `staticRoute` and measured the cost: a 303 697-byte
image came back with no `ETag`, `Last-Modified`, `Accept-Ranges` or `Cache-Control`, and `Range: bytes=0-99` on a
2 458 038-byte `.webm` returned the whole file. A browser re-downloaded every preview on every visit, a `<video>`
in Safari and in a Telegram Mini App on iOS needs `206` to play, and each request held up to 7 MiB in memory. The
mechanics that fix all of it already shipped in the same file, one function away.

## Decision

`staticRoute` keeps its containment checks — lexical, then realpath — and answers the contained file with
`serveFile`. `staticRoute(prefix, dir, { cacheControl })` passes the header through; its default sends none, as
`serveFile`'s does.

`serveFile` runs on both runtimes. Size, mtime and the file check come from `node:fs` `stat`, so a directory is
`404` on both. The body is the only runtime-specific part, one function: on Bun the lazy `Bun.file().slice()`,
which the server sends without copying through JavaScript; on Node a `createReadStream` over the same inclusive
span, wrapped as a web `ReadableStream`. Range parsing, validators and the `304`/`206`/`416` decisions are one
implementation for both.

## Alternatives

- `staticRoute({ ranges: true })`, ADR 0023's rejected option: still rejected. An option that turns correct
  HTTP on leaves the default wrong, and the default is what a consuming project ships.
- A separate Node `serveFile`: rejected. Two responders drift in the conditional rules, which are the subtle
  half; the runtimes differ only in how bytes leave.
- `node:fs` streams on Bun too: rejected. Bun sends a file slice without the read loop, and media is the
  load this path exists for.

## Consequences

Every file a `staticRoute` serves carries a weak `ETag`, `Last-Modified` and `Accept-Ranges: bytes`, answers a
single range with `206` and a matching validator with `304`, and streams instead of buffering. A client that
cached nothing before now revalidates; a consuming project sets `cacheControl` to cache. The route still answers
`GET` only: a `HEAD` probe of a static file needs a `method: 'ALL'` raw route over `serveFile`, as ADR 0053
describes. Proven in `packages/core/tests/static-route.test.ts`, `serve-file.test.ts`, `security.test.ts`, and
on Node by `packages/core/scripts/node-smoke.mjs`.
