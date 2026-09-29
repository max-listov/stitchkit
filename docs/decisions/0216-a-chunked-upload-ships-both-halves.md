---
title: "ADR 0216: A chunked upload ships both halves"
description: "uploadInChunks drives init → parts → finalize over three calls the application owns; createChunkSpool holds parts on disk with receipts; the rules they share — client-minted id, idempotent parts, finalize never repeated — live in one place."
type: decision
status: accepted
created: 2026-09-29
updated: 2026-09-29
---

# ADR 0216 — A chunked upload ships both halves

## Context

A file larger than one request (a consuming project: 4 MiB parts, 5 MiB
requests, files up to 1 GiB) goes as `init` → `chunk` × N → `finalize`. That
project carries the protocol three times — a desktop client loop, a web SDK
loop with retries and cancellation, and a server spool with receipts — and the
copies already disagree in small ways: which failures are repeated, what counts
as the same part. The next product that uploads writes a fourth.

The question this record answers is where the primitive's edge runs: a client
driver over three endpoints only, or the server's storage too.

## Decision

1. **Both halves, and the contract stays the application's.** stitchkit does
   not ship the three endpoints: their fields, auth, limits and what happens to
   the finished file differ per product. It ships the two pieces every product
   rewrites identically.
2. **`uploadInChunks` (root entrypoint) drives three functions the application
   passes** — usually its three client calls:
   - the client mints the upload id, so a repeated `init` is the same upload;
   - `init` and a part are repeated on a failure that may pass — no answer
     (network, timeout), `429`, `5xx` — with a doubling pause; a refusal is
     final;
   - `finalize` is never repeated: after it the application owns the file. A
     lost `finalize` answer is recovered by `init` resolving `{ finished }`,
     returned without a byte sent;
   - the caller's signal is checked between parts, so a cancelled upload never
     reaches `finalize`;
   - progress counts file bytes, inside a part too, by passing
     `onUploadProgress` (ADR 0215) into the part call.
3. **`createChunkSpool` (`stitchkit/files`) holds the parts**, keyed by the
   application's `owner` and the client's `uploadId`:
   - `open` stores the declaration and the application's meta through its Zod
     schema; the same declaration again is `'reopened'`, another is a conflict;
   - a part's receipt is size + sha256: the same bytes again are `'repeated'`,
     other bytes a conflict; every part but the last is exactly `chunkBytes`;
   - the first writer of a part wins across processes — its data file is named
     by its hash and its receipt is published by an exclusive `link`, so a
     loser can replace neither;
   - `assemble` checks every receipt and returns the parts in order with a
     concatenating `stream()`; `sweep` removes uploads untouched for
     `staleAfterMs`.
4. **Refusals are `AppError`s with a 4xx status** (`UPLOAD_CONFLICT` 409,
   `UPLOAD_INCOMPLETE` 409, `UPLOAD_TOO_LARGE` 413, …). A handler that lets one
   through answers the client with a typed envelope, and the driver, seeing a
   4xx, does not repeat it — the two halves agree on "final" without either
   importing the other.

## Consequences

- A product's upload is its three endpoints and a few lines in each; the loop,
  the receipts and the retry rule are shared and tested once (network drop,
  lost answer after a stored part, repeated `init`, cancel between parts,
  conflicting part, eight racing writers).
- The spool is a disk directory. Parts on object storage are a different
  store; the rules above are what one would have to keep.
- Part size is the application's latency decision: each part costs a round
  trip.

## Not done

- Parallel parts. Order keeps assembly and progress simple; a link that a
  single stream cannot fill has not been measured.
- Resuming across a page reload (asking the server which parts it holds). Pass
  the same `uploadId` and the stored parts answer `'repeated'`; a query of the
  held parts waits for a consumer that needs to skip their bytes.
