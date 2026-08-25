---
title: "Status and probe endpoints stop publishing internal topology"
description: "createApplicationHealthHandler отдаёт полный ApplicationSnapshot вместе с графом внутренних зависимостей на ручку, которую гайд предлагает выставить публично, а комментарий и гайд трижды называют её sanitized."
type: task
status: done
created: 2026-08-24
updated: 2026-08-24
completed: 2026-08-24 13:13 +0000
related:
  - docs/decisions/0102-managed-application-kernel.md
---

# Status and probe endpoints stop publishing internal topology

## Зачем

`packages/core/src/application/health.ts:38` и `:52` отдают
`Response.json(snapshot)`, где `snapshot` — целиком `ApplicationSnapshot`
(`application/schemas.ts:58-70`). В нём:

- `resources[].id` и `resources[].dependsOn` — **весь граф внутренних
  зависимостей приложения**;
- `resources[].state` и `resources[].health` — состояние каждого внутреннего
  ресурса по отдельности;
- `epoch` — UUID процесса;
- `admission.accepted / completed / pending` — счётчики трафика.

Санитизации в подсистеме нет ни одной строки. При этом:

- `health.ts:26` — doc-комментарий: «with **only the sanitized** application
  snapshot»;
- `docs/guide/application-kernel.md:130` — «the **neutral** lifecycle/health
  snapshot»;
- `:148` — «`status` always returns the current **sanitized** snapshot».

Тот же гайд (`:141-146`) показывает пример монтирования этих обработчиков на
публичные `/status`, `/ready`, `/live` и перекладывает ответственность на
потребителя: «do not put secrets or raw provider failures in the response». То
есть три текста утверждают свойство, которого в коде нет, и рекомендуют
выставить ручку наружу.

Внутренняя непоследовательность подтверждает, что счётчики считаются
непубличными: `packages/core/tests/application-events.test.ts:29` явно
утверждает `expect(JSON.stringify(event)).not.toContain('acceptedOperations')`
для delivery-канала. На HTTP те же величины отдаются целиком.

Это прямо нарушает правило проекта: наружу уходит generic-ответ, причина живёт
во внутренних полях и логах.

## Результат

- Пробы (`readiness`, `liveness`) отдают ровно то, что нужно оркестратору:
  код состояния и минимальный стабильный документ без имён ресурсов, графа
  зависимостей, идентификатора процесса и счётчиков.
- `status` отдаёт внешнюю проекцию, а не внутренний снапшот; состав проекции
  определён явной схемой, а не тем, что случайно оказалось в `getSnapshot()`.
- Полные детали остаются доступны внутри — через `getSnapshot()` и telemetry —
  и не теряются.
- Три ложных утверждения в комментарии и гайде приведены в соответствие с кодом.
- Тело HTTP-ответа зафиксировано тестом: сегодня
  `application-health.test.ts:8-41` проверяет только коды, `Retry-After` и одно
  поле, поэтому повесить регрессию на санитизацию сейчас негде.

## План

- [x] Определить внешнюю проекцию снапшота отдельной Zod-схемой: что уходит на
      `status`, что на пробы, и почему именно это.
- [x] Перевести `createApplicationHealthHandler` и
      `createApplicationOperationalHandlers` на проекцию.
- [x] Решить и записать, остаётся ли возможность отдать полный снапшот на
      явный opt-in (по образцу `includeInternalCause` из 0.58.0) или полный
      снапшот доступен только программно.
- [x] Привести `health.ts:26`, `application-kernel.md:130` и `:148` в
      соответствие с фактическим поведением.
- [x] Добавить регрессии на **тело** ответа: проба и `status` не содержат
      `dependsOn`, идентификаторов ресурсов, `epoch` и счётчиков admission;
      полный снапшот по-прежнему доступен через `getSnapshot()`.
- [x] Внести breaking-запись в `CHANGELOG.md` под `[Unreleased]` и раздел
      миграции в `docs/guide/upgrading.md`.

## Acceptance

- [x] `JSON.stringify` ответа любой из трёх ручек не содержит `dependsOn`.
- [x] Ответ пробы не содержит идентификаторов внутренних ресурсов, `epoch` и
      счётчиков admission.
- [x] `getSnapshot()` продолжает возвращать полные данные, и это закреплено
      тестом.
- [x] Ни одно утверждение о «sanitized»/«neutral» в коде и гайде не расходится с
      поведением.
- [x] Регрессия падает, если проекцию убрать и вернуть `Response.json(snapshot)`.
- [x] `bun run verify` зелёный.

## Не входит

- Изменение состава `ApplicationSnapshot` как внутренней структуры: он остаётся
  полным, меняется только то, что публикуется наружу.

## Что сделано

- [x] `packages/core/src/application/schemas.ts`: `ApplicationStatusProjectionSchema`
      и `projectApplicationStatus()` — публикуемая проекция несёт `id`,
      `lifecycle`, `health`, `ready`, `capturedAt` и **счётчики** ресурсов
      (`total`/`ready`/`degraded`/`failed`), но ни одного идентификатора
      ресурса, ни `dependsOn`, ни `epoch`, ни счётчиков admission.
- [x] `packages/core/src/application/health.ts`: обе фабрики отдают проекцию;
      doc-комментарий больше не утверждает «sanitized» про сырой снапшот, а
      объясняет, что именно не публикуется и где это доступно.
- [x] Экспорт проекции из бареля `stitchkit/application` и строка в
      `docs/api/reference.md`.
- [x] `docs/guide/application-kernel.md`: два ложных утверждения («neutral
      snapshot», «sanitized snapshot») заменены точным описанием состава
      проекции и указанием, что полный снапшот доступен только через
      `getSnapshot()` в процессе.
- [x] Регрессия: packages/core/tests/application-health.test.ts::a published response never carries the internal resource topology; packages/core/tests/application-health.test.ts::the published projection still answers the question a probe is asked
- [x] Зубы регрессии проверены прогоном с временно возвращённым
      `Response.json(snapshot)`: падает два теста из четырёх, после отката —
      четыре из четырёх зелёные.
- [x] `CHANGELOG.md` под `[Unreleased]` несёт `### ⚠️ Breaking changes` с
      before → after; раздел `## Unreleased migration: published application
      status` написан по конвенции, введённой в задаче про гейт upgrade-гайда.
- [x] Снапшот публичной поверхности обновлён (80 → 83 экспорта).

## Что не сделано

- [x] Opt-in на публикацию полного снапшота по HTTP не введён: эти маршруты
      предназначены для внешней доступности, и опция, возвращающая топологию,
      воспроизвела бы исходный дефект. Полный снапшот доступен программно.
