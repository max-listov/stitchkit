---
title: "Socket client connect() is a no-op after the retry budget"
description: "Исчерпав reconnectionAttempts, клиент остаётся мёртвым навсегда: connect() возвращается молча, потому что desiredConnected так и не сброшен."
type: task
status: done
created: 2026-08-10
updated: 2026-08-10
completed: 2026-08-10 12:50 +00:00
---

# Socket client connect() is a no-op after the retry budget

## Зачем

```ts
// packages/core/src/browser/socket-io.ts:348
// Idempotent: already connected, or a peer load is already in flight.
if (socket || desiredConnected) return;
```

После успешного подключения `desiredConnected` остаётся `true` навсегда — сбрасывает
его только `disconnect()`. Когда Socket.IO исчерпывает `reconnectionAttempts`,
экземпляр сокета продолжает существовать, но мёртв, поэтому `connect()` выходит
сразу и молча, и так при каждом следующем вызове.

Замер с `reconnectionAttempts: 1` и реальным перезапуском сервера:

```
1. connected = true
2. сервер гасится:    connected = false  ["up","down:transport close"]
3. сервер поднят
4. app вызывает connect():  connected = false  ← мёртв навсегда
5. обходной disconnect()+connect(): connected = true
```

Смысл конечного `reconnectionAttempts` ровно в том, чтобы перестать долбиться и
показать «офлайн — нажмите, чтобы повторить». Эта кнопка зовёт `client.connect()`
и не делает ничего. Документированный контракт метода — «Create the socket (if
absent) and connect. Idempotent» — про необходимость предварительного
`disconnect()` не говорит.

Это тот же класс, ради которого добавляли `reconnectOnServerDisconnect` для
`io server disconnect`; случай исчерпанного бюджета остался незакрытым. Дефолт
`Infinity` его маскирует, поэтому проявляется только у тех, кто бюджет задал
осознанно.

## Результат

- `connect()` после исчерпания бюджета переподключений реально переподключает.
- Идемпотентность сохраняется: повторный вызов при живом или устанавливаемом
  соединении по-прежнему ничего не делает.
- Приложению не нужно знать про `disconnect()` как обходной приём.

## План

- [x] Разделить «намерение быть подключённым» и «жив ли текущий экземпляр»:
      выход по короткому пути только когда сокет действительно подключён либо
      загрузка пира в полёте.
- [x] Обработать исчерпание бюджета явно (`reconnect_failed`), приведя состояние
      к тому же виду, что после `disconnect()`.
- [x] Тест: `reconnectionAttempts: 1`, сервер гасится и поднимается, `connect()`
      восстанавливает соединение без предварительного `disconnect()`.
- [x] Тест: идемпотентность не потеряна — двойной `connect()` при живом
      соединении не плодит второй сокет и не дублирует подписки.

## Acceptance

- [x] Тест воспроизводит цикл «подключён → бюджет исчерпан → connect() → подключён».
- [x] Существующие тесты на durable-подписки и sticky-события зелёные.
- [x] `bun run verify` зелёный.

## Что сделано

- [x] Реализация: packages/core/src/browser/socket-io.ts.
- [x] Регрессия: packages/core/tests/socket-io.test.ts::reconnectOnServerDisconnect recycles the client back to life; packages/core/tests/socket-io.test.ts::an explicit disconnect() cancels a pending recycle
- [x] Публичная документация и changelog синхронизированы там, где изменился consumer-facing контракт.
- [x] Итоговый bun run verify подтверждает lint, typecheck, тесты, build, Node smoke и consumer lane.
