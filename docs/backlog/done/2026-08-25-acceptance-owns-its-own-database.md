---
title: acceptance:local изолирует процессы, но пишет в базу деплоймента
description: Harness наследует DATABASE_URL из .env; repository-смок делает POST refresh, и Prisma upsert уходит в обычную, потенциально production, базу.
type: task
status: done
tags: [starter, gates, safety]
related: docs/backlog/done/2026-08-25-gates-do-not-deploy.md
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25 05:04 +00:00
---

# acceptance:local изолирует процессы, но пишет в базу деплоймента

## Зачем

Harness убрал деплой из гейтов и изолировал процессы: свой `PM2_HOME`,
эфемерные порты, свой allowlist. Базу он не изолировал — берёт `DATABASE_URL`
из `.env` как есть (`acceptance-local.ts:63`).

Это не теория: смок repository-примера делает два `POST /api/repository/refresh`,
а `github-cache.ts:71` выполняет Prisma `upsert`. То есть **гейт пишет данные**
в ту базу, которую называет `.env`. Если там production — гейт пишет в
production.

И это прямое расхождение с тем, что задача обещала в «Результате»: «одноразовая
база». Обещание записано, реализация — нет.

## Результат

- Harness работает против собственной базы: `ACCEPTANCE_DATABASE_URL`.
- Fail-closed: если она не задана или совпадает с `DATABASE_URL` деплоймента —
  отказ до старта ролей, с точной строкой, что вписать.
- Миграции применяются **только** в acceptance-базу; база деплоймента не
  трогается ни чтением схемы, ни записью.
- `_env.example` называет её так же, как `DATABASE_URL`: имя подставляется из
  identity, чтобы свежий скаффолд проходил список гейтов сверху вниз.

## План

- [x] `ACCEPTANCE_DATABASE_URL` в схеме переменных и в `_env.example`.
- [x] Проверка неравенства с `DATABASE_URL` — до любого запуска.
- [x] `db:deploy` внутри harness'а против acceptance-базы.
- [x] Заголовок `acceptance-local.ts` описывает то, что он делает на самом деле.

## Acceptance

- [x] Гейт не может записать в базу деплоймента.
- [x] Свежий скаффолд проходит список гейтов сверху вниз.
- [x] `bun run verify` зелёный.

## Что сделано

### Starter — gate

- [x] `packages/create-stitchkit/template/scripts/acceptance-database.ts` —
      `resolveAcceptanceDatabase(env)`: fail-closed on an unset variable and on
      one naming the deployment's database, comparing host, port and database
      name rather than the raw string.
- [x] `scripts/acceptance-local.ts` resolves it **before** the deployment's URL
      is copied into the child environment, sets `DATABASE_URL` to the
      acceptance URL for every role, deletes `ACCEPTANCE_DATABASE_URL` from that
      environment, and runs `runDeclaredReleaseSteps(environment)` — the
      declared migrations, against the acceptance database only.

### Starter — configuration and docs

- [x] `_env.example` carries `ACCEPTANCE_DATABASE_URL`; `local-env.ts` renders
      the identity into it like `DATABASE_URL` (`<slug>_acceptance`).
- [x] `scripts/tooling-env.ts` declares it optional, with why.
- [x] `README.md` and `AGENTS.md` no longer claim "no gate applies a migration";
      both say which database the gate uses and why it is separate.

### Регрессия

- [x] `packages/create-stitchkit/template/scripts/acceptance-database.test.ts` —
      5 cases: a distinct database passes; an unset variable is refused with the
      pasteable line; the same database written with other credentials or with
      an implicit port is still refused; a non-URL is named.
- [x] Живой прогон: `bun run acceptance:local` в dev-workspace шаблона —
      EXIT=0, 33 e2e passed, база `stitchkit_starter_acceptance` создана
      миграцией гейта, `stitchkit_starter` не тронута; отказ без переменной
      проверен отдельно и печатает строку для вставки.

### Что не сделано

- [x] Гейт не создаёт базу сам: её создаёт `prisma migrate deploy` (проверено
      пробником — создаёт при наличии `CREATEDB`). Отдельная админ-логика в
      шаблоне была бы вторым способом делать то, что уже делает declared
      migration command.
