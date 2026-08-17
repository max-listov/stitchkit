---
title: listToolNames читает поверхность имён прямо из контрактов
description: Снапшот тул-поверхности не должен требовать построенных ServiceDef — имена и expose детерминированно выводятся из контракта, стабы-хендлеры и фабрика-лазейка не нужны.
type: task
status: done
created: 2026-08-17
updated: 2026-08-17
completed: 2026-08-17 14:53 +00:00
---

# `listToolNames` из контрактов

## Зачем

`listToolNames(surface)` принимает `ToolSurfaceDefinition`
([list-names.ts](../../../packages/core/src/tools/list-names.ts)), то есть
требует **сервисов**. Но всё, что он возвращает — имена, kind, transports —
детерминированно выводится из контракта: `toolName` / деривация из
prefix+key, `expose`, multipart/raw-исключения. Хендлеры для этого не нужны.

Реальная цена у потребителя: чтобы снапшотить тул-поверхность, он строит
сервисы из стабов `() => never` по реестру контрактов, где `scope` расширен до
`string`. На `string`-скоупе scoped-фабрика — ошибка компиляции **by design**,
поэтому рядом появилась вторая, нетипизированная фабрика
`createImplement<RuntimeContext>()` с комментарием «не для транспорта».
Комментарий — просьба, а не гарантия: эту фабрику можно импортировать для
настоящего сервиса и вернуть себе нетипизированный контекст — ровно ту дверь,
которую 0.50 закрыл.

## Результат

- Способ получить тот же `ToolNameEntry[]` из контрактов напрямую: перегрузка
  `listToolNames(contracts)` либо отдельный `listContractToolNames` — решить по
  тому, что даёт более честные типы (перегрузка на union аргумента может
  размыть диагностику).
- Результат байт-в-байт совпадает с текущим `listToolNames` от собранных
  сервисов на тех же контрактах — зафиксировано тестом-сверкой.
- Существующая сигнатура не меняется — аддитивно.

## План

- [x] Выделить из `collectToolSurface` часть, не читающую хендлеры (имя, kind,
      expose, multipart/raw-фильтры), либо научить её принимать контрактный
      вход.
- [x] Публичный API + строка в `docs/api/reference.md` + снапшот
      `public-surface.json`.
- [x] Тест: `listToolNames(implement-нутые сервисы)` ===
      `listContractToolNames(те же контракты)` на контракте с `toolName`,
      деривацией, multipart, raw и CLI-only expose.
- [x] CHANGELOG `### Added`.

## Acceptance

- [x] Снапшот тул-поверхности возможен без единого хендлера и без
      `createImplement<RuntimeContext>()`-лазейки.
- [x] Сверка двух путей зелёная.
- [x] `bun run verify` зелёный.

## Что сделано

- [x] `contractOnlyService(contract)` —
      `packages/core/src/server/implement.ts`: стаб-хендлеры строятся **внутри**
      фреймворка и проходят через настоящий `bindContract`, поэтому методы —
      те же объекты, что видят реальные маунты; листинг не может разойтись по
      построению. Экспорт модульный, в entrypoint не выведен.
- [x] `listContractToolNames(contracts)` —
      `packages/core/src/tools/list-names.ts`, экспорт из `stitchkit/tools`.
      Выбран отдельный именованный API, не перегрузка: union-аргумент размыл бы
      диагностику.
- [x] Тесты: `packages/core/tests/list-tool-names.test.ts::listContractToolNames > matches listToolNames over the implemented services, byte for byte`
      и `…::listContractToolNames > covers a streaming multipart contract without any handler`.
- [x] `docs/api/reference.md` строка; `public-surface.json`; CHANGELOG
      `### Added`. Аддитивно.
