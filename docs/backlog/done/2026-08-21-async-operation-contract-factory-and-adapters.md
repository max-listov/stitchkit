---
title: "Async-operation contract factory and typed adapters"
description: Закрыть разрыв между runtime-only operation и существующими HTTP contracts с типичными start snapshot и follow-up id inputs.
type: task
status: done
created: 2026-08-21
updated: 2026-08-21
completed: 2026-08-21
related: docs/decisions/0095-async-operation-contract-factory-and-adapters.md
---

# Async-operation contract factory и typed adapters

## Зачем

`defineAsyncOperation` создаёт полный runtime-tool protocol, а
`bindContractAsyncOperation` только связывает уже существующий dedicated
contract при жёсткой форме `start.output === follow.input`. Обычный HTTP API
часто возвращает из `start` initial snapshot с вложенным ID, тогда как
`status/wait/cancel` принимают собственные `{ id }` inputs. Consumer снова
вручную проектирует одинаковый `start/status/wait/cancel` contract и adapters.

Stitchkit должен владеть canonical transport protocol и type-safe projection,
но не job storage, queue, transition state machine или persistence.

## Результат

- Zod-first factory из start input, operation ID и snapshot schemas создаёт
  canonical contract capabilities `start/status/wait` и optional
  `cancel/result/artifacts` без дублирования endpoint shape.
- Factory принимает optional application `startOutput` + `idFromStart`;
  shorthand без них означает `start.output === id`.
- Existing-contract binding поддерживает typed `idFromStart` и per-capability
  input adapters для structurally different start output/follow inputs.
- Binder возвращает typed adapter descriptor/invoker: `idFromStart(output)` и
  `inputFor.<capability>(id)`. Compile-time проверяет signatures/keys, а каждый
  фактический result парсится capability-specific endpoint schema.
- Canonical factory и existing-contract adapter сходятся в одном описании
  capabilities, не создавая параллельный job engine или второй router.
- Resource authorization и domain terminal semantics остаются приложению.

## План

- [x] Выписать canonical capability contract и вариативные existing-contract
      shapes; определить source of truth для ID/snapshot.
- [x] Спроектировать `defineAsyncOperationContract` (рабочее имя), возвращающий
      `{ contract, capabilities, schemas }`, с literal
      endpoint keys, paths/methods, scopes/descriptions и optional capabilities.
- [x] Расширить `bindContractAsyncOperation` typed adapters: callback получает
      `z.output<start.output>`, builders принимают parsed ID и возвращают
      `z.input<follow.input>`; returned invoker парсит каждый output.
- [x] Убрать runtime Zod instance equality как обязательную семантику там, где
      explicit schema + parsed adapter дают более сильное доказательство.
- [x] Покрыть canonical factory, start→id, start→snapshot→id, distinct follow
      input schemas, cancel output contract, optional capabilities, invalid
      adapter result, generic-widening negative inference и type errors.
- [x] Обновить exports, ADR/reference/guide/generated docs/changelog и packed
      public-surface fixture.

## Acceptance

- [x] Типовой operation contract описывается один раз через named Zod schemas.
- [x] Existing `start → snapshot`, `status/wait → { id }` связывается без casts
      и ручного duplicate protocol metadata.
- [x] Неверный capability key/adapter type не компилируется; невалидный result
      нетипизированного adapter'а даёт capability-specific error при вызове.
- [x] Ни factory, ни binder не запускают jobs и не монтируют скрытый router.
- [x] Runtime-only и contract-backed docs показывают одну и ту же capability
      vocabulary.
- [x] `bun run verify` зелёный.

## Конвейер 2/2

- [x] Plan validator 1/2 — зафиксированы caller/direction/runtime invocation.
- [x] Plan validator 2/2 — зафиксирована Zod transform boundary и canonical output.
- [x] Implementation validator 1/2 — PASS: capability keys, adapter outputs и
      literal scopes удерживаются public types и runtime diagnostics.
- [x] Implementation validator 2/2 — PASS: canonical/direct wire-stable IDs и
      transformed adapted IDs не пересекают Zod boundary дважды.

## Что сделано

- [x] Core: `defineAsyncOperationContract` создаёт canonical
      start/status/wait/cancel/result/artifacts contract; adapted
      `bindContractAsyncOperation` связывает существующие start snapshots и
      разные follow-up envelopes через typed adapters.
- [x] Safety/types: optional capabilities fail loud, wait/status schema contract
      проверяется, literal scopes сохраняются; direct mode отвергает любой
      non-wire-stable ID и направляет в adapted binding.
- [x] Регрессии:
      `packages/core/tests/async-operation.test.ts::canonical contract factory declares one complete capability vocabulary`;
      `packages/core/tests/async-operation.test.ts::direct ID adapters reject same-type transforms that would parse a value twice`;
      `packages/core/tests/async-operation.test.ts::adapted binding parses a transformed id once and projects its parsed value to wire inputs`;
      `packages/core/tests/async-operation.test.ts::contract-backed adapters project start snapshots into distinct follow inputs`.
