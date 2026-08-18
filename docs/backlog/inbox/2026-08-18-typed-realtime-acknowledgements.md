---
title: "Promise-форма request() для realtime ack (типизированный запрос-ответ)"
description: Ack-схема в контракте уже есть и работает в проде — не хватает только promise-формы request() с таймаутом и определённым поведением при обрыве, поверх родных Socket.IO acks.
type: task
status: inbox
created: 2026-08-18
updated: 2026-08-18
---

# Promise-форма `request()` для realtime ack

## Зачем

Первая версия этой задачи предполагала спроектировать ack-слой — живой
потребитель поправил фактом: **ack уже есть и работает в его проде на 0.52.0**
(`realtime/contract.ts`: `ack?`, фаза `acknowledgement`, коды
`invalid-acknowledgement-value` / `missing-acknowledgement`; событие вида
`'rpc:call': { args, ack: AdmissionSchema }`). Проверено по коду — так и есть:
валидируются обе стороны, callback-форма полная.

Реальный пробел вдвое уже: **нет promise-формы**. `emitWithAck` /
`socket.timeout(ms)` в обёртке не используются нигде; потребитель строит
промис поверх callback сам — таймаут, обрыв, «решить ровно один раз».

Границы (важно): `request()` — для настоящего запрос-ответа. Долгий вызов
(минуты) и streaming в ack-таймере жить не должны — это отдельные события, и
карта корреляции у потребителя для таких кейсов остаётся осознанно. Мы не
строим RPC — типизируем родной механизм (ADR 0008).

## Результат

- Клиент: `request(event, payload, { timeoutMs }) => Promise<Ack>` для событий
  с `ack`-схемой; таймаут и обрыв — детерминированные, различимые ошибки;
  disconnected в момент вызова → немедленный reject (согласовано с задачей
  «честный emit»), не зависание до таймаута.
- Валидация ack-ответа — через существующую фазу `acknowledgement` и
  `onRejected`, ничего нового.
- Событие без `ack`-схемы в `request()` не проходит по типам.

## План

- [ ] Мини-research в ADR: семантика Socket.IO `timeout().emitWithAck` при
      disconnect до ответа и при реконнекте (v4.x) — поведение `request()`
      определить словами до кода.
- [ ] Клиент (`createSocketIOClient` / validated socket): `request()` поверх
      `socket.timeout(ms).emitWithAck(...)` с валидацией ответа по ack-схеме;
      ошибки: `REQUEST_TIMEOUT`-класс для таймаута, отличимый класс для обрыва.
- [ ] Type-flow: `request` доступен только для событий с `ack`; тип ответа —
      `z.infer` ack-схемы; type-tests.
- [ ] Серверная сторона не меняется (callback-обработчик с ack уже есть).
- [ ] Тесты: happy path, таймаут, обрыв до ответа, reject при disconnected,
      невалидный ack-ответ → `onRejected` + reject.
- [ ] Docs: realtime guide «Request-response over realtime» (включая границу:
      долгие вызовы и streaming — отдельные события, не ack), api reference,
      CHANGELOG.

## Acceptance

- [ ] Самодельные promise-обёртки над callback-ack не нужны там, где обмен —
      действительно запрос-ответ; для долгих/стриминговых обменов граница
      задокументирована (карта корреляции потребителя для них легитимна).
- [ ] Тест обрыва: pending `request()` отклоняется при disconnect с ошибкой,
      отличимой от таймаута.
- [ ] `bun run verify` зелёный.
