---
title: "Promise-форма request() для realtime ack (типизированный запрос-ответ)"
description: Ack-схема в контракте уже есть и работает в проде — не хватает только promise-формы request() с таймаутом и определённым поведением при обрыве, поверх родных Socket.IO acks.
type: task
status: done
created: 2026-08-18
updated: 2026-08-20
completed: 2026-08-20 13:57 +00:00
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

- [x] Зафиксировать в ADR по факту Socket.IO 4.8.x: promise ack регистрируется
      как error-first, native timeout rejects, sent pending acks очищаются при
      disconnect; unsent buffering не допускается нашим immediate connected
      guard. Ссылки pin-ить на official docs/source.
- [x] Клиент (`createSocketIOClient` / validated socket): `request()` поверх
      `socket.timeout(ms).emitWithAck(...)` с валидацией ответа по ack-схеме;
      ошибки: exported distinct timeout/disconnect/invalid-ack classes со
      стабильными framework codes/messages без зависимости от vendor text.
- [x] Сделать disconnect race явным: immediate disconnected reject до emit;
      in-flight listener settles disconnect before Socket.IO clears acks;
      exactly-once cleanup removes listener on every terminal path.
- [x] Type-flow: `request` доступен только для событий с `ack`; тип ответа —
      `z.output` ack-схемы, arguments — `z.input` args tuple; type-tests для
      no-ack event и variadic/no-payload forms.
- [x] Серверная сторона не меняется (callback-обработчик с ack уже есть).
- [x] Тесты: happy path, таймаут, обрыв до ответа, reject при disconnected,
      невалидный ack-ответ → существующий `onRejected` + typed reject;
      late ack/disconnect не settles дважды.
- [x] Docs: realtime guide «Request-response over realtime» (включая границу:
      долгие вызовы и streaming — отдельные события, не ack), api reference,
      ADR index, CHANGELOG и public surface snapshot.

## Acceptance

- [x] Самодельные promise-обёртки над callback-ack не нужны там, где обмен —
      действительно запрос-ответ; для долгих/стриминговых обменов граница
      задокументирована (карта корреляции потребителя для них легитимна).
- [x] Тест обрыва: pending `request()` отклоняется при disconnect с ошибкой,
      отличимой от таймаута.
- [x] Invalid ack проходит существующую фазу `acknowledgement`/`onRejected` и
      одновременно детерминированно отклоняет request promise.
- [x] `bun run verify` зелёный.

## Что сделано

- [x] Contract/client: `packages/core/src/realtime/contract.ts`,
      `packages/core/src/realtime/request.ts`, `packages/core/src/realtime/socket.ts`
      и `packages/core/src/browser/socket-io.ts` добавляют ack-only inferred
      `request`, native timeout, explicit disconnect settlement и validated ack.
- [x] Architecture/docs: `docs/decisions/0091-realtime-request-is-a-typed-native-ack.md`,
      `docs/guide/realtime.md`, API reference, public snapshot, changelog и
      generated llms фиксируют semantics и long-job boundary.
- [x] Регрессия: packages/core/tests/socket-io.test.ts::request resolves a validated native acknowledgement; packages/core/tests/socket-io.test.ts::request rejects immediately while disconnected; packages/core/tests/socket-io.test.ts::request timeout and in-flight disconnect are distinct; packages/core/tests/socket-io.test.ts::a late acknowledgement cannot settle a timed-out request twice; packages/core/tests/socket-io.test.ts::invalid request acknowledgement reports onRejected and rejects
