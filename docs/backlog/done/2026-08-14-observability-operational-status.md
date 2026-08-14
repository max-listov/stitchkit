---
title: Наблюдаемое состояние и итог drain для observability
description: Дать приложениям точные метрики bounded sinks и проверяемый результат завершения без собственной обвязки очереди.
type: task
status: done
created: 2026-08-14
updated: 2026-08-14
completed: 2026-08-14 13:47 +00:00
---

# Наблюдаемое состояние observability

## Зачем

`createObservability()` уже ограничивает конкурентную нагрузку, сообщает о drop и
ошибках callbacks и умеет дождаться завершения через `flush()` / `close()`. Но
приложение не может получить текущую загрузку очереди или итоговый результат
drain: `close()` возвращает только `void`. Из-за этого readiness, метрики и
shutdown-лог вынуждены заново считать состояние вокруг framework-owned sinks.

## Результат

- `Observability` отдаёт синхронный immutable snapshot состояния каждого
  включённого surface (`request`, `tools`) и общий агрегат.
- `close()` возвращает финальный отчёт о drain с теми же точными счётчиками и
  длительностью завершения.
- Stitchkit предоставляет факты, но не навязывает readiness-policy, logger или
  shutdown orchestrator потребителя.

## Семантика счётчиков

Нужно один раз определить и закрепить в типах и документации:

- `accepted` — события, принятые sink после применения `filter`;
- `filtered` — намеренно исключённые события, не являющиеся drop;
- `completed` — успешно записанные события;
- `dropped` — события, не принятые из-за закрытия или capacity;
- `failed` — принятые события, чей `write` завершился ошибкой;
- `preparationFailed` — события, которые не удалось спроецировать или
  отфильтровать до admission;
- `preparing`, `pending`, `capacity`, `closed` — текущее операционное состояние.

Инвариант финального отчёта должен быть однозначным и покрытым тестом: каждое
принятое событие после drain завершилось успешно либо ошибкой; filtered и dropped
учитываются отдельно.

## План

- [x] Введены публичные Zod-first типы snapshot и drain report для одного surface
  и агрегированного observability-состояния.
- [x] Внутренний bounded sink расширен точными монотонными счётчиками без второго
  источника состояния и без изменения порядка callbacks.
- [x] Добавлен `observability.getStatus()` с immutable snapshot текущего состояния.
- [x] `observability.close()` стал идемпотентным `Promise<DrainReport>`;
  параллельные вызовы получают один и тот же завершённый результат.
- [x] Сохранена существующая семантика `flush()`, `onDrop`, `onSinkError`, фильтрации
  и отказа принимать события после `close()`.
- [x] Покрыты request-only, tools-only и совместная конфигурация, pressure,
  filtering, sink failure, drop, повторный и параллельный close.
- [x] Обновлены observability guide, API reference, changelog и сгенерированные
  agent-facing docs через штатный генератор.

## Не входит

- Framework default logger или обязательные diagnostic callbacks.
- Автоматическое решение, считать ли pressure или drop причиной failed readiness.
- Управление Prisma, Socket.IO, outbox и другими ресурсами приложения.

## Acceptance

- [x] `getStatus()` не ждёт drain и точно отражает каждую включённую очередь.
- [x] `close()` прекращает admission, дожидается всей принятой работы и возвращает
  финальный immutable отчёт с `durationMs`.
- [x] Отчёт различает request и tools; агрегат математически совпадает с ними.
- [x] Ошибки подготовки и записи учитываются ровно один раз в соответствующих
  счётчиках и сохраняют
  действующий вызов `onSinkError`.
- [x] Capacity drop увеличивает `dropped` ровно один раз и сохраняет действующий
  вызов `onDrop`.
- [x] Существующие приложения, которые игнорируют return value `close()`, продолжают
  компилироваться и работать без изменения поведения.
- [x] Полный `bun run verify` зелёный.

## Что сделано

- [x] **Core:** в `packages/core/src/observability/status.ts` добавлены схемы и
  типы состояния sink, агрегированного status и drain report; в
  `packages/core/src/observability/audit.ts` реализованы единые счётчики,
  `getStatus()` и идемпотентный `close()`.
- [x] **Exports:** новые типы экспортированы через
  `packages/core/src/observability/index.ts`.
- [x] **Tests:** `packages/core/tests/observability-lifecycle.test.ts` покрывает
  `close is idempotent, drains accepted writes and reports closed admission`,
  `separates preparation failures from admitted write failures` и
  `aggregates enabled surfaces without losing their individual capacity` вместе
  с pressure, filtering и diagnostic callback cases.
- [x] **Docs:** обновлены `docs/guide/observability.md`,
  `docs/api/reference.md` и `CHANGELOG.md`; agent-facing docs пересобраны штатным
  build pipeline.
- [x] **Что не делалось:** readiness-policy, framework logger и внешний shutdown
  orchestrator не добавлялись; release, commit, push и deploy не выполнялись.
