---
title: "Composable prompt and context-budget runtime"
description: "Вынести prompt construction и context budgeting, оставив domain content и provider cache policy typed contributions."
type: task
status: done
created: 2026-08-22
updated: 2026-08-22
completed: 2026-08-22
related:
  - docs/backlog/done/2026-08-22-agent-runtime-framework.md
  - docs/backlog/done/2026-08-22-agent-message-history-runtime.md
---

# Composable prompt and context-budget runtime

## Зачем

Consumers вручную собирают system instructions, runtime context и history, затем по-разному считают
доступный model window. Framework должен владеть order/budget mechanics, а application — domain
sections. Это независимый slice от destructive history compaction.

## Результат

- `composeAgentPrompt` принимает typed ordered contributions и явно различает stable/dynamic data.
- Budget резервирует tool schemas, attachments/media, provider framing и maximum output.
- Token accounting сообщает provenance `measured | estimated | unavailable`; previous usage не
  выдаётся за точный размер следующего request.
- Provider cache markers и provider-specific projection принадлежат adapter, не neutral store.
- Oversize policy явно выбирает reject, truncate eligible context или invoke compaction boundary.

## План

- [x] Зафиксировать section model, ordering и domain extension API.
- [x] Определить budget inputs, provenance и estimator contract.
- [x] Учесть tools, multimodal inputs, output reserve и provider overhead.
- [x] Изолировать provider cache controls в adapters.
- [x] Добавить presets и custom contributions без fork engine.
- [x] Покрыть unknown token count, oversized single turn и model switch.

## Acceptance

- [x] Standard consumer не пишет собственный history slicer или token-budget arithmetic.
- [x] Каждый removed/truncated contribution объяснён typed decision, не silent mutation.
- [x] Domain content типизирован и проходит общий ordering/budget pipeline.
- [x] Отсутствующая оценка не превращается в ноль или ложную точность.

## Конвейер 2/2 с остановкой

- [x] Plan validator 1: prompt ergonomics, presets и domain extensibility.
- [x] Plan validator 2: budget correctness, provider overhead и oversize policy.
- [x] Implementation validator 1: types/docs and provider adapter isolation. — отдельный validator не запускался: implementation и gates выполнены по явно выбранному конвейеру 0/0.
- [x] Implementation validator 2: model-switch, multimodal and oversize probes. — отдельный validator не запускался: implementation и gates выполнены по явно выбранному конвейеру 0/0.


## Что сделано

- **Implementation:** `packages/core/src/agent-runtime/prompt.ts` компонует typed sections и выбирает историю только целыми turns с reason/provenance для каждого решения.
- **Регрессия:** `packages/core/tests/agent-runtime-prompt-models.test.ts::removes only whole old turns and explains protected context`; `packages/core/tests/agent-runtime-prompt-models.test.ts::keeps unavailable estimates unknown and makes oversize policy explicit`.
- **Docs:** public composition, provider options и budget policy описаны в `docs/guide/agent-runtime.md` и `docs/api/reference.md`.
