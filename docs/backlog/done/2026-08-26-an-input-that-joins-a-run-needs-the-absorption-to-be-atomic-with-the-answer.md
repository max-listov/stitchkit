---
title: An input that joins a run needs the absorption to be atomic with the answer
description: inject shipped in 0.63.0 and was withdrawn in 0.65.0; the redesign commits the absorption with the terminal record instead of at a step boundary.
type: task
status: done
created: 2026-08-26
updated: 2026-08-26
completed: 2026-08-26 03:30 +00:00
related: docs/backlog/done/2026-08-25-an-input-cannot-join-a-run-already-in-flight.md
---

## Зачем

`inputPolicy: 'inject'` shipped in 0.63.0 and was withdrawn in 0.65.0 after an
adversarial read found four defects that all trace to one ordering mistake:
**the absorption was committed durably at a step boundary, before the answer
existed.**

Everything followed from that:

- `absorbed` became the only run state that is neither active, nor recoverable,
  nor terminal — a durable dead end. `listActive` and `scanRecoverable` exclude
  it, `recoverRun` refuses it, `terminalState()` cannot produce it.
- `close()` between the absorb and the answer reported `settled: true` while
  leaving the input permanently unanswerable, invisible to recovery, and its
  idempotency key **refused forever** on retry — the exact case idempotency keys
  exist for.
- The absorb re-projected the whole snapshot, so an unrelated queued input
  reached the model inside a run that never recorded it and was then answered a
  second time by its own run.
- `inject` + `coalescePending` refused a legitimate submission, because the
  reservation pointed at a run that had since become `absorbed`.

The capability is still worth having. It is right whenever the new input refines
rather than redirects and the finished steps are still valuable.

## Результат

- A run in flight can take on a queued successor's input, and no ordering exists
  in which an accepted input becomes unanswerable.

## План

- [x] **Commit the absorption with the terminal record, not at the boundary.**
      The loop may put the pending input into the *prompt* at a step boundary —
      that part was right — but nothing durable changes until the run settles.
      A run that ends first, crashes, or is closed leaves an ordinary queued
      successor, which is the behaviour every other policy already has and needs
      no new state to express.
- [x] Decide whether the absorbed record keeps a distinct state at all. If the
      absorption lands with the terminal, the successor can simply be terminal
      too, with a reason that says why — which keeps it inside every existing
      enumeration instead of outside all of them.
- [x] Project the run's **own** inputs plus prior committed turns, never the raw
      snapshot: an unrelated queued input must not reach the model.
- [x] Make the duplicate-submission path resolve through whatever pointer the
      design ends up with, and prove it across a simulated restart, not only
      in-process.
- [x] Cover the operation in `runAgentStoreConformance`, including that a driver
      which persists only one of the two run records fails the kit.
- [x] Compose with `coalescePending` and prove it, rather than shipping two
      features that were each tested alone.

## Acceptance

- [x] A test kills the process between the boundary and the terminal commit and
      shows the input is answered by an ordinary successor.
- [x] A test closes the runtime mid-run and shows no accepted input is left
      unanswerable, with `close()` reporting honestly.
- [x] A test retries the same idempotency key after a restart and gets the
      answer, not an error.
- [x] A test shows an unrelated queued input never reaches the absorbing run's
      prompt.
- [x] A test covers `inject` together with `coalescePending`.
- [x] The conformance kit fails a driver that persists one record of the pair.

## Что сделано

### Решение (ADR 0113)

**Ничего долговечного не происходит, пока прогон не завершится.** Цикл кладёт
поступивший вход в *prompt* на границе шага — эта половина была правильной. Чего
он не имеет права делать — писать о нём хоть что-нибудь. Поглощение стало полем
`absorb` у `commitRunTerminal` и применяется в одной транзакции с терминальной
записью.

Из этого порядка следует всё остальное:

- Прогон, закончившийся любым другим способом, оставляет **обычного очередного
  преемника** — то, что и так производит любая другая политика и с чем recovery
  уже умеет работать. Нет порядка, в котором принятый вход становится
  неотвечаемым.
- **Поглощать может только завершившийся прогон.** Прерванный взял вход в prompt
  и остановился — он на него не ответил.
- **Нового состояния прогона нет.** `absorbed` отображается в `superseded`,
  которое уже есть во всех перечислениях. Причина говорит, что именно
  произошло; `absorbedIntoRunId` — где ответ.
