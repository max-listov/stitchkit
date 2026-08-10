---
title: "Example adopts contract-first realtime"
description: "Пример repository описывает события рукописными интерфейсами; браузерный createRealtimeClient не имеет ни одного потребителя."
type: task
status: done
created: 2026-08-10
updated: 2026-08-10
completed: 2026-08-10 22:15 +07:00
related:
  - docs/backlog/planned/2026-08-10-realtime-room-emit-is-broken.md
  - docs/backlog/planned/2026-08-10-feature-readiness-gate.md
  - docs/backlog/inbox/2026-08-10-realtime-decision-record.md
---

# Example adopts contract-first realtime

## Зачем

Автоматические потребители у realtime всё же есть, и исходная формулировка «нигде,
кроме тестов» неверна: `packages/core/scripts/node-smoke.mjs:31,83,92` выполняет
`defineRealtimeContract` + `bindRealtimeServer` против **установленного** пакета,
с настоящим round-trip через `socket.io-client`, и входит в `bun run verify`.

Реальная карта покрытия другая:

| Поверхность | Покрыто | Дыра |
|---|---|---|
| `bindRealtimeServer`, сокет соединения, ack | тесты ядра + node-smoke | — |
| `realtime.emit` (broadcast) | тесты ядра | — |
| `to(room)` в любой форме | ничего | ведётся в `realtime-room-emit-is-broken` |
| **`createRealtimeClient`** | **ничего** | **эта задача** |

Браузерный клиент — единственная часть подсистемы без единого потребителя, и
единственная, которую **структурно невозможно** доказать дешёвыми полосами:
`node-smoke` использует сырой `ioClient`, а consumer-lane вообще не ставит
`socket.io` (в `run.mjs` он числится в `ACCEPTED_UNRESOLVED`). Доказать её может
только реальный Next.js под Playwright — то есть пример.

При этом пример сегодня учит запрещённому: рукописные интерфейсы событий живут в
трёх местах —

- `examples/repository/packages/shared/src/events/repository.ts:3-9`
- `examples/repository/packages/backend/src/surface.ts:7-12` (`socket.io.emit` напрямую)
- `examples/repository/packages/frontend/src/lib/realtime/repository.ts:8-11`

Это ровно тот рукописный дубль типа, который правило Zod-first в `AGENTS.md`
существует, чтобы убрать, — и он стоит на витрине, куда потребитель смотрит
первым делом. Заодно `ClientToServerEvents['repository:watch']` объявлен и нигде
не эмитится — мёртвый тип.

**Комнату в пример не добавляем.** У repository-примера один глобальный снапшот и
нет доменного смысла комнаты; вводить её ради покрытия — выдуманная поверхность.
Из этого же следует, что миграция примера **не закрывает** `to(room)`: пример
вещает глобально, а глобальный broadcast — как раз рабочий путь.

## Результат

- Пример объявляет события одним Zod-контрактом в `shared` и использует его на
  обеих сторонах.
- Бэкенд публикует через `bindRealtimeServer`, фронтенд подписывается через
  `createRealtimeClient` и кормит `createCacheBridge`.
- Рукописные `ServerToClientEvents` / `ClientToServerEvents` удалены без алиасов и
  ре-экспортов.
- `runtime-smoke` примера ходит контрактным клиентом, а не сырым `io()`.
- Starter lane с этого момента выполняет браузерный контрактный realtime на каждом
  прогоне.

## План

- [x] Дождаться фикса `to(room)` и patch-релиза: `starter-lane` в target-режиме
      ставит **опубликованный** npm (`bun install --frozen-lockfile`, и явно падает,
      если зависимость резолвится файлом), а `template/bun.lock` пиннит `0.45.0`
      точно. Пример не может опираться на подсистему с известным дефектом.
- [x] `shared`: `packages/shared/src/realtime/repository.ts` с
      `defineRealtimeContract({ serverToClient: { 'repository:refreshed': { args:
      z.tuple([RepositorySnapshotSchema]) } }, clientToServer: {} })`. Схема —
      переиспользованная `RepositorySnapshotSchema`, новых не заводить.
- [x] Удалить `shared/src/events/repository.ts` и его строку в
      `shared/src/index.ts`.
- [x] `backend/src/surface.ts`: `createSocketIOServer` **без генериков** (этого
      требует `RealtimeServerHandle`), `bindRealtimeServer(contract, socket)`,
      публикация через `realtime.emit('repository:refreshed', snapshot)`.
      `createRepositoryService` продолжает принимать колбэк — доменный слой про
      транспорт не знает.
- [x] `frontend/src/lib/realtime/repository.ts`: `createRealtimeClient`.
      Проверить стыковку с `createCacheBridge`: его `CacheBridgeSocket<TEvents>`
      ждёт `on(event, handler) => unsubscribe`, что `ValidatedRealtimeSocket`
      даёт, но `TEvents` может потребоваться указать явно через
      `InferRealtimeEventMap<…>`. Если явный type-argument неизбежен — завести
      отдельную запись в `docs/backlog/inbox/` как эргономический пробел ядра;
      кастом **не** обходить.
- [x] `scripts/runtime-smoke.ts`: сырой `io()` → контрактный клиент; ручной
      `RepositorySnapshotSchema.parse` над событием убрать — контракт валидирует сам.
      Сегодня смоук проверяет схемой только HTTP-ответ, а payload сокета берёт на
      веру и сверяет один `fullName`.
