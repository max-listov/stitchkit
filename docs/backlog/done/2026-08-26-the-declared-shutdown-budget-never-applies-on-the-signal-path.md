---
title: The declared application shutdown budget never applies on the signal path
description: bindProcessSignals parses its options through a schema with defaults, so the application always receives concrete numbers and the budget declared on createApplication is unreachable for every process that stops through a signal.
type: task
status: done
created: 2026-08-26
updated: 2026-08-26
completed: 2026-08-26 10:57 +00:00
---

## Зачем

`ApplicationConfig.shutdown` введён с явной целью — и она записана в JSDoc самого поля:

> one number for "how long this application may take to stop", not two that can
> disagree.

Ядро эту цель честно исполняет:

```js
const parsed = ApplicationShutdownOptionsSchema.parse({
  gracePeriodMs: requested.gracePeriodMs ?? shutdownBudget.gracePeriodMs,
  forceTimeoutMs: requested.forceTimeoutMs ?? shutdownBudget.forceTimeoutMs,
  ...
})
```

Фолбэк на объявленный бюджет срабатывает, когда `requested.*` — `undefined`.

**`bindProcessSignals` делает так, что `undefined` там не бывает никогда:**

```js
const budgets = ShutdownOptionsSchema.omit({ signal: true }).parse(options.shutdown ?? {})
...
result = await handle.shutdown({ ...budgets, signal: controller.signal })
```

`ShutdownOptionsSchema` — серверная схема с дефолтами:

```js
gracePeriodMs:     z.number().int().nonnegative().default(30000),
forceTimeoutMs:    z.number().int().nonnegative().default(5000),
retryAfterSeconds: z.number().int().nonnegative().default(5),
```

`parse({})` возвращает **заполненный** объект. Значит `requested.gracePeriodMs`
всегда определён, ветка `?? shutdownBudget` недостижима, и в силе оказываются
дефолты серверной схемы, а не бюджет приложения.

## Как воспроизводится

```ts
const app = createApplication({
  id: 'svc',
  resources,
  shutdown: { gracePeriodMs: 5_000, forceTimeoutMs: 1_000 },  // объявлено
})
bindProcessSignals(app)                                       // shutdown не передан
// SIGTERM → приложение останавливается с 30_000 / 5_000, а не с 5_000 / 1_000
```

Тот же результат при `bindProcessSignals(app, { onComplete })` — достаточно не
передать `shutdown`, а его и не хочется передавать: он уже объявлен на приложении.

## Почему это важнее, чем «просто дефолты»

1. **Мёртв ровно тот путь, которым останавливается production.** Бюджет применяется
   только к rollback упавшего `start()` — у него нет call site, и это задокументировано.
   Штатная остановка процесса идёт через сигнал, и там бюджет не действует.
2. **Расхождение молчаливое.** Приложение объявило 5 с, оператор рассчитал по ним
   supervisor-таймаут (`kill_timeout`, `TimeoutStopSec`), а процесс живёт до 35 с и
   получает `SIGKILL` посреди объявленного слива. Объявление выглядит соблюдённым.
3. **Единственное лечение сегодня — продублировать числа в двух местах**, то есть
   завести ровно те «два числа, которые могут разойтись», против которых поле и
   вводилось. Потребитель, у которого они совпали с дефолтами схемы, не заметит
   вообще ничего — до первого изменения бюджета.

## Результат

- `bindProcessSignals` без `shutdown` не подменяет объявленный бюджет приложения:
  либо схема применяется с `.partial()`, либо ключи, которых не было во входе, не
  доезжают до `handle.shutdown`.
- `retryAfterSeconds` в этой ветке тоже стоит пересмотреть: ядро его не принимает
  (`ApplicationShutdownOptionsSchema` его не содержит), а связывание сигналов его
  подставляет — он просто отбрасывается на границе.
- В guide рядом с примером `bindProcessSignals(app, { shutdown: … })` сказано, что
  произойдёт, если `shutdown` не передать.

## Проверка

Тест, который сегодня красный: приложение с `shutdown: { gracePeriodMs: 5_000 }`,
привязанное через `bindProcessSignals(app)` без опций, при сигнале обязано
остановиться по объявленному бюджету, а не по дефолту серверной схемы.

## План

- [x] `bindProcessSignals` пересылает только переданные ключи. Механизм не тот, что был
      записан в плане: `.partial()` не снимает `.default()` (проверено пробником), поэтому
      взят второй вариант из «Результат» — ключи, которых не было во входе, не доезжают до
      `handle.shutdown`. Значения, которые
      передали, по-прежнему валидируются на этапе привязки; ключи, которых не было, не
      появляются в объекте и не доезжают до `handle.shutdown`.
- [x] `retryAfterSeconds` больше не подставляется по умолчанию: он передаётся только если
      его действительно передали. Ядро его не принимает, сервер — принимает.
- [x] Заметка в `docs/guide/application-kernel.md` о том, что происходит, если `shutdown`
      в `bindProcessSignals` не передан.

## Acceptance

- [x] Тест: `createApplication({ shutdown: { gracePeriodMs: 5_000, forceTimeoutMs: 1_000 } })`
      + `bindProcessSignals(app)` без опций → сигнал → `shutdown` получает объявленный бюджет.
- [x] Тест: при отсутствии фикса тот же тест красный (фальсификация ревертом).
- [x] Тест: `bindProcessSignals(server)` для обычного managed-сервера ведёт себя как раньше —
      сервер применяет собственные дефолты схемы.
- [x] Тест: явно переданный `shutdown` в `bindProcessSignals` по-прежнему перекрывает бюджет
      приложения, и невалидное значение по-прежнему падает на привязке, а не на сигнале.

## Что сделано

### Core

- [x] `bindProcessSignals` валидирует `options.shutdown` схемой (сообщения об ошибке и
      момент отказа не изменились), но пересылает только те ключи, которые вызывающий
      действительно передал — `packages/core/src/server/process-signals.ts`.
- [x] `retryAfterSeconds` больше не подставляется по умолчанию.

### Docs

- [x] `docs/guide/application-kernel.md` — раздел о том, откуда берётся бюджет на
      сигнальном пути и что делает `bindProcessSignals(app)` без `shutdown`.
- [x] `CHANGELOG.md` 0.67.0 + migration в `docs/guide/upgrading.md` с прямым указанием
      сверить supervisor-таймаут.

### Tests

- [x] `packages/core/tests/application-signal-budget.test.ts` — 6 тестов: объявленный
      бюджет применяется на сигнале (читается изнутри графа как `deadlineAt - now()`);
      непереданный бюджет не доезжает до `shutdown()` вовсе; переданный по-прежнему
      перекрывает; один переданный ключ не утаскивает второй; невалидный бюджет падает на
      привязке; набор бюджетных ключей схемы совпадает с тем, что пересылается поимённо.
- [x] Фальсификация: возврат прежнего parse → 3 красных.

### Что не сделано

- [x] `.partial()` из плана не применён: пробником установлено, что `.partial()` не
      снимает `.default()` — зод всё равно заполняет ключи. Реализовано через явную
      пересылку только переданных ключей; расхождение при добавлении четвёртого бюджета
      ловится тестом, а не ревью.
