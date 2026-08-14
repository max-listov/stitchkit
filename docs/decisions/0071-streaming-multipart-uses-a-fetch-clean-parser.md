---
title: "ADR 0071 — Streaming multipart uses a Fetch-clean sequential parser"
description: Stream multipart file parts directly to consumer receivers without buffering whole files or exposing runtime-specific stream types.
type: decision
status: accepted
created: 2026-08-14
updated: 2026-08-14
---

# ADR 0071 — Streaming multipart uses a Fetch-clean sequential parser

- **Status:** Accepted — preserves the runtime-neutral boundary of
  [ADR 0013](0013-runtime-agnostic-core.md) and the typed HTTP surface of
  [ADR 0005](0005-typed-client.md).
- **Date:** 2026-08-14

## Context

Large multipart uploads cannot pass through `Request.formData()`: the runtime
materialises complete `File` values before application code can direct bytes to
storage. A streaming implementation must parse parts sequentially, enforce
request and per-part limits while reading, preserve file order and cancel the
active receiver when the request aborts.

The maintained `@remix-run/multipart-parser` package was evaluated at version
`0.16.4`. Its public API accepts Web streams, but its parser collects each
part's chunks in an array and concatenates them before yielding a part. It is a
good buffered parser, not a direct-to-sink streaming boundary, so adopting it
would retain file-sized memory use under a different API.

## Decision

Stitchkit keeps an isolated sequential multipart parser in the Web Fetch server
layer. It consumes `ReadableStream<Uint8Array>`, retains only boundary/header
look-behind state, and exposes each file part as a bounded Web stream to the
receiver registered by `defineMultipartStream`.

The contract descriptor remains the single source of field cardinality,
request/file/text limits and declared media-type policy for buffered and
streaming delivery. Streaming receivers return an application-owned value and
an obligatory cleanup. Stitchkit accumulates cleanups only after receiver
success and runs them exactly once in reverse order if any later parse,
validation, receiver or handler phase fails. Successful handler completion
transfers ownership to the application.

No Node stream, Bun type, filesystem API, object-storage client or durable
transaction abstraction enters the public API.

## Alternatives rejected

- `Request.formData()` followed by `File.stream()`: the complete file is already
  materialised before the stream exists.
- `@remix-run/multipart-parser@0.16.4`: Web-compatible, but buffers every part
  internally and therefore cannot satisfy direct streaming.
- Node-specific parsers: violate the Fetch-clean core and create different Bun
  and Node behavior.
- Passing live part streams into the final handler: later text fields are not
  parsed or validated yet, and advancing the sequential parser requires the
  current part to be consumed first.
- Framework-owned filesystem/S3 adapters: storage policy and external atomicity
  belong to the consuming application.

## Consequences

- Streaming file memory is bounded by parser look-behind and transport chunks,
  not total file size.
- Receivers may create external state before late text validation, so cleanup is
  a correctness requirement rather than an optional convenience.
- Parser behavior needs adversarial chunk-boundary, limit, abort and rollback
  tests on every supported runtime.
- Re-evaluating an external parser remains possible if it later exposes true
  per-part streaming with the same Fetch-clean guarantees.
