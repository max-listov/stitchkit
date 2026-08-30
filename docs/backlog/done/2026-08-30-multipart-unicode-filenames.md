---
title: Preserve Unicode filenames in streaming multipart headers
description: Parse standards-compliant multipart disposition metadata without routing Unicode header values through ByteString-only platform Headers.
type: task
status: done
completed: 2026-08-30
created: 2026-08-30
updated: 2026-08-30
---

## Зачем

The streaming multipart parser decodes each part header block as UTF-8 and appends every raw value to
the platform `Headers` implementation. A browser-generated file part whose `Content-Disposition`
contains a Unicode filename can therefore throw a platform `TypeError` before contract validation or
the endpoint handler. Unicode filenames are normal input and must not depend on a ByteString-only
container intended for HTTP transport headers.

Minimal failing shape:

```text
Content-Disposition: form-data; name="files"; filename="Снимок — 1.png"
Content-Type: image/png
```

The failure belongs to generic multipart parsing. Consumers must not rename files, strip characters
or install their own parser around the framework.

## Результат

- Part headers are parsed by a bounded, case-insensitive internal representation suitable for decoded
  disposition parameters; malformed/duplicate-sensitive input keeps an explicit rejection policy.
- `filename` and standards-compliant `filename*` preserve the decoded Unicode name delivered by
  browsers without unsafe-key or header-injection regressions.
- Buffered and streaming multipart delivery share the same behavior and retain all existing byte,
  part-count, content-type and rollback bounds.
- A patch release is published for consumers that cannot upload ordinary localized filenames.

## План

Implementation decision: keep the existing bounded byte reader and shared buffered/streaming path.
Decode header bytes as strict UTF-8 into an internal case-insensitive map; reject duplicate headers,
folding, invalid tokens and control characters. Treat UTF-8 `filename*` as an explicit interoperability
extension (preferred over `filename`), not a requirement for browser form serialization. Invalid
extended values fail closed rather than silently selecting the fallback filename.

- [x] Add a regression that sends a browser-compatible multipart body with Cyrillic, Unicode punctuation
  and a non-breaking space in the filename and reproduces the current pre-handler throw.
- [x] Replace platform `Headers` use inside part parsing with a bounded internal parser and define
  duplicate, folding and invalid-name behavior explicitly.
- [x] Support and test `filename*` precedence/decoding alongside legacy `filename` without accepting
  CR/LF injection or unsafe field names.
- [x] Run multipart unit/integration suites, repository typecheck and packed consumer lanes.
- [x] Assign final package gate/publication acceptance to the core `0.70.2` target in
      `release-train.json`, with the regression in its mandatory packed lane. This transfer is not
      a claim of publication: the release pipeline below must finish before the release is closed.

## Acceptance

- [x] Unicode `filename` reaches both buffered and streaming receivers unchanged.
- [x] Valid `filename*` decodes according to its declared UTF-8 percent-encoding and takes precedence.
- [x] Malformed headers, unsafe field names, CR/LF injection and invalid declared sizes remain rejected.
- [x] Existing multipart request/field/file limits and cleanup guarantees remain green.

## Что сделано

- `packages/core/tests/multipart-unicode.test.ts`: `buffer: browser FormData filename reaches the
  endpoint unchanged` and `stream: browser FormData filename reaches the endpoint unchanged` both
  reproduced HTTP 500 before the fix, then passed. `one-byte chunks preserve Unicode and extended
  filename takes precedence` covers UTF-8 split across chunks and both filename forms.
- The same file's `quoted semicolons, escaped quotes and literal percent sequences are preserved`,
  refusal table, `invalid UTF-8 bytes and oversized header blocks are rejected`, and `a malformed
  later part rolls back the Unicode receiver exactly once` hold the metadata boundary.
- Existing `packages/core/tests/multipart-streaming.test.ts` cases `enforces request and per-file
  caps without trusting content-length`, `rolls accepted handles back once in reverse order after
  late validation fails`, and `request abort cancels the active receiver and rolls back earlier
  handles` remain green, alongside `packages/core/tests/multipart.test.ts`.
- Focused multipart/declaration run: 144 tests, 0 failures, 226 assertions. Repository typecheck
  passed. All five packed consumer fixtures passed, including the new
  `packages/core/scripts/consumer-lane/fixtures/node/src/multipart-unicode.mjs` on Bun and Node.
- Guide and changelog document the bounded header policy and filename interoperability extension.

## Release acceptance (owned by the release train)

Core `0.70.2` must pass `bun scripts/verify.ts --release`, exact-SHA push CI, then publication of
that CI artifact under `v0.70.2`. After registry publication, install the actual registry tarball and
run `multipart-unicode.mjs` on Bun and Node; compare its integrity with the CI tarball. The GitHub
release/tag supplies the immutable version/commit link. No local test archive is publication proof.
