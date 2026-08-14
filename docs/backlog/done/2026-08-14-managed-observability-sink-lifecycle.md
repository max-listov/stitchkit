---
title: Управляемый lifecycle observability sinks
description: Сделать ошибки, переполнение и graceful drain fire-and-forget sinks наблюдаемыми через onSinkError, onDrop, flush и close
type: task
status: done
created: 2026-08-14
updated: 2026-08-14
completed: 2026-08-14 07:21 +00:00
---

# Управляемый lifecycle observability sinks

## Зачем

`createObservability` запускает sink fire-and-forget и намеренно проглатывает все ошибки,
чтобы audit не ломал business request. Это правильная isolation boundary, но сейчас
consumer не узнаёт о потере события, не может детерминированно дождаться writes в тестах и
не может drain-ить их при graceful shutdown. Медленный sink также создаёт неограниченное
число pending promises.

Stitchkit должен управлять только in-process delivery lifecycle. Durable outbox, retry
policy и конкретное хранилище принадлежат adapter/application layer; переносить их в core
нельзя.

## Результат

- Ошибка sink доступна через изолированный `onSinkError`.
- Количество принятых, но незавершённых writes ограничено; drop из-за capacity или закрытого
  lifecycle наблюдаем через `onDrop`.
- `flush()` детерминированно ждёт все события, принятые до вызова.
- `close()` прекращает приём новых событий, drain-ит принятые и является idempotent.
- Request/tool call по-прежнему никогда не ждёт sink и не падает из-за него.

## Публичный API

```ts
const observability = createObservability({
  request: {
    maxPending: 1_000,
    write: persistRequestEvent,
    onSinkError: ({ error, event }) => reportAuditFailure(error, event),
    onDrop: ({ reason, event, pending }) => reportAuditDrop(reason, event, pending),
  },
  tools: {
    maxPending: 1_000,
    write: persistToolEvent,
    onSinkError: reportToolAuditFailure,
    onDrop: reportToolAuditDrop,
  },
});

await observability.flush();
await observability.close();
```

`reason` имеет закрытый union `'capacity' | 'closed'`. Callback errors также
изолируются и не создают unhandled rejection. `maxPending` имеет безопасный framework
default и валидируется fail-first при creation.

## Семантика lifecycle

- Emitter создаётся один раз на sink, а не заново на каждое событие.
- `filter` и sanitisation выполняются до зачисления; отфильтрованное событие не занимает
  pending slot.
- Принятый write учитывается до settlement независимо от success/failure.
- При capacity новые события drop-ятся явно; уже выполняющиеся writes не отменяются.
- `flush()` фиксирует текущую generation и ждёт её settlement; новые события после вызова
  относятся к следующей generation.
- `close()` атомарно закрывает admission, затем ждёт все accepted generations.
- Sink failure доставляется в `onSinkError`, но `flush/close` не заменяют её повторным throw.
- Durable adapter может использовать `(traceId, spanId, source, toolPhase)` как
  idempotency identity; core не выполняет retry и не хранит события на диске.

## План

- [x] Вынести один internal sink manager для request/tools вместо повторного
      `createEmitter` на событие.
- [x] Добавить `maxPending`, `onSinkError` и `onDrop` в sink config с точными public types.
- [x] Реализовать bounded pending tracking без блокировки request/tool completion path.
- [x] Добавить generation-aware `flush()` и idempotent `close()` в `Observability`.
- [x] Защитить все callbacks и projection/sanitisation от sync throw и rejected promise;
      unhandled rejection невозможен.
- [x] Сохранить отдельные request/tools policies и единый aggregate lifecycle.
- [x] Документировать shutdown order: остановить HTTP/MCP admission, дождаться active calls,
      затем `observability.close()`.
- [x] Добавить пример durable-outbox adapter interface без Prisma/PostgreSQL dependency и
      без framework retry implementation.
- [x] Обновить observability guide, API reference, generated LLM docs и changelog.

## Тестовая матрица

- [x] Sync throw и async rejection sink вызывают `onSinkError` ровно один раз и не ломают
      наблюдаемый request/tool call.
- [x] Throw/rejection внутри `onSinkError` и `onDrop` не создаёт unhandled rejection.
- [x] Deferred writes доказывают, что `flush()` ждёт принятые события.
- [x] Events, принятые после начала `flush()`, относятся к следующей generation.
- [x] Capacity точно ограничивает pending writes и вызывает `onDrop('capacity')`.
- [x] `close()` блокирует admission, сообщает `onDrop('closed')`, drain-ит pending и
      безопасен при повторном вызове.
- [x] Filtered events не занимают slots и не вызывают callbacks.
- [x] HTTP и tool sinks с разной скоростью/лимитами не блокируют друг друга.
- [x] Fake timers/controlled promises подтверждают отсутствие dangling tasks после close.

## Acceptance

- [x] Ни одна sink failure или dropped event больше не теряется молча при настроенных callbacks.
- [x] Pending in-process writes имеют конечную, настраиваемую верхнюю границу.
- [x] Тесты и graceful shutdown могут дождаться всех accepted writes.
- [x] Observability остаётся неблокирующей и failure-isolated относительно business path.
- [x] Core не содержит retry engine, durable queue, Prisma, database или storage policy.
- [x] Existing RequestEvent projection и app-level `afterHandle`/`onError` enrichment не
      дублируются новым projection hook.
- [x] Полный `bun run verify` зелёный.

## Не входит

- Result-aware projection hook: существующие lifecycle hooks, endpoint `meta` и
  `setRequestDimensions` уже закрывают доменную enrichment-задачу.
- Durable persistence, replay scheduler, exponential backoff и cross-process ordering.
- Гарантия доставки после process crash без consumer-owned outbox.

## Что сделано

- [x] **Sink manager:** `packages/core/src/observability/audit.ts` содержит общий bounded
      manager для request/tool sinks с отдельными лимитами и failure-isolated callbacks.
- [x] **Public lifecycle:** `createObservability()` возвращает generation-aware `flush()` и
      idempotent `close()`; configs поддерживают `maxPending`, `onSinkError` и `onDrop`.
- [x] **Isolation:** sync throws и rejected promises из filter/projection/write/diagnostics
      не ломают business path и не создают unhandled rejection.
- [x] **Тесты:** `packages/core/tests/observability-lifecycle.test.ts` —
      `reports sync and async sink failures once without failing flush`,
      `flush waits only for the generation admitted before it starts`,
      `bounds pending writes and reports capacity drops`,
      `close is idempotent, drains accepted writes and reports closed admission`,
      `diagnostic callback failures stay isolated`.
- [x] **Гейты:** полный `bun run verify` прошёл; retry/outbox/storage policy в core не добавлены.
