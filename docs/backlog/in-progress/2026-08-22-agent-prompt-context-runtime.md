---
title: "Composable prompt and context-budget runtime"
description: "Вынести prompt construction и context budgeting, оставив domain content и provider cache policy typed contributions."
type: task
status: in-progress
created: 2026-08-22
updated: 2026-08-22
related:
  - docs/backlog/in-progress/2026-08-22-agent-runtime-framework.md
  - docs/backlog/in-progress/2026-08-22-agent-message-history-runtime.md
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

- [ ] Зафиксировать section model, ordering и domain extension API.
- [ ] Определить budget inputs, provenance и estimator contract.
- [ ] Учесть tools, multimodal inputs, output reserve и provider overhead.
- [ ] Изолировать provider cache controls в adapters.
- [ ] Добавить presets и custom contributions без fork engine.
- [ ] Покрыть unknown token count, oversized single turn и model switch.

## Acceptance

- [ ] Standard consumer не пишет собственный history slicer или token-budget arithmetic.
- [ ] Каждый removed/truncated contribution объяснён typed decision, не silent mutation.
- [ ] Domain content типизирован и проходит общий ordering/budget pipeline.
- [ ] Отсутствующая оценка не превращается в ноль или ложную точность.

## Конвейер 2/2 с остановкой

- [x] Plan validator 1: prompt ergonomics, presets и domain extensibility.
- [x] Plan validator 2: budget correctness, provider overhead и oversize policy.
- [ ] Implementation validator 1: types/docs and provider adapter isolation.
- [ ] Implementation validator 2: model-switch, multimodal and oversize probes.
