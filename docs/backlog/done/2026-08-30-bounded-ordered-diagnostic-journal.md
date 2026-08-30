---
title: Bounded ordered diagnostic journal composition
description: Add one optional ordered local metadata journal with finite memory, file retention and truthful non-durable outcomes.
type: task
status: done
created: 2026-08-30
updated: 2026-08-30
completed: 2026-08-30 07:50 +0000
---

## Why

A long-running application may need a local diagnostic metadata journal without an unbounded
promise chain, concurrent reordering, unlimited disk growth or silent loss. Diagnostic data is
not a durable event store or proof that a remote operation executed. Applications should not have
to copy lifecycle, admission and file-rotation plumbing just to capture bounded local evidence.

The reviewed 0.68.11 surfaces already provide bounded admission, channels and typed observability.
`createBoundedAdmission.run` separates caller wait from physical execution lifetime. The internal
`createBoundedSinkManager` supports bounded pending work and asynchronous preparation, while
public request observability uses request-specific event contracts. A generic ordered rotating
file-journal contract was not identified in that review. This is an extraction proposal, not a
claim that the existing sink is defective: concurrent sink semantics are valid for its purpose.

## Result

`stitchkit/application` exposes one optional `createDiagnosticJournal()` leaf. It validates an
owner-supplied event schema, writes fixed JSONL frames carrying a per-process epoch and contiguous
accepted sequence, serializes through one worker and rotates an operator-injected absolute path
within declared memory and generation limits. It is a diagnostic evidence sink, not a durable
event store, reader, remote transport or second observability framework.

## Audit verdict

| Existing surface | Guarantee it already owns | Missing journal guarantee |
| --- | --- | --- |
| `createBoundedAdmission` | physical-operation concurrency and truthful caller timeout | FIFO retention, byte accounting and file ownership |
| `createBoundedChannel` | ordered item/byte-bounded pending delivery | in-flight byte ownership, serialization, append and rotation |
| request/agent/application sinks | isolated observation and bounded pending count | deterministic write order, byte bound and retained generations |
| managed files | contained finite read/write operations | append lifecycle, journal frames and rotation |

Composition therefore leaves the ordering worker, in-flight accounting, rotation and close state
in every consumer. The missing boundary is proven; the existing primitives remain unchanged.

## Plan

- [x] Audit the latest published package, admission/channel/observability and internal sink code.
      Record existing guarantees versus missing guarantees; distinguish item-count bounds from
      byte bounds, concurrent completion from ordering, and diagnostic capture from durable storage.
- [x] Define one typed owner-supplied event schema and explicit serialized event limit, pending item
      and byte limits, max file bytes and bounded retained generations. Validation and JSON
      serialization are synchronous before admission; the API accepts no asynchronous producer and
      therefore cannot build a hidden preparation queue.
- [x] Assign a per-process epoch and contiguous sequence only to accepted frames. Serialize
      writes/rotation through one worker without an unbounded promise chain. Admission distinguishes
      accepted-to-memory from capacity, closed, failed, invalid and oversized refusal.
- [x] Specify write/rotation/flush failure counters and last safe diagnostic status without recursive
      logging. Truncated tails, restart boundaries and overwrite/retention gaps must be explicit if
      any reader/export surface exists. Do not imply a recovery reader is present when it is not.
- [x] Keep filesystem integration optional and paths operator-injected, not event/caller supplied.
      Define permissions, concurrency ownership and symlink/path assumptions. No arbitrary reads,
      remote upload, payload capture, secrets or mandatory process-wide singleton.
- [x] Define bounded close/flush waits on deadline/cancellation and writer failure. A timed-out
      caller must not release physical write capacity while a write still runs. Avoid recurring
      polling; durability/fsync guarantees or their absence must be stated explicitly.
- [x] Implement only the proven missing leaf, or retain existing APIs and add the tested composition.
      Keep this optional surface out of unrelated browser imports and request schemas.
- [x] Add deterministic pressure, ordering, invalid/oversized input, disk/write error,
      rotation failure, corrupt/partial tail, restart, concurrent close and late-write regressions.
      A throwing observer must not modify application delivery semantics.
