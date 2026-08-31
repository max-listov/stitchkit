---
title: A declared option must be load-bearing, and nothing checks that it is
description: Six shipped defects share one shape — a typed, documented option is accepted and then silently not honoured on some path. Types cannot catch it by construction, so a gate has to.
type: task
status: done
created: 2026-08-31
updated: 2026-08-31
completed: 2026-08-31 14:33 +00:00
---

## Зачем

Six defects, one shape: **an option is accepted, typed, documented — and on some
path simply not honoured.** Nothing fails; the caller's declaration is quietly
discarded.

| release | what was accepted and not honoured |
| --- | --- |
| 0.70.5 | managed shutdown did not drain its own HTTP stream sources |
| 0.70.4 | the configured Socket.IO transport allowlist was not enforced on Bun — `transports: ['websocket']` did not refuse polling |
| 0.70.3 | a route group's declared `onError` was never dispatched |
| 0.70.0 | a failed mounted tool returned a successful-looking `{ error }` value |
| 0.67.0 | `managedServerResource` never started the server it was handed a thunk for |
| 0.67.0 | `bindProcessSignals` substituted schema defaults over the application's declared budget |

Four of the six landed in the last three releases. This is a form, not a
coincidence.

**Types cannot catch it by construction.** A type proves an option can be
*passed*. It says nothing about whether passing it changes anything. Every one
of the six typechecked, and 0.70.4 typechecked while looking like a security
policy and not being one.

The cost is no longer theoretical: the one real consumer pins the exact
framework version and moves to head the same day, so a defect of this class
reaches a production application within hours of publication.

## Результат

- A gate enumerates the fields of the public configuration surfaces
  mechanically — through the TypeScript checker, the same way
  `reference-coverage.test.ts` enumerates exports — and refuses a field with no
  registered test that exercises it.
- The registry names a real test; a renamed or deleted test turns the gate red,
  so the registry cannot drift into a list of claims.
- The first red run is itself the deliverable: it names every option currently
  shipping with no proof that it does anything.

## Selection rule — options whose failure mode is silence

Not every option earns this. A wrong `port` fails loudly on the first request;
a wrong `transports` allowlist, an ignored `onError` and an unapplied
`gracePeriodMs` all look exactly like success. The gate covers the second kind
first, which is also where all six defects lived:

- `ShutdownOptions`
- `ProcessSignalsOptions`
- `ManagedServerResourceConfig`
- `SocketIOServerConfig`
- `RouteGroup` and `LifecycleHooks`

`BunServerConfig` and the client surfaces are a deliberate second pass, recorded
here rather than silently skipped.

## What this gate does NOT prove

It proves a **named test claims the option**, not that the test is good. That is
the same contract `reference-coverage` has — it proves an export is mentioned in
the reference, not that the prose is useful. The difference it makes is still
the whole distance between six silent defects and a red gate.

## План

- [x] Enumerate members of the selected config types through the TS checker.
- [x] Registry fixture mapping `Type.field` → the exact name of a test that
      exercises it, or an explicit recorded exemption with a reason.
- [x] Gate refuses an unregistered field, a registry entry for a field that no
      longer exists, and a registered test name that no test file defines.
- [x] Write the tests the first red run demands.
- [x] `AGENTS.md` states the rule so it is readable rather than inferred.

## Acceptance

- [x] Adding a field to a covered config type turns the gate red until it is
      registered.
- [x] Renaming a registered test turns the gate red.
- [x] Every covered field either names a real test or carries a written reason.
- [x] `bun run verify:fast` green.

## Что сделано

### Tests

- [x] `packages/core/tests/option-effects.test.ts` — гейт: перечисляет члены шести
      конфигурационных типов через TypeScript checker (тот же `@typescript/typescript6`,
      которым `reference-coverage.test.ts` перечисляет экспорты), сверяет с реестром и
      проверяет, что каждое названное имя теста действительно существует в наборе.
- [x] `packages/core/tests/fixtures/option-effects.json` — реестр на 36 опций:
      `ShutdownOptions` 5, `ProcessSignalsOptions` 8, `SocketIOServerConfig` 9,
      `RouteGroup` 3, `LifecycleHooks` 5, `ManagedServerResourceConfig` 6.
- [x] Гейт сам себя проверяет тестом `the registry can find the tests it names`:
      реестр, не находящий ничего, выглядел бы как чистая выборка.

### Найденное первым прогоном

- [x] `SocketIOServerConfig.pingInterval` и `pingTimeout` не упоминались в тестах
      ни разу. Обе передаются в ДВА места — `new Server({...})` и hand-built Bun engine, —
      то есть ровно та форма, которой была 0.70.4. Дефекта нет, код знает про ловушку и
      комментирует её; но доказательства не было ни для одной из двух, притом что у
      соседнего `maxHttpBufferSize` на том же пути тест есть.
- [x] Написаны `a configured ping heartbeat reaches the Bun engine handshake` и
      `the default ping heartbeat is the documented one when omitted`
      (`packages/core/tests/socket-io.test.ts`). Наблюдаемое — открывающий пакет
      Engine.IO, то есть то, что реально получает клиент.
- [x] `SocketIOServerConfig.cors` оказался ложной тревогой поиска: тесты есть
      (`describe('Socket.IO CORS')`), опция передаётся параметром, а не литералом в теле.
      Проверено чтением исходника, а не доверием к grep.

### Docs

- [x] `AGENTS.md` — правило в списке Rules, с шестью случаями и с явной границей того,
      что гейт доказывает, а что нет.

### Фальсификации

- [x] Убрать проброс ping в hand-built Bun engine → оба новых теста красные.
- [x] Реестр называет несуществующий тест → красный.
- [x] Реестр называет опцию, которой в типе нет → красный.
- [x] Добавить новое поле в реальную `ShutdownOptionsSchema` → красный, и отказ
      называет поле по имени.

### Что не сделано

- [x] `BunServerConfig` (20 полей) и клиентские поверхности не покрыты — сознательно,
      по правилу отбора: их отказ громкий. Записано в самой задаче, а не умолчано.
- [x] Гейт не доказывает, что названный тест хорош, — только что он существует и
      заявлен на эту опцию. Это тот же контракт, что у `reference-coverage`.
