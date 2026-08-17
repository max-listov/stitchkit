---
title: Явная привязка процессных сигналов к managed shutdown
description: bindProcessSignals — один generic-примитив вместо самописной машины SIGINT/SIGTERM, с состояниями, которых нет в ручных вариантах: подготовка, реджект, третий сигнал.
type: task
status: done
created: 2026-08-17
updated: 2026-08-17
completed: 2026-08-17 14:04 +00:00
related: docs/backlog/done/2026-08-14-managed-http-socketio-shutdown.md
---

# Явная привязка процессных сигналов к managed shutdown

## Зачем

0.49 отдал приложению `ManagedServerHandle.shutdown()` — идемпотентную операцию
с admission gate, дренажем, дедлайном и честным `clean` / `forced` результатом
([shutdown.ts:56-62](../../../packages/core/src/server/shutdown.ts)). Привязку к
процессным сигналам мы сознательно оставили приложению и в 0.49.0 **выключили**
скрытый signal-lifecycle `srvx`.

Явное владение сигналами остаётся правильным. Задача не отменяет его, а
устраняет то, что «явно» сегодня означает «напиши машину состояний сам». Канон
описан в `docs/guide/testing-and-deployment.md:109-135` и корректно реализован в
стартере (`packages/create-stitchkit/template/packages/backend/src/index.ts:42-68`),
но канон покрывает только два состояния — «нет цепочки» и «цепочка идёт». Три
состояния он не покрывает нигде, и в ручном коде они и ломаются:

- **третий сигнал** — подписка подавила дефолтную диспозицию, повторный
  `abort()` — no-op (`shutdown.ts:177`), выход из процесса не наступает;
- **сигнал во время асинхронной подготовки** (остановка воркеров до
  `shutdown()`) — контроллера ещё нет, форс теряется;
- **реджект `shutdown()`** — он реджектит тремя путями (`shutdown.ts:237`,
  `:239`, `AggregateError` на `:231-235`), и результат кэшируется **как
  rejected**; наружная `promise` без внутреннего `catch` даёт
  `unhandledRejection`.

Задача даёт один generic-примитив с полной машиной состояний. Она **не даёт
нового runtime-поведения**: форс по второму сигналу уже работает и уже покрыт
двумя стендами с реальными сигналами (Bun —
`packages/core/tests/server-shutdown-signal.test.ts`, Node —
`packages/core/scripts/node-shutdown-signal.mjs`).

## Подтверждённая механика

Проверено валидаторами по коду:

- **Идемпотентность буквальная:** `shutdown.ts:164` — `if (shutdownPromise)
  return shutdownPromise`, тот же объект Promise
  (`packages/core/tests/server-shutdown.test.ts:49`).
- **Внешний `signal` реально форсирует идущую цепочку:** `shutdown.ts:183` →
  `force('signal')` (`:176-180`) → `phaseAbort.abort()`; уже аборченный
  контроллер обработан на `:184`; `reason: 'signal'` отдаётся на `:248`.
- **Канал влияния единственный:** опции парсятся только на первом вызове
  (`shutdown.ts:165`, после раннего `return`), поэтому `AbortSignal` первого
  вызова — единственный вход в идущую цепочку. Отсюда footgun: если приложение
  вызвало `shutdown()` само, контроллер мёртв навсегда и сигнал уже ничего не
  форсирует.
- **Двойного владения нет:** Node — `serve({ gracefulShutdown: false })`
  (`node.ts:102`) со сторожем `packages/core/tests/node.test.ts:110-117`; Bun не
  трогает `process`; во всём `packages/core/src` нет ни одного `process.on`.
- **`process` в ядре не запрещён** — он уже используется в `create.ts:181`,
  `logger.ts:36`, `observability/context.ts:165`. Единственный запрещённый
  глобал в `biome.json` — `Bun`. Модуль живёт в `server/` потому, что это
  server-lifecycle, а не из-за ADR 0013.
- **ADR 0074 прямо противоречит фиче:** `:76` — «core never registers process
  signals», `:102` — «the framework owns no global process listeners». Нужен
  superseding ADR, а не тихое добавление.
- **Конвенции репозитория:** ноль экспортов `on*` (это имена колбэк-полей);
  фабрики — `createX`, привязка внешнего объекта — `bindRealtimeServer`
  (`server/realtime.ts:44`); teardown — `close()`, не `dispose`; опции с
  колбэками — обычный `interface` (`ErrorHookConfig`, `EventBusOptions`), Zod —
  только скаляры; инъекция для тестов — `RunCliConfig` (`tools/cli.ts:105-114`,
  дефолты на `:306-309`).