- [x] Verify supported Node/Bun and isolated packed consumer/types/import boundaries. Publish exact
      public documentation and release artifacts when code changes; document the supported recipe
      if the audit finds no new API necessary. Do not rename an existing primitive for cosmetics.

## Acceptance

- [x] An evidence-backed matrix states which guarantees existing APIs satisfy and the exact gap,
      or a tested no-gap verdict. A new abstraction is not required merely to close this task.
- [x] Memory, pending work and disk retention remain within declared limits under sustained overload.
- [x] Ordering, dropped/written/failed counters and close behavior are deterministic and observable.
- [x] No claim of durable delivery, exactly-once execution, remote receipt or unlimited replay.
- [x] Generic schemas/examples contain no deployment names, private consumers, internal paths or data.
- [x] Delivery includes exact package version/API and executable tests/recipe, with compatibility and
      migration notes. Existing sink users keep their documented semantics.

## Non-goals

Application authorization, broker routing, remote credit protocols, service discovery, retention of
domain event history, operator fleet inventory and a new background monitoring daemon are excluded.
This optional reuse proposal does not block an application's other packaging or documentation work.

## Что сделано

- В evolving server-only `stitchkit/application` добавлен `createDiagnosticJournal()` с
  owner-supplied Zod schema, синхронной JSON-валидацией/сериализацией, process epoch, contiguous
  accepted sequence и явными item/byte/file/generation limits. Публичные schemas/types экспортированы
  из одного entrypoint; browser-safe entrypoints не получили Node filesystem imports.
- Один FIFO worker удерживает complete serialized bytes до физического settlement. `submit`,
  `flush`, `close` и `getStatus` различают bounded-memory acceptance, completed append, capacity
  refusal, terminal write/rotation/close failure и caller timeout/cancellation; `flush` намеренно не
  обещает `fsync` или durable delivery.
- Local storage canonicalizes operator-controlled parent, refuses final/generation symlinks, owns
  path через exclusive `.lock`, создаёт mode-`0600` files и оставляет неоконченную startup tail
  неизменной в rotated generation. Retention ограничена active file плюс `maxFiles - 1` поколениями.
- ADR 0134, architecture audit matrix, application guide, API reference, README/VISION и
  `CHANGELOG.md` описывают exact API и non-goals. Для самого journal migration не нужна: API
  additive и opt-in. Release target — `stitchkit@0.69.0`, потому что общий Unreleased уже содержит
  отдельно документированные breaking Agent changes; version bump/publication остаются на
  запрошенную отдельно release-команду.
- Регрессия `packages/core/tests/diagnostic-journal.test.ts` —
  `orders accepted frames and refuses pressure before memory grows`,
  `invalid, oversized and byte-capacity refusals consume no sequence`,
  `writer failure is terminal, drains leases and isolates its observer`,
  `caller timeout never releases a physically running write`,
  `cancellation bounds concurrent waiters without cancelling physical close`,
  `rotates finite files, owns one path and marks a partial-tail restart`,
  `rotation failure is explicit and closes without following a symlink generation`.
- Packed proof `packages/core/scripts/consumer-lane/fixtures/node/src/diagnostic-journal.mjs`
  выполняется из опубликованного package layout обоими runtime: `diagnostic journal (bun)` и
  `diagnostic journal (node)`. Public surface фиксирует
  `packages/core/tests/reference-coverage.test.ts` —
  `public surface of stitchkit/application matches its exact snapshot`.
- Gate-blocker из живого Agent TUI устранён в корне: template Biome исключает ignored runtime
  directory `.stitchkit`, поэтому descriptor, SQLite и secrets открытой сессии не форматируются как
  source и не ломают release gate.
- `bun run verify` зелёный на tree `cdee86e5435d`: 1,986 core tests, 15 TUI tests, 30 scaffolder
  tests, 154 root-script tests, 95 template tests, 2 Agent-template tests и 7 PostgreSQL tests;
  build, browser-clean, Node smoke, packed Bun/Node consumers, TUI packed lane, обе starter lanes и
  supervised PM2 lane также зелёные.
