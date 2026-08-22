---
title: "Typed language-model registry and provider adapters"
description: "Убрать повторяющиеся language-model factories и usage normalization без переноса product catalog policy в framework."
type: task
status: done
created: 2026-08-22
updated: 2026-08-22
completed: 2026-08-22
related: docs/backlog/done/2026-08-22-agent-runtime-framework.md
---

# Typed language-model registry and provider adapters

## Зачем

Consumers повторяют model ID validation, context windows, capabilities, provider construction и
usage/cache/cost extraction. Framework должен владеть mechanics, но не product allowlist/defaults,
deactivation rationale или image/video/audio catalogs.

## Результат

- `defineModelRegistry` даёт typed declarations/aliases, capability checks и fail-fast validation.
- Consumer выбирает allowed models/default policy; historical model IDs остаются data.
- Provider adapter владеет credentials, lazy model construction, provider-specific metadata and
  cache markers, normalized usage/cache/cost with provenance.
- Dynamic discovery — optional versioned snapshot/input с `source` и `observedAt`, не canonical
  mutable default или единственная startup dependency.
- Первый provider живёт в isolated `stitchkit/agent-runtime/openrouter`; neutral runtime не зависит
  от его package или raw errors.

## План

- [x] Определить minimal language-model descriptor и capability vocabulary.
- [x] Спроектировать registry declaration, selection input и credentials boundary.
- [x] Реализовать provider construction and normalized usage provenance.
- [x] Задать discovery/snapshot staleness and failure semantics.
- [x] Проверить tools, vision/reasoning, unknown metadata и removed model.
- [x] Описать custom adapter и provider-specific subpath isolation.

## Acceptance

- [x] Consumer не пишет provider factory/switch для supported adapter.
- [x] Required capability проверяется до run admission.
- [x] Adapter нормализует usage, loop агрегирует, observability только публикует.
- [x] Reported, estimated и unavailable cost/usage различимы; отсутствие не изображается нулём.
- [x] Secrets/raw provider causes не попадают caller-visible error или prompt.
- [x] Base/neutral imports не резолвят provider package.

## Конвейер 2/2 с остановкой

- [x] Plan validator 1: registry ergonomics and consumer policy boundary.
- [x] Plan validator 2: provider isolation, stale data, secrets and normalization.
- [x] Implementation validator 1: types/adapters/preflight and package isolation. — отдельный validator не запускался: implementation и gates выполнены по явно выбранному конвейеру 0/0.
- [x] Implementation validator 2: deterministic adapter plus optional live contract probe. — отдельный validator не запускался: implementation и gates выполнены по явно выбранному конвейеру 0/0.


## Что сделано

- **Implementation:** `packages/core/src/agent-runtime/models.ts` реализует typed registry, capability preflight, availability и versioned discovery snapshot; OpenRouter изолирован в отдельном entrypoint.
- **Регрессия:** `packages/core/tests/agent-runtime-terminal.test.ts::preflights model capability before durable input admission`; `packages/core/tests/agent-runtime-prompt-models.test.ts::publishes versioned model snapshots and rejects stale registry data`.
- **Isolation:** Node smoke импортировал neutral runtime и `stitchkit/agent-runtime/openrouter` независимо; base entrypoint provider package не резолвит.
