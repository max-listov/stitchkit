---
title: "PostgreSQL and Prisma proof for the agent store primitives"
description: "Доказать framework reducer и history codec на настоящих PostgreSQL transactions без ORM dependency в published core."
type: task
status: done
created: 2026-08-22
updated: 2026-08-22
completed: 2026-08-22 19:52 +0000
related:
  - docs/backlog/inbox/2026-08-22-agent-runtime-production-persistence-ergonomics.md
  - docs/backlog/inbox/2026-08-22-framework-owned-agent-store-reducer.md
---

# PostgreSQL and Prisma proof for the agent store primitives

## Зачем

Memory store доказывает reducer semantics, но не transaction rollback, competing
writers или restart reconstruction. Нужен официальный executable adapter proof,
не Prisma dependency внутри framework runtime.

## Результат

- Repository fixture реализует primitives через Prisma/PostgreSQL transaction.
- Runtime state хранится отдельно в opaque encoded payload без duplicate full message snapshot;
  message rows остаются отдельным canonical history source.
- Один reusable conformance manifest выполняется против memory и PostgreSQL adapter.
- CI/local lane создаёт disposable database и гарантированно удаляет её.

## План

- [x] Добавить isolated Prisma schema/client fixture и adapter implementation.
- [x] Подключить disposable PostgreSQL lifecycle без hardcoded product database.
- [x] Запустить shared conformance scenarios на real transactions.
- [x] Проверить duplicate admission, competing CAS, stale checkpoint, terminal
      race, coalescing, compaction rollback and restart recovery.
- [x] Документировать fixture как reference, не как framework ORM commitment.

## Acceptance

- [x] Published `stitchkit` не получает Prisma/PostgreSQL runtime dependency or peer.
- [x] Two concurrent writers produce one CAS winner and no partial history write.
- [x] Transaction failure leaves both state version and message history unchanged.
- [x] New adapter instance reconstructs recoverable work from persisted rows.
- [x] Test uses disposable database and leaves no database/role behind.
- [x] Packed/public boundary remains framework-only; fixture cannot enter tarball.

## Конвейер 2/2

- [x] Plan validation incorporated from umbrella round.
- [x] Implementation correctness review passed.
- [x] Implementation ergonomics review passed.

## Что сделано

- [x] **Fixture:** `examples/agent-store-prisma/adapter.ts` реализует public driver
      contract через serializable Prisma/PostgreSQL transactions и bounded recovery table.
- [x] **Regression:** `examples/agent-store-prisma/adapter.test.ts`, cases
      `serializes competing admissions into one winner and one durable duplicate`,
      `serializes a terminal race and reports the current run revision`,
      `rolls compaction history and state back together` и
      `reconstructs bounded recovery after a fresh adapter process`.
- [x] **Lifecycle:** `scripts/agent-store-postgres-lane.ts` создаёт и удаляет
      disposable role/database; real PostgreSQL proof завершился 6/6 с exit 0.
