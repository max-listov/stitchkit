---
title: Application kernel public proof and guides
description: Prove the new entrypoints through exports, docs and packed Bun/Node consumers without releasing them.
type: task
status: done
created: 2026-08-23
updated: 2026-08-23
completed: 2026-08-23 17:39 +00:00
related: docs/backlog/done/2026-08-23-managed-application-kernel.md
---

# Application kernel public proof and guides

## Зачем

A new server-only framework surface is incomplete until its package graph, Node declarations,
optional peers, migration path and packed consumer behavior are proven together.

## Результат

- Explicit package exports/build entries for neutral application and isolated grammY adapter.
- API reference, architecture guide, migration example and generated consumer docs agree.
- Packed Bun/Node lanes exercise lifecycle, schedules, projections, signals and peer isolation.

## План

- [x] Add exact `stitchkit/application` and `stitchkit/application/grammy` exports, build entries,
      declarations, optional peer metadata and reference coverage.
- [x] Extend minimal and Node packed consumers with a managed application; prove no grammY install or
      static JS/declaration reachability from the neutral entrypoint.
- [x] Add a dedicated packed grammY fixture with only required peers and real current grammY types;
      prove adapter import failure is isolated when the peer is absent.
- [x] Add a real Node child-process SIGTERM path that becomes ready, drains admitted work and reports
      the inferred application result.
- [x] Document resource authoring, state table, shutdown order, schedules, projection, provider
      ownership and anonymized before→after responsibility deletion.
- [x] Update ADR 0102/index, Vision, Roadmap, architecture/guide/API reference, upgrading guidance,
      README entrypoint inventory and generated `llms.txt` routing where applicable.
- [x] Add `[Unreleased]` changelog without version/release mutation.

## Acceptance

- [x] Browser-safe root remains free of the application runtime.
- [x] Neutral Node consumer needs neither Bun types nor grammY.
- [x] Packed provider consumer exercises real grammY types through only the adapter entrypoint.
- [x] Minimal provider example contains no manual signal loop, raw interval, admission waiter set or
      resource-close fan-out; those mechanics are declarations plus domain callbacks.
- [x] Full authorized repository gate is green; no commit, push or release is performed.

## Что сделано

### Public surface и документация

- [x] `packages/core/package.json`, `packages/core/src/application.ts` and
      `packages/core/src/application-grammy.ts` define the neutral/provider export boundary and
      optional peer metadata.
- [x] `docs/api/reference.md`, `docs/guide/application-kernel.md`,
      `docs/architecture/application-kernel.md`, `docs/decisions/0102-managed-application-kernel.md`,
      `README.md`, `ROADMAP.md`, `docs/VISION.md` and `CHANGELOG.md` describe one current surface.
- [x] `packages/core/scripts/consumer-lane/run.mjs` proves packed minimal, full, Node and grammY
      consumers; the Node child-process signal proof is in
      `packages/core/scripts/consumer-lane/fixtures/node/src/application-signal-parent.mjs` and
      `packages/core/scripts/consumer-lane/fixtures/node/src/application-signal-child.mjs`.
- [x] `packages/core/src/internal/fetch-port.ts` and `packages/core/src/server/node.ts` prevent a
      port-0 Node listener from exposing a WHATWG Fetch-blocked ephemeral URL.

### Проверка

- [x] `packages/core/tests/reference-coverage.test.ts` dynamically checks every export and exact
      snapshot for both `stitchkit/application` entrypoints; their expected names are recorded in
      `packages/core/tests/fixtures/public-surface.json`.
- [x] Регрессия: packages/core/tests/application-kernel.test.ts::validates the whole graph before side effects; packages/core/tests/application-grammy.test.ts::polling readiness comes from onStart and shutdown awaits the retained completion.
- [x] Регрессия: packages/core/tests/node.test.ts::recognizes ports that Fetch blocks before network I/O; packages/core/tests/no-fixed-ports.test.ts::every server in tests/ and scripts/ uses port 0.
- [x] `bun run verify` completed with exit `0`: 1532 core tests, 24 scaffolder tests, 40 repository
      script tests, build, Next SSR, Node HTTP/Socket.IO smoke, all packed consumer lanes and both
      starter browser matrices were green. No Git index, commit, push, tag, publish or deploy action
      was performed.