- **У поглощённого прогона нет своего сообщения ассистента.** Он ничего не
  произвёл. Стор сам идёт по указателю, когда приходит повтор по его ключу
  идемпотентности.
- Поглощение **целиком или никак**: частичное оставило бы терминальный прогон с
  входами, на которые никто не ответил, и сломало бы резолв по ключу.

### Core

- [x] `packages/core/src/agent-runtime/schemas.ts` — `'absorbed'` в
      `AgentTerminalReason`, `AgentRun.absorbedIntoRunId`, три новых правила в
      `superRefine`, `runStateForTerminalReason('absorbed') === 'superseded'`.
- [x] `packages/core/src/agent-runtime/store.ts` — `CommitRunTerminal.absorb`.
- [x] `packages/core/src/agent-runtime/store-driver.ts` — эффекты редьюсера
      стали множественными (`runRecords`, `historyMutations`), потому что одна
      мутация теперь завершает два прогона; ветка `terminal` применяет
      поглощение; ветка `duplicate` идёт по указателю.
- [x] `packages/core/src/agent-runtime/injection.ts` — новый процесс-локальный
      реестр предложений (дедуп по *входу*, не по прогону).
- [x] `packages/core/src/agent-runtime/run-execution.ts` — `prepareStep`
      ставится только когда инъекция вообще возможна; `projectInputs` рядом с
      `projectHistory`, чтобы проекция одного сообщения не затирала
      `carriedSystem`; короткое замыкание для уже поглощённого прогона.
- [x] `packages/core/src/agent-runtime/runtime.ts` — реестр создаётся только при
      достижимой политике `inject`; предложение после приёма; `close()` его
      очищает.
- [x] `packages/core/src/agent-runtime/coordinator.ts` — `'inject'` в
      `AgentInputPolicy`, для координатора это `queue`.
- [x] `packages/core/src/agent-runtime/terminal-commit.ts` — `absorb` переживает
      повтор CAS и намеренно **не** переживает смену причины на `interrupted`;
      резолюция сообщает, кого поглощение реально накрыло.
- [x] **Найденный по дороге пробел:** поглощённый прогон не входит в тело
      исполнителя, поэтому после `admission` он не публиковал ничего — surface,
      следящий за его `runId`, ждал бы состояния вечно. Теперь публикуется
      финальный `run-state` со `superseded`.

### Tests

- [x] `packages/core/tests/agent-runtime-inject.test.ts` — 13 тестов, по одному
      на каждый пункт Acceptance плюс: прерывание **после** взятия входа, отказ
      провайдера после взятия входа (без него отказ редьюсера потерял бы
      терминальную запись прогона), финальный `run-state` поглощённого прогона,
      «взятый вход доходит до каждого следующего шага ровно один раз» (SDK
      переносит список сообщений `prepareStep` вперёд — наивное накопление
      дублировало бы его), «рантайм, который не умеет inject, ничего не
      ставит», и отказ стора
      бессмысленному поглощению (сам себя, дважды одного и того же, `absorbed`
      как собственная причина коммита).
- [x] `packages/core/src/testing/agent-store-conformance.ts` —
      `assertAbsorptionIsAtomic`: обе записи, отказ незавершившемуся прогону,
      отсутствие ответа у поглощённого, уход из активных, резолв повтора по
      ключу.
- [x] Фальсификация: снятие защиты «только завершившийся поглощает» в
      исполнителе, снятие её же в редьюсере, проекция всего снапшота вместо
      взятого входа, снятие редиректа дубликата, снятие короткого замыкания,
      дедуп по прогону вместо входа — каждое обрушило тест.

### Docs

- [x] `docs/decisions/0113-an-absorbed-input-is-committed-with-the-answer.md` +
      строка в `docs/decisions/README.md`.
- [x] `docs/guide/agent-runtime.md` — раздел *An input that joins a run in
      flight* заменил *The one that is not offered*; таблица политик снова с
      четырьмя строками.
- [x] `docs/api/reference.md`, `CHANGELOG.md`, `docs/guide/upgrading.md`.

### Чего не сделано

- Ничего из плана не отложено. Известное ограничение записано в ADR 0113 и в
  гайде: вход, скоалесцированный в преемника **после** последней границы шага
  поглощающего прогона, отменяет поглощение — преемник тогда отвечает на все
  свои входы сам, а поглощающий уже ответил на один из них. Дубль ответа, а не
  пропажа.
