---
title: recover() может записать в store после того, как close() вернул результат
description: Приём и resume() накрыты барьером, а мутирующая часть восстановления — нет: close(), пришедший внутри decide(), пропускает requeue.
type: task
status: done
tags: [agent-runtime, close, race]
related: docs/backlog/done/2026-08-25-close-waits-for-admissions-in-flight.md
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25 05:04 +00:00
---

# recover() может записать в store после того, как close() вернул результат

## Зачем

Барьер незавершённых заявок накрыл `submit()` и `resume()`. `recover()`
проверяет `admissionClosed` на входе и заново в условии цикла
(`runtime.ts:688`, `:700`) — но между этой проверкой и durable-записью
`recoverAgentRun({ action: 'requeue' })` стоит `await options.decide?.(item)`,
пользовательский колбэк, внутри которого close успевает пройти целиком.

Окно уже, чем в отчёте аудита, и последствие мягче: requeue не создаёт новой
работы, он переводит уже осиротевший прогон из `running` в `queued` — туда, где
восстановление его и нашло. Но свойство, ради которого барьер писался,
формулируется как «после возврата `close()` рантайм в store не пишет», и здесь
оно не выполняется.

## Результат

- Мутирующий срез восстановления (`recoverAgentRun` → `resume`) входит в тот же
  барьер, что и приём.
- `close()` не возвращает результат, пока этот срез не завершён.
- Утверждение в закрытой задаче про «recovery покрыт через resume» исправлено
  на месте: мутация происходит раньше `resume()`.

## План

- [x] Обернуть срез от решения до handoff'а в `beginAdmission()`.
- [x] Детерминированная регрессия: close **внутри** `decide()` и close между
      requeue и resume.
- [x] Проверить регрессии на убийство.

## Acceptance

- [x] После возврата `close()` ни один путь рантайма не пишет в store.
- [x] `bun run verify` зелёный.

## Что сделано

### Core

- [x] `packages/core/src/agent-runtime/runtime.ts`: мутирующий срез одного
      item'а восстановления обёрнут в `beginAdmission()`/`handedOff()` — тот же
      барьер, что у `submit()` и `resume()`.
- [x] Проверка `admissionClosed` перенесена туда, где она решает: сразу **после**
      `decide()`, последняя точка перед первой durable-записью; между ней и
      `recoverRun` нет `await`.
- [x] Закрытие останавливает скан **по item'у**, а не по странице.

### Регрессия

- [x] `packages/core/tests/agent-runtime-close-admission.test.ts`, блок `close()
      stops recovery mid-item`: close внутри `decide()` — прогон остаётся
      `running`, outcome `failed` с closed-ошибкой; close при блокирующей
      `store.recoverRun` — `close()` не возвращает результат, пока запись не
      завершена.
- [x] Обе проверены на убийство: снятие post-decide проверки даёт `queued`
      вместо `running`; снятие барьера даёт `written === false` на момент
      возврата `close()`.

### Что уточнено против отчёта аудита

- [x] Окно уже, чем описано: requeue не создаёт новой работы, он возвращает уже
      осиротевший прогон `running → queued`. Свойство «после возврата `close()`
      рантайм не пишет» тем не менее нарушалось и теперь держится.
