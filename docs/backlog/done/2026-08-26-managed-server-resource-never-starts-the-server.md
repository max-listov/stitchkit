---
title: managedServerResource never starts the server, and says nothing about it
description: Its start() is empty and the server thunk is only called during shutdown, so a graph that delegates server creation to it produces a live process with a healthy log and no listener at all.
type: task
status: done
created: 2026-08-26
updated: 2026-08-26
completed: 2026-08-26 10:57 +00:00
---

## Зачем

`managedServerResource` читается как ресурс, который владеет сервером. Его `start()`
**пустой**, а `config.server` вызывается только внутри `ensureShutdown`, то есть на
фазах `stopAdmission` / `drain` / `close` / `force`.

```js
// dist/application.js
return defineManagedResource({
  id: config.id,
  start() {},                       // ← ничего
  stopAdmission(context) { ensureShutdown(context) },
  ...
})
```

Это законно и даже описано одной строкой в JSDoc — «adapt an existing managed server
without duplicating its shutdown state machine». Но **тип принимает thunk**:

```ts
readonly server: ManagedServerHandle<TRuntime> | (() => ManagedServerHandle<TRuntime>)
```

и `() => createServer(...)` читается ровно наоборот — как ленивое создание сервера
после готовности зависимостей. Именно так его и хочется применить, потому что это
единственный способ выразить «порт связывается после того, как поднялась база».

## Как воспроизводится

```ts
const app = createApplication({
  id: 'svc',
  resources: [
    database,
    managedServerResource({
      id: 'http',
      dependsOn: ['database'],
      server: () => createServer(config),   // тип это разрешает
    }),
  ],
})
await app.start()
```

`app.start()` резолвится. Снапшот — `health: 'healthy'`, `ready: true`, все ресурсы
`ready`. Лог рапортует успешный старт. **На порту не слушает никто**: `createServer`
не вызван и не будет вызван до первой фазы остановки.

Ни ошибки, ни предупреждения, ни `degraded`. Отказ обнаруживается снаружи — первым
запросом, который не дошёл, или healthcheck'ом, если он есть.

## Почему это дороже, чем выглядит

Отказ **молчаливый и полный**: приложение уверенно докладывает готовность, которой
нет. Это ровно тот класс дефектов, против которого ядро и заведено — «ready
перестаёт быть тавтологией». Здесь тавтологией становится сам снапшот.

Вторая половина проблемы — в документации. `application-migration-recipes.md`
покрывает database, long-running poller, queue consumer и operational publisher.
**Managed HTTP server — главный ресурс любого web-бэкенда — не покрыт ни одним
рецептом**, хотя именно у него правило владения контринтуитивно. В guide он
показан внутри `resources` рядом с уже созданным `server`, взявшимся из ниоткуда,
и нигде не сказано, что к моменту сборки графа сервер обязан слушать.

## Результат

- Либо `managedServerResource` умеет создавать сервер (фаза `start`), либо тип
  перестаёт принимать thunk и в API остаётся только уже поднятый handle.
- Порядок «порт связывается после готовности зависимостей» выражается штатно, а не
  спредом чужого ресурса поверх своего `start`.
- В рецептах появляется managed HTTP server с явным указанием, кто создаёт сервер и
  в какой момент.

## Обходной путь у потребителя (чтобы было видно цену)

Работает, но это композиция руками:

```ts
let handle: ManagedServerHandle<T> | null = null
const shutdown = managedServerResource({ id: 'http', server: () => handle! })
const http = defineManagedResource({
  ...shutdown,                       // фазы остановки — его
  dependsOn: ['database', 'socket-io'],
  start: () => { handle = createServer(config) },   // старт — свой
})
```

Спред чужого ресурса поверх своего `start` — не то, что должен изобретать каждый
потребитель с HTTP-сервером, то есть практически каждый.

## План

- [x] `ManagedServerResourceConfig.server` принимает handle или thunk; thunk может быть
      асинхронным (`() => Handle | Promise<Handle>`) — «связать порт после готовности базы»
      обычно требует `await`.
- [x] `start()` разрешает `server`: вызывает thunk, сохраняет handle, публикует его как
      значение ресурса (см. задачу о передаче значений) — сервер существует к моменту,
      когда снапшот говорит `ready`.
- [x] `ensureShutdown` использует handle, полученный в `start`. Если его нет — ресурс
      стартовал чужим `start` поверх спреда, как в обходном пути потребителя, — падает
      обратно на вызов thunk. Старое поведение сохраняется, обходной путь не ломается.
- [x] Фазы остановки без handle и без thunk-результата — no-op: закрывать нечего.
- [x] Рецепт «managed HTTP server» в `docs/guide/application-migration-recipes.md`: кто
      создаёт сервер и в какой момент.
- [x] Заметка в `docs/guide/application-kernel.md` рядом с примером `resources`.

## Acceptance

- [x] Тест: граф `database → managedServerResource({ server: () => createServer(...) })`,
      после `app.start()` порт реально слушает (запрос доходит), thunk вызван ровно один раз.
- [x] Тест: при отсутствии фикса тот же тест красный (фальсификация ревертом).
- [x] Тест: eager-handle форма ведёт себя как раньше.
- [x] Тест: обходной путь со спредом (`{...managedServerResource(...), start: ...}`)
      по-прежнему останавливает сервер.

## Что сделано

### Core

- [x] `ManagedServerResourceConfig.server` принимает handle или thunk, sync и async —
      `packages/core/src/application/server-resource.ts`.
- [x] `start()` вызывает thunk, сохраняет handle и публикует его как значение ресурса;
      возвращаемый тип `ManagedServerResource<TRuntime>` несёт `Promise<{ value: handle }>`,
      поэтому зависимые читают сервер типизированно.
- [x] Путь остановки различает три случая: handle из `start`; `start` был и ничего не дал
      (thunk упал — закрывать нечего); `start` не запускался вовсе (спред поверх чужого
      `start` — thunk остаётся единственным способом добраться до сервера).
- [x] Вызов `shutdown` остаётся синхронным, когда handle уже в руках. Первый вариант делал
      его асинхронным всегда, и админ-гейт закрывался на микротаск позже — поймано тестом
      `application-reported-health.test.ts`.

### Docs

- [x] Рецепт «Managed HTTP server» — `docs/guide/application-migration-recipes.md`,
      исполняемый источник `packages/core/scripts/consumer-lane/fixtures/minimal/src/application-migration-recipes.ts`
      (реальный порт, запрос доходит после `start()`, закрыт после `shutdown()`).
- [x] `docs/guide/application-kernel.md` — минимальная композиция теперь создаёт сервер
      ресурсом, а не берёт его из ниоткуда.
- [x] ADR 0115 + строка в `docs/decisions/README.md`.
- [x] `CHANGELOG.md` 0.67.0, breaking-секция; migration в `docs/guide/upgrading.md`.

### Tests

- [x] `packages/core/tests/application-server-resource-start.test.ts` — 5 тестов:
      «a thunk binds the port during start, not during shutdown» (реальный порт, реальный
      запрос — снапшот не является доказательством, потому что сломанная версия давала
      healthy), «an async thunk is awaited before dependants start», «an already-created
      handle is adopted exactly as before», «the spread workaround still shuts its own
      server down», «a thunk that throws fails the startup instead of reporting healthy».
- [x] Фальсификация: `start()` без создания сервера → 4 из 5 красные.

### Что не сделано

- [x] Тип не перестал принимать thunk — выбран первый из двух путей результата: ресурс
      умеет создавать сервер. Второй путь (убрать thunk из типа) закрыл бы возможность
      выразить «порт связывается после готовности зависимостей» штатно.
