---
title: "Realtime room and broadcast emit is broken"
description: "Валидированный сокет требует on()/off() у emit-only цели, поэтому to(room) падает до отправки события."
type: task
status: done
created: 2026-08-10
updated: 2026-08-10
completed: 2026-08-10 12:50 +00:00
related:
  - docs/backlog/planned/2026-08-10-example-adopts-contract-first-realtime.md
  - docs/backlog/planned/2026-08-10-realtime-rejection-errors-name-their-event.md
  - docs/backlog/inbox/2026-08-10-realtime-decision-record.md
  - docs/backlog/planned/2026-08-10-feature-readiness-gate.md
---

# Realtime room and broadcast emit is broken

## Зачем

Рантайм нарушает собственную опубликованную сигнатуру. `RealtimeServer.to()` и
`RealtimeServerConnection.to()` объявлены как
`Pick<ValidatedRealtimeSocket<…>, 'emit'>` (`packages/core/src/server/realtime.ts:20-22`
и `:35-37`) — то есть тип прямо говорит «эта цель умеет только слать». При этом
фабрика валидированного сокета резолвит подписочные методы жадно, ещё до того как
станет известно, будет ли кто-то подписываться:

```ts
// packages/core/src/realtime/socket.ts:103-105
const onTarget = method(target, 'on');
const offTarget = subscribe ? undefined : method(target, 'off');
const emitTarget = method(target, 'emit');
```

`bindRealtimeServer` передаёт сюда `io.to(room)` и `raw.to(room)` — это
`BroadcastOperator`. У него двенадцать методов (`to`, `in`, `except`, `compress`,
`timeout`, `emit`, `emitWithAck`, `allSockets`, `fetchSockets`, `socketsJoin`,
`socketsLeave`, `disconnectSockets`), но **нет `on` и нет `off`**. Поэтому
`server.to(room)` и `connection.to(room)` бросают
`Realtime target does not implement on()` в момент конструирования обёртки — до
того как дело дойдёт до `.emit`.

Broadcast через `realtime.emit` работает: там цель — сам `Server`, полноценный
emitter. Именно поэтому дефект не проявился ни в одном прогоне.

Область поражения замкнута: в `dist` версии 0.44.0 realtime-слоя нет вовсе,
guard присутствует в опубликованном `stitchkit@0.45.0` (`dist/index.js:655`).
Исправление аддитивное: секция breaking не нужна, номер релиза задаётся общим release-процессом.

Дополнительно тем же однострочником закрывается мёртвый резолв на клиентском
пути: когда передан `subscribe` (`packages/core/src/browser/socket-io.ts:225`),
`onTarget` резолвится и **никогда не используется** — `on()` возвращается раньше,
на `socket.ts:163`.

Покрытия у этого пути нет вообще: в `packages/core/tests/socket-io.test.ts`
realtime-блок (строки 122–252) не вызывает `to()` ни разу, а
`realtime.onConnection(({ events }) => {` (`:145`) даже не деструктурирует `to`.
Совпадения по слову `room` на строках 282–433 принадлежат низкоуровневым тестам
`createSocketIOClient` (handshake query) — другая подсистема.

## Результат

- `server.to(room).emit(...)` и `connection.to(room).emit(...)` публикуют
  валидированное событие вместо исключения.
- Валидированный сокет над emit-only целью конструируется успешно; отсутствие
  `on` становится ошибкой только при реальной попытке подписки.
- Пример из `docs/guide/realtime.md` исполняется как написан.
- Исправление доезжает до стартера, а не только до npm.

## План

- [x] Перенести резолв `on`/`off` внутрь `on()` (ветка без `subscribe`); `emit`
      остаётся жадным — это и есть фактический контракт emit-only цели.
      Проверено на пропатченной копии: доставка работает на обоих room-путях,
      Zod-валидация срабатывает, sender-exclusion семантика `socket.to()`
      сохраняется.
