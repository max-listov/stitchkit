---
title: External PostgreSQL for the official starter
description: Remove Docker from generated applications while retaining PostgreSQL and isolated release-lane databases
type: task
status: done
created: 2026-08-08
updated: 2026-08-08
completed: 2026-08-08 09:33 +00:00
---

# External PostgreSQL for the official starter

## Goal

Make the generated application match the production project pattern: Prisma
connects to an ordinary PostgreSQL instance through `DATABASE_URL`; the starter
does not own, package or start a database container.

## Plan

- [x] Remove Compose and the Docker-specific database bootstrap from the template.
- [x] Keep one PostgreSQL/Prisma path and make `DATABASE_URL` the only database runtime boundary.
- [x] Make direct development apply the checked-in migrations before starting PM2.
- [x] Provision an isolated PostgreSQL database inside the repository-owned packed-consumer lane, outside generated application code.
- [x] Provide PostgreSQL to both GitHub Actions starter lanes without changing the generated product.
- [x] Update scaffold guards, environment examples, public docs, changelog and architecture decisions.
- [x] Validate absence of Docker/Compose artifacts and run the affected starter gates.

## Acceptance

- [x] A generated project contains no Compose file, Docker command or Docker-specific environment variable.
- [x] Development and production use the same `DATABASE_URL` contract.
- [x] SQLite or a second database engine is not introduced.
- [x] Packed target and HEAD lanes use isolated databases and clean them after each run.
- [x] Public documentation clearly says PostgreSQL is supplied by the application environment.

## Что сделано

- [x] **Starter:** удалены `template/compose.yaml` и Docker-bootstrap; `_env`, `_env.example`, `packages/config/src/server.ts`, `scripts/dev.ts` и root scripts оставляют единственный PostgreSQL boundary через `DATABASE_URL`.
- [x] **Database lifecycle:** [`scripts/starter-database.ts`](../../../scripts/starter-database.ts) создаёт отдельные временные PostgreSQL database/role для target и HEAD lanes и гарантированно удаляет их после прогона.
- [x] **CI:** [`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml) предоставляет PostgreSQL как infrastructure service обеим starter lanes, не добавляя контейнеры в генерируемое приложение.
- [x] **Guards:** [`packages/create-stitchkit/tests/scaffold.test.ts`](../../../packages/create-stitchkit/tests/scaffold.test.ts) фиксирует отсутствие Compose, Docker-команд и Docker-specific env в published template.
- [x] **Documentation:** обновлены публичные README/CHANGELOG/CONTRIBUTING и добавлен [ADR 0067](../../decisions/0067-the-starter-connects-to-external-postgresql.md) с единым external-PostgreSQL решением.
- [x] **Runtime:** live starter перенесён на host PostgreSQL; два пустых старых starter-контейнера и их volumes удалены, API и web повторно проверены.
- [x] **Validation:** lint, script typecheck, scaffolder tests, template check/tests, target lane и HEAD lane зелёные; каждая lane прошла 27 Chromium/WebKit E2E, временных `sk_lane_*` databases/roles не осталось.
- [x] **Что не делалось:** SQLite, второй database mode, compatibility wrapper, commit, publish и deploy не добавлялись.
