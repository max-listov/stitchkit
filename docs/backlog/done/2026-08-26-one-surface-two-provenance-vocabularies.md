---
title: One surface, two provenance vocabularies
description: AgentUsageValue and AgentTokenCount describe token counts for the same request with different words and different numeric types.
type: task
status: done
created: 2026-08-26
updated: 2026-08-26
completed: 2026-08-26 03:30 +00:00
---

## Зачем

Two enums in one entrypoint describe the same kind of fact — how a token count
came to be known — and they do not share a word:

| type | provenance values | number |
|---|---|---|
| `AgentUsageValue` (`schemas.ts`) | `provider-reported`, `computed`, `estimated`, `unavailable` | `z.number()` — **accepts 3.5 tokens** |
| `AgentTokenCount` (`prompt.ts`) | `measured`, `estimated`, `unavailable` | `z.int()` |

Both describe token counts for the same request: `AgentPromptBudget.toolSchemas`
beside `AgentUsage.inputTokens`. Neither accepts the other's terms — a probe
confirms `AgentUsage` rejects `measured` and `AgentTokenCount` rejects
`provider-reported`. A consumer holding both writes two switches over what is
conceptually one question, and `measured` versus `provider-reported` is a
distinction nobody can explain without reading both files.

This is not wrong today. It is the shape most likely to have to break later,
which is exactly what a stable declaration must not carry (→ ADR 0111).

## Результат

- One vocabulary for how a number came to be known, or a written reason why two
  are correct.
- Token counts are integers wherever they are counted.

## План

- [x] Decide whether `measured` and `provider-reported` are the same fact. If
      they are, one word survives and the other is a breaking rename.
- [x] Decide whether a budget estimate and a spend figure genuinely need
      different vocabularies — a defensible answer is that one is a *forecast*
      and the other a *report*, and if so, say it where both are defined.
- [x] Make token counts integral in both. A fractional token is not a thing, and
      `z.number()` accepting `3.5` is how a bad estimator's output survives
      validation.
- [x] Whatever is decided lands before any promotion to stable, because it is a
      rename across a public surface.

## Acceptance

- [x] A test enumerates both vocabularies and fails if they diverge again in a
      way the decision did not sanction.
- [x] A fractional token count is refused wherever tokens are counted.

## Что сделано

### Решение

- **Оба слова остаются, потому что это разные факты.** `measured` — этот процесс
  посчитал число точно, до всякого запроса (токенайзер над строкой).
  `provider-reported` — провайдер сообщил число о запросе, который он обслужил.
  Ни одна поверхность не может произвести чужое слово, и это проверяется.
- **Вокабуляр один, подмножества разные.** `AgentProvenanceSchema` в
  `packages/core/src/agent-runtime/schemas.ts` перечисляет все пять слов; каждая
  поверхность объявляет своё подмножество через `.extract`. Ни одна не
  расширилась — исчерпывающий `switch` читателя по-прежнему видит ровно то, что
  эта поверхность выдаёт.
- **Сумма — это `computed`, а не `measured`.** То же правило, что `addUsage`
  давно применяет к расходу прогона. Оценка переживает арифметику: одна
  оценённая часть делает сумму оценкой.

### Core

- [x] `packages/core/src/agent-runtime/schemas.ts` — `AgentProvenanceSchema`,
      `AgentUsageValueSchema.value` и `AgentCostValueSchema.provenance` через
      `.extract`; `value` стал `z.int()`, у стоимости остался `z.number()`.
- [x] `packages/core/src/agent-runtime/prompt.ts` — `AgentTokenCountSchema` из
      общего вокабуляра; суммы `totalTokens` и `instructionTokens` теперь
      `computed`; результаты `estimateTokens`, `estimateFallback`,
      `historyTokens` и трёх полей `AgentPromptBudget` парсятся, а
      `contextWindow`/`reservedOutput` проверяются на целость.
- [x] `packages/core/src/agent-runtime/runtime-internals.ts` и
      `packages/core/src/agent-runtime-openrouter.ts` — нецелое число от
      провайдера становится `{ provenance: 'unavailable' }`, а не исключением из
      терминального коммита уже ответившего прогона.

### Tests

- [x] `packages/core/tests/agent-runtime-provenance.test.ts` — 13 тестов:
      перечисление трёх списков и их пересечения (`one provenance vocabulary`),
      отказ дробному счётчику на каждой поверхности (`a token is an integer`),
      `computed` у сумм (`a total is computed, not measured`), отказ плохому
      оценщику (`a bad estimator does not reach the window arithmetic`).
- [x] `packages/core/tests/agent-runtime-supersede.test.ts` — ожидание
      `totalTokens` обновлено на `computed`.
- [x] Каждая правка фальсифицирована откатом по отдельности: все четыре
      обрушили тест.

### Docs

- [x] `docs/api/reference.md` — абзац про `AgentProvenanceSchema`.
- [x] `CHANGELOG.md` — `### ⚠️ Breaking changes` в `[Unreleased]`.
- [x] `docs/guide/upgrading.md` — `## Unreleased migration: one provenance
      vocabulary, and integral tokens`.
- [x] `packages/core/tests/fixtures/public-surface.json` — два новых экспорта.

### Чего не сделано

- Ничего из плана не отложено.