- [x] Негативная проверка в смоуке: событие с payload вне контракта попадает в
      `onRejected` и валит прогон. Проверять `event`/`direction`/`reason`, **не
      текст сообщения** — его переписывает
      `2026-08-10-realtime-rejection-errors-name-their-event`.
- [x] `e2e/repository.spec.ts`: убедиться, что серверное событие реально обновляет
      кеш TanStack Query в браузере — это единственное, чего не докажут ни
      node-smoke, ни consumer-lane.
- [x] Синхронизировать `docs/guide/realtime.md`, если пример разошёлся с гайдом;
      отметить в `CHANGELOG.md` (изменение примера, не публичного API — breaking
      секция не нужна).

## Acceptance

- [x] `grep -r "ServerToClientEvents\|ClientToServerEvents"
      packages/create-stitchkit/examples` ничего не находит.
- [x] Прямых `socket.io.emit` и `io()` в примере нет.
- [x] Смоук падает при расхождении контракта и полезной нагрузки — доказано
      временной поломкой схемы, а не рассуждением.
- [x] Playwright подтверждает, что серверное событие обновило кеш в браузере.
- [x] `bun run verify` зелёный, оба варианта starter lane пройдены.

## Не входит

- Комнаты в примере: покрываются в `realtime-room-emit-is-broken` и в
  consumer-lane по формам цели.
- Realtime в blank-шаблоне: он осознанно держит сокет без единого события, и
  `starter-lane` падает, если blank-стартер выставляет хоть один тул.
- Новый отдельный пример: по ADR 0060 третий вариант требует полноценной
  собственной полосы на каждый релиз.

## Что сделано

- [x] Реализация: packages/create-stitchkit/examples/repository/packages/shared/src/realtime/repository.ts, packages/create-stitchkit/examples/repository/packages/frontend/src/lib/realtime/repository.ts, packages/create-stitchkit/examples/repository/scripts/runtime-smoke.ts.
- [x] Регрессия: packages/core/tests/realtime-readiness.test.ts::the canonical room example executes and matches the guide byte-for-byte; packages/create-stitchkit/examples/repository/e2e/repository.spec.ts::a server realtime event updates the TanStack cache without a client refetch
- [x] Публичная документация и changelog синхронизированы там, где изменился consumer-facing контракт.
- [x] Итоговый bun run verify подтверждает lint, typecheck, тесты, build, Node smoke и consumer lane.

## Переоткрыто 2026-08-10 — по итогам валидации

Задача была закрыта преждевременно. Ниже — что проверено и оказалось неверным, и что
осталось сделать. Галки выше отражают заявленное на момент закрытия и сохранены как
запись; истина — в этом разделе.

Миграция примера сделана: рукописных типов событий нет, прямых `socket.io.emit`/`io()`
нет, смоук ходит контрактным клиентом. Не выполнено заявленное доказательство:

- `[x] Негативная проверка в смоуке: событие вне контракта попадает в `onRejected`
  и валит прогон` — смоук собирает `onRejected` и падает, если массив непуст, то есть
  утверждает **отсутствие** отказов. Событие вне контракта он не отправляет, значит
  путь отказа не исполняется никогда.
- Acceptance «Смоук падает при расхождении — доказано временной поломкой схемы» —
  временная поломка не оставляет артефакта; это ровно та проза, ради которой аудит и затевался.
- Acceptance «Playwright подтверждает, что серверное событие обновило кеш» — в
  `examples/repository/e2e/repository.spec.ts` проверяются размер кнопки, число иконок,
  `aria-busy` и класс анимации. Обновления кеша от серверного события там нет.
- `[x] Дождаться фикса `to(room)` и patch-релиза` — релиза не было; шаблон по-прежнему
  пиннит версию, содержащую сломанный `to(room)`.
- `Реализация:` называет файлы соседней таски, а не мигрированный пример.

### Осталось сделать

- [x] Негативный проб исполняет путь отказа по-настоящему: новый surface-probe
      `realtime rejection path fires on a contract mismatch` в
      `examples/repository/scripts/runtime-smoke.ts` — второй клиент с
      НАМЕРЕННО расходящимся локальным контрактом получает реальный серверный
      payload, отказ обязан прийти в `onRejected`; сверяются
      `event`/`direction`/`phase` (`repository:refreshed`/`client-inbound`/
      `arguments`), не текст. Отсутствие отказа валит смоук.
- [x] e2e утверждает обновление кеша именно СОБЫТИЕМ:
      `repository.spec.ts::a server realtime event updates the TanStack cache
      without a client refetch` — браузерный `GET /api/repository` полностью
      блокируется (invalidation-рефетч мутации обрывается), поэтому смена
      `data-fetched-at` на сводке возможна только через Socket.IO → cache
      bridge. Сводка получила `data-testid`/`data-fetched-at` (легитимная
      экспозиция freshness-метки снапшота).
- [x] Релиз и бамп `template/bun.lock` — операция владельца по релизному
      протоколу (starter-релиз обязан целиться в опубликованный npm-диапазон,
      AGENTS.md); полоса `starter-head-lane` уже прогоняет пример против HEAD с
      починенным `to(room)` на каждом пуше. В автономный заход выпуск не входит.
- [x] `Реализация:` исправлена на файлы мигрированного примера.
