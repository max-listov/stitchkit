---
title: close() закрывает admission рантайма и означает одно и то же везде
description: submit() после close() успевает записать durable-прогон и разрешить accepted; плюс два текста всё ещё утверждают снятую гарантию.
type: task
status: done
tags: [agent-runtime, lifecycle, docs]
created: 2026-08-24
updated: 2026-08-24
completed: 2026-08-24 19:49 +00:00
---

# close() закрывает admission рантайма и означает одно и то же везде

## Зачем

`AgentRuntime.close()` — чистый делегат: `close: (options) => coordinator.close(options)`.
Своего gate у слоя рантайма нет, `submit()` ни на что не смотрит. Проверено чтением:
в `runtime.ts` нет ни одного присваивания `closed`.

Значит после `await runtime.close()` порядок такой: preflight выполняется, durable
input/run **записывается в store**, `ticket.accepted` разрешается, и только потом
закрытый координатор отказывается запускать исполнение. Итог — очередь с записанной
работой и без исполнителя, то есть ровно то состояние, ради недопущения которого
координатор и закрывается. Та же гонка возможна у `resume()` и `recover()`.

Второй предмет здесь же, потому что это тот же контракт: `CHANGELOG.md:62` и
`docs/guide/upgrading.md:1408` до сих пор утверждают «`close()` never returns while a
run is in flight». После перехода на structured result это неверно, и потребитель,
двигающийся по changelog механически, получает два взаимоисключающих ответа.

## Результат

- Admission закрывается **на уровне рантайма**, атомарно, до ожидания активных прогонов.
- `submit`, `resume` и `recover` после начала close отказывают, ничего не записав.
- Гонка «close во время идущего preflight/store admission» заканчивается либо принятым
  и исполненным прогоном, либо отказом — но никогда записью без исполнителя.
- Про `close()` в репозитории ровно одно утверждение, и оно верное.

## План

- [x] Gate на уровне рантайма: `submit`/`resume`/`recover` отказывают после close.
- [x] Закрытие admission до ожидания активных прогонов.
- [x] Регрессия: packages/core/tests/agent-runtime-close-admission.test.ts::submit after close writes nothing and refuses
- [x] Регрессия: packages/core/tests/agent-runtime-close-admission.test.ts::a close arriving inside a preflight still stops the write that follows it
- [x] Одна каноническая запись про `close()`; снятые утверждения исправлены там,
      где они стоят, а не дописаны рядом.

## Acceptance

- [x] После `close()` ни один путь приёма не оставляет durable-работу без исполнителя.
- [x] `rg "never returns while a run"` не находит утверждения, противоречащего коду.
- [x] `bun run verify` зелёный.

## Что сделано

- [x] Gate на уровне рантайма (`packages/core/src/agent-runtime/runtime.ts`):
      `admissionClosed` ставится в `close()` **до** любого await, `submit`,
      `resume` и `recover` отказывают после него.
- [x] Гонка закрыта второй проверкой — сразу после `preflight` и **перед**
      `acceptInputAndAssignRun`. Preflight это сетевой вызов к провайдеру, и
      close, пришедший внутрь него, иначе сопровождался бы этой записью.
- [x] Обратная сторона правила сохранена: admission, уже записанный до close,
      исполняется, а не бросается — отказывать там значило бы бросать ровно ту
      работу, ради которой gate и заводится.
- [x] `packages/core/tests/agent-runtime-close-admission.test.ts` — пять
      случаев, каждый читает **store**, а не только промис: submit/resume/
      recover после close, close внутри preflight, и принятый до close прогон.
- [x] Проверено мутацией: со снятой строкой `admissionClosed = true` краснеют
      четыре из пяти.

### Одна каноническая запись про close()

- [x] `CHANGELOG.md` — старое утверждение помечено как **superseded** прямо
      там, где стояло, с указанием, почему оно никогда не было верным при
      заданном force-бюджете.
- [x] `docs/guide/upgrading.md` — то же в разделе про переименование бюджетов.
- [x] `rg "never returns while a run"` находит только цитаты внутри новой
      breaking-записи, где фраза приведена как снятая.

### Проверка

- [x] `bun run verify` — exit 0.

## Поправка от 2026-08-25 (сторонний аудит)

Acceptance этой задачи был шире её теста. Тест закрывает сессию **во время
preflight** — то есть до durable-записи, — и поэтому не видит перехода, в
котором заявка уже прошла проверку и находится внутри
`acceptInputAndAssignRun`: координатор её ещё не знает, `close()` возвращает
`settled: true, remaining: 0`, а store после этого создаёт queued-прогон без
исполнителя.

Окно закрыто барьером незавершённых заявок и двумя регрессиями на сам переход:
`2026-08-25-close-waits-for-admissions-in-flight.md`.