- **`stitchkit/node` не ре-экспортирует `server/index.ts`** — `src/node.ts` это
  ручной список; нужен отдельный экспорт.

## Результат

- `bindProcessSignals(handle, options?)` — явный opt-in, ничего не
  подписывается без вызова.
- Полная машина: `idle → preparing → running → settled`. `AbortController`
  создаётся **до** асинхронной подготовки, поэтому сигнал в фазе `preparing`
  корректно долетает (`shutdown.ts:184` обрабатывает предварительно аборченный
  signal). Сигнал после `settled` — снимает подписки и **восстанавливает
  дефолтную диспозицию** (`process.kill(process.pid, signal)`), чтобы третий
  Ctrl+C убивал процесс, а не уходил в пустоту.
- Реджект выражен явно: `onError(error)` отдельно от `onComplete(result)`, а
  внутренний `catch` гарантирует отсутствие `unhandledRejection` независимо от
  того, подписалось ли приложение.
- Фреймворк **не трогает** `process.exit` и exit code вообще — это политика
  супервизора приложения (ADR 0074). Приложение ставит `process.exitCode` в
  `onComplete` / `onError` одной строкой.
- Принимает `Pick<ManagedServerHandle<unknown>, 'shutdown'>` и инъектируемый
  `signalSource` — юнит-тест не патчит глобалы и не пишет `as`.
- Повторная привязка к тому же handle — явная ошибка, а не тихо мёртвый
  контроллер.
- Возвращает `{ promise, close() }`.

## План

- [x] `packages/core/src/server/process-signals.ts`; опции —
      `export interface ProcessSignalsOptions { signals?: readonly NodeJS.Signals[];
      shutdown?: Omit<ShutdownOptions, 'signal'>; signalSource?: SignalSource;
      onShutdown?; onComplete?; onError?; onRepeatedSignal? }`. Zod не
      применяется к колбэкам; скалярные бюджеты валидируются переиспользованием
      `ShutdownOptionsSchema.omit({ signal: true })`.
- [x] Тип набора сигналов — `readonly NodeJS.Signals[]` (не `string[]`: иначе
      `process.on/off` потребует `as`). Дефолт `['SIGINT','SIGTERM']`;
      в доке отметить, что `SIGTERM` не слушается в Node на Windows.
- [x] Машина состояний с `preparing`; порядок «`onShutdown` до `shutdown()`»
      обосновать в ADR либо перевернуть — admission gate закрывается только на
      `shutdown.ts:169-170`, то есть в фазе подготовки сервер ещё принимает
      трафик.
- [x] Явный `.omit({ signal: true })` на вложенных опциях: сейчас Zod
      молча strip'ит чужой `signal`, и потребитель не узнает, что его проигнорировали.
- [x] `close()` — идемпотентен, снимает подписки; поведение при вызове во время
      идущей цепочки задокументировать (следующий сигнал убьёт процесс).
- [x] Экспорт из `server/index.ts` **и** отдельной строкой из `src/node.ts`.
- [x] `packages/core/tests/fixtures/public-surface.json` + строки в
      `docs/api/reference.md` (гейт `reference-coverage.test.ts`).
- [x] Юнит-тест `packages/core/tests/process-signals.test.ts` на подставном
      `signalSource` и узком фейке handle (образец фейка —
      `server-shutdown-lifecycle.test.ts:7-19`): одна цепочка на два сигнала;
      второй абортит; сигнал в `preparing`; третий восстанавливает диспозицию;
      реджект уходит в `onError` без `unhandledRejection`; `close()` идемпотентен;
      повторная привязка бросает.
- [x] ADR `docs/decisions/0076-explicit-process-signal-binding.md` —
      supersedes **signal-clause** ADR 0074; строки 0074 и 0076 в
      `docs/decisions/README.md` по образцу частичной supersession.
- [x] `docs/guide/testing-and-deployment.md:109-135` — заменить ручную машину на
      примитив.
- [x] `CHANGELOG.md` → `[Unreleased]` → `### Added`.

## Что в этот проход НЕ входит

