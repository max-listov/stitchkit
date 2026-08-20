---
title: "Async operation: закрыть заявленные, но непокрытые сценарии"
description: План закрытой таски перечисляет двенадцать сценариев как покрытые, фактически тестов пять; отсутствуют cancel-исходы, коллизии имён и отказ авторизации по чужому id.
type: task
status: done
created: 2026-08-20
updated: 2026-08-20
completed: 2026-08-20 15:17 +00:00
related: docs/backlog/done/2026-08-20-async-operation-protocol.md
---

# Async operation: недостающее покрытие

## Зачем

Закрытая таска содержит `[x]` на пункте «Покрыть snapshot scenarios: immediate
success, pending→running→success, snapshot regression, public failure/internal
cause boundary, accepted/already-terminal/rejected cancel, cancel race,
unsupported cancel, abort/timeout wait, result-before-success, definition
collision и повторный application id» и `[x]` на acceptance «fixture чужого id
не раскрывает наличие operation».

Фактически в `packages/core/tests/async-operation.test.ts` пять тестов.
Проверка по всему сьюту:

- `already_terminal` и `rejected` как исходы cancel — **ноль** упоминаний в
  тестах; из трёх ветвей `AsyncOperationCancelResultSchema` исполняется одна;
- нет теста на definition collision — второй проход `names.clear()` +
  `assertUniqueToolName` по всем шести capability не исполняется;
- нет snapshot-regression, public-failure/internal-cause boundary,
  unsupported cancel, повторного application id;
- во всех тестах `authorize` либо пишет имя capability, либо возвращает
  `undefined` — **ни один не отказывает**, поэтому «чужой id не раскрывает
  наличие operation» ничем не подтверждено.

Строки `Регрессия:` в доке при этом честны (их стережёт
`docs-hygiene.test.ts`); неверны именно чекбоксы План/Acceptance. Правило
проекта — «claim только с named test case» — должно распространяться и на них.

## Результат

- Каждый заявленный сценарий либо покрыт тестом, либо явно снят с
  формулировкой причины.
- Закрытая таска получает точечную поправку: снятые пункты помечены как
  «не покрыто — <причина>», без переписывания истории.
- Ветви `cancel`-результата и коллизия имён перестают быть мёртвым кодом.

## План

- [x] Тесты cancel: `already_terminal` и `rejected` (с обязательным `reason`)
      проходят валидацию схемы и доезжают до вызывающего.
- [x] Тест definition collision: `names: { status: 'job_wait' }` (или иное
      пересечение) валит `defineAsyncOperation` с внятным сообщением.
- [x] Тест авторизации: `authorize`, бросающий доменную ошибку для чужого id,
      прекращает вызов до `inspect` — `inspect` не вызывается ни разу; ответ не
      различает «нет доступа» и «не существует».
- [x] Тест unsupported cancel: descriptor без `cancel` не отдаёт capability ни
      в `runtimeTools`, ни в inferred-ключах (частично есть — дополнить явной
      попыткой вызова).
- [x] Тест snapshot regression: `running` после `succeeded` принимается
      framework без скрытого запрета (заявленное поведение).
- [x] Тест public-failure boundary: `failed.failure` отдаёт только
      application-схему; внутренняя причина не попадает в presenter.
- [x] Поправка к закрытой таске: пункты, оставленные непокрытыми, помечены
      честно; `Регрессия:` дополнена новыми кейсами.
- [x] Повторный application id доказать отдельным кейсом: два `start` с одним
      id разрешены, потому что uniqueness остаётся application-owned.
- [x] Pending→running→success и immediate-success закрепить через реальные
      `status`/`wait` вызовы, а cancel race — через `already_terminal` после
      терминального inspect.

## Acceptance

- [x] Каждая ветвь `AsyncOperationCancelResultSchema` исполняется тестом.
- [x] Отказ авторизации доказан отсутствием вызова `inspect`.
- [x] В закрытой таске не осталось `[x]` без соответствия реальности.
- [x] `bun run verify` зелёный.

## Что сделано

- [x] Tests: `packages/core/tests/async-operation.test.ts` вырос с пяти до
      шестнадцати executable cases и закрывает все заявленные state/cancel/auth/
      collision/uniqueness ветви.
- [x] Historical truth: `docs/backlog/done/2026-08-20-async-operation-protocol.md`
      отличает реально добавленные async cases от намеренно не дублируемого
      общего transport conformance suite и называет точные проверки.
- [x] Регрессия: packages/core/tests/async-operation.test.ts::accepted already_terminal and rejected cancel outcomes reach the caller; packages/core/tests/async-operation.test.ts::a terminal cancel race is reported as already_terminal after one inspect; packages/core/tests/async-operation.test.ts::definition name collisions fail across mandatory and optional capabilities; packages/core/tests/async-operation.test.ts::authorization denial hides existence and stops before inspect; packages/core/tests/async-operation.test.ts::snapshot regression is validated but not rejected as a transition; packages/core/tests/async-operation.test.ts::failed snapshot strips the internal cause at the public schema boundary; packages/core/tests/async-operation.test.ts::wait accepts pending running succeeded snapshots from one application state source; packages/core/tests/async-operation.test.ts::repeated application ids are accepted without framework uniqueness state
