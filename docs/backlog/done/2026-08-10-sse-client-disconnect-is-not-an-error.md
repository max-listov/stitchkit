---
title: "SSE client disconnect is not a server error"
description: "streamSSE не обрабатывает отмену потока, поэтому обычное закрытие вкладки печатает [stitchkit] unhandled error."
type: task
status: done
created: 2026-08-10
updated: 2026-08-10
completed: 2026-08-10 12:50 +00:00
---

# SSE client disconnect is not a server error

## Зачем

У `ReadableStream` в `packages/core/src/server/stream.ts:18` нет обработчика
`cancel()`. Когда клиент отключается, следующий `controller.enqueue` бросает;
`catch` зовёт `normalizeError(err)`, а тот безусловно пишет `console.error`
(`internal/errors.ts:97`) — и затем код кладёт в тот же мёртвый контроллер ещё
одно сообщение, получая второе исключение уже из `start()`.

Замер, одинаковый на Bun и Node 24:

```
--- клиент отключился ---
[stitchkit] unhandled error: TypeError [ERR_INVALID_STATE]: Invalid state: Controller is already closed
generator finally ran at pull 2
```

Каждое закрытие вкладки или уход со страницы во время стрима токенов LLM пишет
строку уровня error. Алертинг, построенный на `[stitchkit] unhandled error` —
единственном маркере «что-то действительно сломалось» — срабатывает на штатном
поведении, а настоящий отказ генератора перестаёт быть отличимым от рутины.

Ресурсы при этом не текут, и это проверено, а не предположено: протокол
`for await` вызывает `.return()` генератора, когда `enqueue` бросает, поэтому
finally отрабатывает. Уборка случайна, но реальна.

## Результат

- Отключение клиента завершает поток тихо и не попадает в лог как ошибка сервера.
- Настоящая ошибка внутри генератора по-прежнему логируется и остаётся видимой.
- Финализация генератора выполняется явно, а не как побочный эффект брошенного
  `enqueue`.

## План

- [x] Добавить `cancel()` в `ReadableStream`: пометить поток отменённым и
      финализировать генератор.
- [x] Перед каждой записью проверять, что поток ещё жив; на отменённом — выходить,
      а не писать повторно.
- [x] Отличать отмену от отказа: отмену не пропускать через `normalizeError`.
- [x] Тест: клиент рвёт соединение на середине потока → `console.error` не вызван,
      генератор финализирован.
- [x] Тест: генератор бросает настоящую ошибку → она по-прежнему нормализуется и
      логируется.

## Acceptance

- [x] Отключение клиента не порождает ни одной записи `[stitchkit] unhandled error`.
- [x] Тест на реальную ошибку генератора остаётся зелёным и доказывает, что путь
      логирования не заглушен целиком.
- [x] `bun run verify` зелёный.

## Что сделано

- [x] Реализация: packages/core/src/server/stream.ts.
- [x] Регрессия: packages/core/tests/stream.test.ts::client cancellation closes the generator without emitting an error event
- [x] Публичная документация и changelog синхронизированы там, где изменился consumer-facing контракт.
- [x] Итоговый bun run verify подтверждает lint, typecheck, тесты, build, Node smoke и consumer lane.