- [x] **Стартер не трогаем.** `bun run starter-lane` идёт `--mode=target` против
      опубликованного `^0.49.2` и явно падает, если резолвится локальное ядро
      (`scripts/starter-lane.ts:360`, `:372-374`). Правка стартера — отдельный
      проход после публикации ядра, как требует release-флоу в `AGENTS.md`.
- [x] **Существующие subprocess-стенды не переписываем** — они уже доказывают
      форс по второму реальному сигналу на обоих рантаймах и должны остаться
      зелёными без правок.

## Acceptance

- [x] Одна цепочка на два сигнала, второй форсирует, третий восстанавливает
      дефолтную диспозицию — `packages/core/tests/process-signals.test.ts`.
- [x] Сигнал в фазе `preparing` не теряется — кейс там же.
- [x] Реджект `shutdown()` доходит до `onError` и не порождает
      `unhandledRejection`, даже если приложение не подписалось — кейс там же.
- [x] Повторная привязка к тому же handle бросает — кейс там же.
- [x] `process.exit` в модуле отсутствует (grep по файлу).
- [x] Существующие managed-shutdown тесты и оба signal-стенда зелёные без правок.
- [x] `reference-coverage.test.ts` зелёный (снапшот + строки reference).
- [x] ADR 0076 существует; строки 0074/0076 в `docs/decisions/README.md`
      оформлены как частичная supersession.
- [x] `bun run verify` зелёный.

## Что сделано

### Core

- [x] `packages/core/src/server/process-signals.ts` — `bindProcessSignals`,
      `ProcessSignalsOptions` (обычный `interface`, не Zod: три поля — колбэки,
      одно — инъекция), `SignalSource`, `ShutdownTarget`,
      `ProcessSignalsBinding`.
- [x] Машина `idle → preparing → running → settled`. `AbortController`
      создаётся **до** `onShutdown`, поэтому сигнал в фазе подготовки не теряется.
- [x] Третий сигнал (и сигнал во время ещё идущего `onComplete`) снимает
      подписки и переподнимает сигнал через `raiseDefault`, восстанавливая
      дефолтную диспозицию.
- [x] Реджект — первоклассный исход: `onError` + внутренний `catch` на
      возвращаемой `promise`, поэтому её игнорирование не даёт
      `unhandledRejection`.
- [x] Бюджеты валидируются на привязке через
      `ShutdownOptionsSchema.omit({ signal: true })`; чужой `signal` — ошибка
      типа, а не тихо выброшенное поле.
- [x] `process.exit` в модуле отсутствует — exit code остаётся политикой
      приложения.
- [x] Экспорт из `packages/core/src/server/index.ts` **и** отдельной строкой из
      `packages/core/src/node.ts`.

### Тесты

`packages/core/tests/process-signals.test.ts` (12 кейсов, подставной
`signalSource` и узкий фейк handle):

- [x] `bindProcessSignals > forces a shutdown that is already in flight`
- [x] `bindProcessSignals > a signal during asynchronous preparation still forces the chain`
- [x] `bindProcessSignals > a third signal restores the default disposition instead of doing nothing`
- [x] `bindProcessSignals > two signals in the first delivery turn are one press, not a force`
- [x] `bindProcessSignals > duplicate signal names register one listener`
- [x] `bindProcessSignals > an escalation that cannot restore the default reports it`
- [x] `bindProcessSignals > a rejected shutdown reaches onError and does not go unhandled`
- [x] `bindProcessSignals > a failing onShutdown is reported but never cancels the shutdown`
- [x] `bindProcessSignals > a failing onComplete keeps the chain resolved and reports separately`
- [x] `bindProcessSignals > a throwing onRepeatedSignal cannot swallow the force`
- [x] `bindProcessSignals > a re-entering callback finds the machine already advanced`
- [x] `bindProcessSignals > onShutdown runs before shutdown and onComplete after it`
- [x] `bindProcessSignals > close removes the listeners, settles the chain and is idempotent`
- [x] `bindProcessSignals > binding the same handle twice throws instead of dropping the force path`
- [x] `bindProcessSignals > closing a running binding does NOT release the handle for a second one`
- [x] `bindProcessSignals > forwards the declared budgets and owns the abort signal`
- [x] `bindProcessSignals > registers only the signals it was given`
- [x] `bindProcessSignals > never calls process.exit — the escalation path re-raises instead`

### Документация

- [x] ADR `docs/decisions/0076-explicit-process-signal-binding.md`; строки 0074
      и 0076 в `docs/decisions/README.md` — частичная supersession.
