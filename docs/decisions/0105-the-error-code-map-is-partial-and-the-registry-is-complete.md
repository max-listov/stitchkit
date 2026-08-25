---
title: "ADR 0105: The error-code map is partial, and the registry is complete"
description: "An exhaustive consumer map breaks on an additive release, so `codeMap` is partial and `unmappedCode` owns the rest — while the registry itself is held complete against the source by a check."
type: decision
status: accepted
created: 2026-08-25
updated: 2026-08-25
---

# ADR 0105 — The error-code map is partial, and the registry is complete

## Context

ADR 0026 introduced `STITCH_ERROR_STATUS` and, with it, a promise: a consumer's
map is `Record<StitchErrorCode, AppCode>`, so *"a missing or renamed code becomes
a TypeScript error, not a silent 500"*.

That promise has the wrong sign. The set of framework codes **grows in ordinary
releases** — seven `FILE_*` codes in 0.56.0, `APPLICATION_NOT_ACCEPTING` after
that. Under an exhaustive map every one of those additions stops a consumer's
build on an **additive** release, which is precisely what the caret is supposed
to make safe. 0.56.1 changed `codeMap` to `Partial<…>` for that reason and the
reversal was recorded only in a changelog line: ADR 0026 still promised the
compile error, and the shipped JSDoc on `codeMap` still said *"Exhaustive"*
directly above the `Partial` type — visible to any consumer on hover, because
JSDoc travels in the `.d.ts`.

Meanwhile the registry itself was **incomplete**, which is the failure that
actually costs something. Five codes the framework throws — `WAIT_TIMEOUT`,
`WAIT_FAILED`, `DOWNLOAD_NOT_FOUND`, `VIEW_HTTP_ERROR`,
`OPERATION_NOT_SUCCEEDED` — were absent from it. For those `isStitchErrorCode`
answered `false`, so `createErrorHook` skipped both the `codeMap` lookup and the
`unmappedCode` fallback: the code reached the wire in stitchkit's spelling as
though the project had thrown it. A consumer who had mapped "every framework
code" was silently missing five and had no way to find out.

## Decision

**The map a consumer writes is partial; the registry the framework keeps is
complete.**

- `ErrorHookConfig.codeMap` is `Partial<Record<StitchErrorCode, TWireCode>>`. A
  code left out is not an error — it falls through to `unmappedCode`, which is
  where a project decides what an unknown framework code should look like on its
  wire. Adding a framework code is therefore additive for every consumer.
- `STITCH_ERROR_STATUS` contains **every** code the framework throws, including
  the managed runtime-tool codes that reach a caller through a tool result
  rather than an HTTP response. They are still codes stitchkit authored, and
  remapping them is exactly what the registry is for.
- **Including the codes of adapters stitchkit ships for optional peers** —
  `GRAMMY_WEBHOOK_NOT_ACCEPTING` is in the registry. ADR 0002 keeps a *domain
  model* out of the core; the registry is not one. It is the list of codes this
  framework authors, and its only consumer-facing use is deciding what each one
  looks like on someone's wire. Leaving an adapter's code out does not keep a
  provider name out of a consumer's concern: it makes `isStitchErrorCode`
  answer `false`, so `createErrorHook` skips `codeMap` *and* `unmappedCode` and
  the code reaches the wire spelled `GRAMMY_WEBHOOK_NOT_ACCEPTING` — more
  visible out than in, and unmappable besides.
- Completeness is held by a check, not by review:
  `packages/core/tests/error-registry-completeness.test.ts` scans every
  `new AppError('CODE'` in `packages/core/src` — and every `super('CODE'` inside
  a class that extends it, which is how the two branded adapter errors are
  written — and fails on one the registry does not carry. It found
  `OPERATION_NOT_SUCCEEDED`, which a manual audit of the same question had
  missed.
- The one place that *should* break on a new code is the framework's own
  fixture: `packages/core/tests/error-hook.test.ts` keeps
  `satisfies Record<StitchErrorCode, string>`, so adding a code without deciding
  its wire spelling fails our build rather than a consumer's.

## Consequences

- Supersedes the exhaustiveness clause of ADR 0026. The rest of 0026 — one
  registry, `isStitchErrorCode`, the `code → status` map — stands unchanged.
- Adding a framework error code is a patch-level, additive change: it widens
  `StitchErrorCode`, and nothing in a consumer's tree has to move. It is still
  named in the changelog.
- A consumer who *wants* the compile error can write `satisfies
  Record<StitchErrorCode, AppCode>` on their own object and accept that an
  additive release will stop their build — an informed choice rather than the
  default.
- An enumeration of the codes in prose is a copy that goes stale; the guide now
  says so and points at `Object.keys(STITCH_ERROR_STATUS)`.

## Alternatives considered

- **Keep the exhaustive map and never add codes.** Rejected: the framework grew
  seven codes in one release for good reasons, and freezing the set to protect a
  type shape is the tail wagging the dog.
- **Split "HTTP codes" from "tool codes" into two registries.** Rejected: the
  consumer question is "what did the framework throw and what should it look
  like on my wire", and that question does not care which transport carried it.
  Two registries would put the answer in two places, which is what ADR 0026
  exists to prevent.
