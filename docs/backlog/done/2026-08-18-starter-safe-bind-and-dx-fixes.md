---
title: "Starter: безопасный bind-дефолт и DX-фиксы по фидбеку потребителя"
description: BIND_HOST с дефолтом 127.0.0.1 вместо прибитого 0.0.0.0, честные порты в логах dev, проверка занятости портов, preflight для start без build, docs-нота про db:* — и подъём catalog на ^0.52.0.
type: task
status: done
created: 2026-08-18
updated: 2026-08-18
completed: 2026-08-18 10:40 +07:00
---

# Starter: безопасный bind-дефолт и DX-фиксы

## Зачем

Агент, поднявший production-сервис из `create-stitchkit`, дал фидбек. Проверка
по реальному шаблону подтвердила четыре пункта:

1. **`0.0.0.0` прибит в трёх местах** — `packages/backend/src/index.ts:30`,
   `ecosystem.config.cjs:22`, `ecosystem.dev.config.cjs:7`. Безопасный бинд
   требует правки кода в нескольких файлах; небезопасный получается сам.
   Для сервиса с внешним IP это опасный дефолт.
2. **dev-лог врёт про порты** — `scripts/dev.ts:60-61` печатает литеральные
   `3210/3211` вместо значений env; занятый порт даёт «Web: …» на чужой сервис.
3. **`start` без `build`** падает голым `Module not found "dist/index.js"` без
   подсказки собрать.
4. **`prisma migrate deploy` напрямую не работает** (datasource url живёт в env
   db-пакета — дизайн Prisma) — нигде не сказано «только через `bun run db:*`».

Заодно: catalog шаблона всё ещё `^0.50.0`, фреймворк на npm — `0.52.0`
(0.51/0.52 аддитивны) — новые приложения не получают текущий API.

## Результат

- Сгенерированное приложение по умолчанию слушает только `127.0.0.1`;
  `0.0.0.0` — осознанный opt-in одной env-переменной `BIND_HOST`.
- `bun run dev` печатает URL из env и падает с внятной ошибкой, если порт занят
  чужим процессом (перезапуск собственных pm2-процессов не ломается).
- `start` без сборки говорит «run `bun run build` first».
- README/AGENTS.md шаблона фиксируют «БД — только через `bun run db:*`».
- Новые приложения получают stitchkit `^0.52.0`.
- create-stitchkit `0.3.3` опубликован (tag `create-stitchkit-v0.3.3`).

## План

- [x] `packages/config/src/server.ts`: `BIND_HOST: z.string().min(1).default('127.0.0.1')`.
- [x] `packages/backend/src/index.ts`: `hostname: env.BIND_HOST`, лог из env.
- [x] `ecosystem.config.cjs` + `ecosystem.dev.config.cjs`: `--hostname process.env.BIND_HOST ?? '127.0.0.1'` (оба — разрешённые env-boundaries `check:authored`).
- [x] `scripts/dev.ts`: прокинуть `BIND_HOST` в `developmentEnvironment`; печать Web/API URL из env; проверка занятости `API_PORT`/`WEB_PORT` через пробный `Bun.listen`, пропускаемая когда собственные pm2-приложения (`{slug}-backend-dev`/`{slug}-frontend-dev` по `pm2 jlist`) уже зарегистрированы — путь reload.
- [x] `_env.example`: строка `BIND_HOST=127.0.0.1` с комментарием про opt-in `0.0.0.0`.
- [x] `packages/backend/scripts/ensure-built.ts` + `"start": "bun scripts/ensure-built.ts && bun dist/index.js"`; тот же preflight в корневом `pm2:prod` (плюс `scripts` добавлен в include backend-tsconfig — гейт покрытия требует).
- [x] README + AGENTS.md шаблона: нота «Prisma только через корневые `bun run db:*`».
- [x] catalog `stitchkit: ^0.52.0`, обновлены `template/bun.lock` и node_modules.
- [x] Осознанно **оставлен** `${WEB_PORT:-3210}` fallback в `frontend/package.json` — он нужен только прямому запуску внутри пакета, pm2-пути его не используют, а `:?`-expansion в Bun shell не гарантирован.
- [x] Гейты: verify (включая starter-lane) + starter-head-lane.
- [x] Релиз: bump `packages/create-stitchkit/package.json` → 0.3.3, roll его CHANGELOG, tag `create-stitchkit-v0.3.3`, довести до зелёного CI и npm.

## Acceptance

- [x] `rg '0\.0\.0\.0'` по шаблону — только fallback-значение/комментарий/доки, ни одного прибитого бинда.
- [x] Тест на новый инвариант: `tests/scaffold.test.ts::runs PM2 apps from their package directories` пинит отсутствие `'0.0.0.0'` в обоих ecosystem-конфигах, `process.env.BIND_HOST ?? '127.0.0.1'`, `hostname: env.BIND_HOST` в backend и `BIND_HOST=127.0.0.1` в `_env.example`. Порт-гейт `dev.ts` рантайм-тестом не покрыт: он требует живого pm2 и занятых портов — путь исполняется в обеих стартер-лейнах (`bun run dev` в сгенерированном приложении).
- [x] `bun run verify` (exit 0) и `bun run starter-head-lane` (exit 0) зелёные локально.
- [x] `create-stitchkit@0.3.3` на npm, CI зелёный; в опубликованном tarball шаблона `BIND_HOST` присутствует.

## Что сделано

- Template (безопасный бинд):
  - [x] `template/packages/config/src/server.ts` — `BIND_HOST` с дефолтом `127.0.0.1`
  - [x] `template/packages/backend/src/index.ts` — `hostname: env.BIND_HOST`, лог слушателя из env
  - [x] `template/ecosystem.config.cjs`, `template/ecosystem.dev.config.cjs` — `process.env.BIND_HOST ?? '127.0.0.1'`
  - [x] `template/_env.example` — `BIND_HOST=127.0.0.1` + комментарий про осознанный opt-in
- Template (DX):
  - [x] `template/scripts/dev.ts` — Web/API URL из env; `assertPortsAvailable`: пробный `Bun.listen` на `API_PORT`/`WEB_PORT`, скип при уже зарегистрированных собственных pm2-процессах (`pm2 jlist`)
  - [x] `template/packages/backend/scripts/ensure-built.ts` (новый) + `start`-скрипт backend и корневой `pm2:prod` с preflight; `template/packages/backend/tsconfig.json` include `scripts`
  - [x] `template/README.md`, `template/AGENTS.md` — ноты про `BIND_HOST` и «Prisma только через `bun run db:*`»
- Версии:
  - [x] `template/package.json` catalog → `^0.52.0`, `template/bun.lock` пересобран (`+ stitchkit@0.52.0`)
  - [x] `packages/create-stitchkit/package.json` → 0.3.3, `packages/create-stitchkit/CHANGELOG.md` — секция `[0.3.3]`
- Тесты:
  - [x] `packages/create-stitchkit/tests/scaffold.test.ts::runs PM2 apps from their package directories` — пины нового инварианта (см. Acceptance)
- Не сделано (осознанно):
  - [x] `next start` без build не преflight-ится — фронтовый кейс не из фидбека, `next` сам даёт понятную ошибку про отсутствие `.next`
  - [x] Проверка занятости портов при генерации проекта — scaffolder не знает целевую машину, гарантия была бы ложной; проверка живёт в `bun run dev`