- [x] Убрать мёртвый резолв `onTarget` на пути с `subscribe` в том же изменении.
- [x] Тест: доставка подключённому клиенту через `server.to(room)` и через
      `connection.to(room)` — с реальным вступлением в комнату.
- [x] Тест: контракт отписки не сломан — функция, возвращённая из `on()`,
      прекращает доставку (ленивый резолв трогает `off`).
- [x] Тест: некорректный исходящий payload на room-пути отвергается синхронно
      так же, как на прямом `emit`, и до клиента ничего не доходит.
- [x] Тест: клиентский путь (ветка `subscribe`) не задет регрессией.
- [x] Тест guard'а цели вызывает `createValidatedRealtimeSocket` **напрямую** с
      **непустым** `inbound`-реестром. Через `to()` это невозможно: там
      `inbound: {}` (`server/realtime.ts:55`), поэтому первым сработает
      `Unknown realtime event`, а не guard цели; плюс `.on` отсутствует в типе
      `Pick<…, 'emit'>`.
- [x] `docs/guide/realtime.md`: доопределить `note` в сниппете строки 62 —
      сейчас это свободная переменная, и воспроизвести пример буквально нельзя.
- [x] `CHANGELOG.md`: запись под `### Fixed` в текущем разделе релиза. Секции
      `### ⚠️ Breaking changes` быть не должно — изменение аддитивное, и caret-
      диапазон обязан получить его обычной установкой. Заметка в
      `docs/guide/upgrading.md` не нужна: тот документ покрывает только
      breaking-изменения. Номер релиза задаёт release-процесс, а не эта задача.
- [x] Довести фикс до стартера: `template/package.json` держит caret-диапазон, но
      `template/bun.lock:1120` пиннит точную версию. Без обновления lockfile и
      релиза `create-stitchkit` starter lane продолжит гонять сломанную сборку, а
      каждый свежий скаффолд — ставить её.

## Acceptance

- [x] Тест доставляет событие клиенту, вступившему в комнату, через
      `server.to(room)` и через `connection.to(room)`.
- [x] Тест доказывает, что отписка через возвращённую из `on()` функцию работает.
- [x] Тест доказывает, что валидация исходящих аргументов работает на room-пути.
- [x] Конструирование валидированного сокета над emit-only целью проходит; `on()`
      у такой цели бросает `Realtime target does not implement on()` только в
      момент подписки.
- [x] Тест выполняет ту же последовательность вызовов, что сниппет
      `docs/guide/realtime.md:62` (механизация исполняемых примеров —
      в `feature-readiness-gate`, здесь не дублировать).
- [x] `CHANGELOG.md` содержит запись `### Fixed` и не содержит breaking-секции
      для этого изменения.
- [x] `template/bun.lock` указывает на версию с фиксом, оба варианта starter lane
      зелёные.
- [x] `bun run verify` зелёный.

## Не входит

- Acknowledgements на room-пути: broadcast-ack — это не ack сокета, отдельная тема.
- Любой флаг совместимости (`allowEmitOnly`, `strictTarget`) — это был бы тот самый
  compat-wrapper, который запрещён `AGENTS.md`. Рассматривалась и отвергнута
  отдельная фабрика для emit-only цели: ленивый резолв меньше и точнее.
- Переписывание `docs/guide/realtime.md`: сниппет — это acceptance, а не результат
  работы (кроме доопределения `note`).
- Правило покрытия по формам цели для рантайм-адаптеров — в `feature-readiness-gate`.

## Что сделано

- [x] Реализация: packages/core/src/server/realtime.ts and packages/core/src/realtime/socket.ts.
- [x] Регрессия: packages/core/tests/socket-io.test.ts::emits validated events through server and connection room targets
- [x] Публичная документация и changelog синхронизированы там, где изменился consumer-facing контракт.
- [x] Итоговый bun run verify подтверждает lint, typecheck, тесты, build, Node smoke и consumer lane.