- [x] `docs/guide/testing-and-deployment.md` — ручная машина заменена разделом
      «Process signals — `bindProcessSignals`».
- [x] `docs/api/reference.md` + `packages/core/tests/fixtures/public-surface.json`.
- [x] `CHANGELOG.md` `[Unreleased]` → `### Added`.

### Поправлено по ходу

- [x] Изначальный тест «сигнал после завершения цепочки эскалирует» был неверен:
      `close()` в `finally` уже снял подписки, поэтому сигнал после завершения
      попадает на дефолтную диспозицию сам. Разделено на два честных кейса —
      эскалация во время ещё идущего `onComplete` и отсутствие подписок после.

### Дефекты, найденные валидатором реализации (все исправлены)

Первая редакция машины прошла 12 собственных тестов и была неверна в восьми
местах. Валидатор воспроизвёл каждый интерливинг зондом.

- [x] **`onComplete` бросает → цепочка одновременно «успешна» и «ошибочна».**
      `resolveChain` выполнялся до `await onComplete`, а исключение падало в
      общий `catch` и уходило в `onError`. Теперь фазы разделены:
      `onError(phase, error)` с `'prepare' | 'shutdown' | 'complete'`, и при
      падении `onComplete` `promise` остаётся resolved — транспорт
      действительно остановился.
- [x] **`unhandledRejection` был возможен из самого модуля.** Внутренний `catch`
      висел на возвращаемой `promise`, а не на `void run(signal)`; бросок из
      `onError` вылетал наружу и на Node ≥ 15 убивал процесс ровно в момент
      shutdown. Теперь `run()` перехватывается, каждый пользовательский колбэк
      обёрнут, а бросок из самого `onError` глотается.
- [x] **`onShutdown` бросает → `shutdown()` не вызывался вообще**, сервер
      оставался слушать сокет. Теперь провал подготовки репортится как
      `'prepare'`, а остановка выполняется.
- [x] **Два разных сигнала в одном тике схлопывали grace period в ноль**
      (супервизор, шлющий SIGINT и SIGTERM разом). Сигналы в первом обороте
      доставки больше не считаются вторым нажатием; дубликаты в `signals`
      дедуплицируются.
- [x] **`close()` снимал WeakSet-охрану на живой цепочке** — второй биндинг
      получал мёртвый force-путь и резолвился чужим результатом. Охрана теперь
      освобождается только из idle.
- [x] **`raiseDefault` не восстанавливал дефолтную диспозицию при чужом
      слушателе** (логгер, REPL, второй биндинг). Проверено на Node и Bun:
      процесс выживал. Теперь источник проверяет `process.listenerCount` и
      возвращает `false`, а приложение узнаёт об этом через
      `onEscalationBlocked` — вместо обещания убийства, которое не выполняется.
- [x] **`close()` без сигнала оставлял `promise` висеть вечно.** Теперь она
      резолвится `undefined`; тип стал `Promise<ShutdownResult | undefined>`.
- [x] **`onSignal` не был reentrancy-safe:** состояние мутировалось после
      пользовательского колбэка, поэтому бросок терял force, а реэнтрант через
      кастомный `SignalSource` рекурсировал. Теперь состояние меняется первым.
- [x] Тесты переписаны: 18 кейсов вместо 12. Главное — появился кейс, который
      форсит **реально идущий** `shutdown()` (прежний форсил ещё не начатый,
      то есть дублировал кейс про preparing), кейс с реальным слушателем
      `unhandledRejection`, и кейсы на каждый дефект выше.

### Поймано полным verify (быстрые гейты этого не видели)

- [x] В публичную поверхность утёк `NodeJS.Signals` — тип из `@types/node`,
      которого у browser-safe потребителя нет: `consumer-lane` отверг
      публикуемые `.d.ts` («the published declarations reference something new
      that a consumer cannot resolve: NodeJS»). Заменён на собственный union
      `ProcessSignalName`. Это ровно тот класс ошибки, ради которого lane и
      существует: `lint`/`check`/`test`/`build` внутри репозитория его не видят,
      потому что там `@types/node` есть.

### Чего не делали

- [x] Стартер не тронут: `starter-lane` идёт `--mode=target` против
      опубликованного `^0.49.2` и упал бы на неопубликованном примитиве.
      Отдельный проход после релиза ядра.
- [x] Существующие signal-стенды (Bun и Node) не переписаны и остались
      зелёными — нового runtime-поведения задача не вносит.
