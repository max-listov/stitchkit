---
title: "Typed language-model registry and provider adapters"
description: "Убрать повторяющиеся language-model factories и usage normalization без переноса product catalog policy в framework."
type: task
status: in-progress
created: 2026-08-22
updated: 2026-08-22
related: docs/backlog/in-progress/2026-08-22-agent-runtime-framework.md
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

- [ ] Определить minimal language-model descriptor и capability vocabulary.
- [ ] Спроектировать registry declaration, selection input и credentials boundary.
- [ ] Реализовать provider construction and normalized usage provenance.
- [ ] Задать discovery/snapshot staleness and failure semantics.
- [ ] Проверить tools, vision/reasoning, unknown metadata и removed model.
- [ ] Описать custom adapter и provider-specific subpath isolation.

## Acceptance

- [ ] Consumer не пишет provider factory/switch для supported adapter.
- [ ] Required capability проверяется до run admission.
- [ ] Adapter нормализует usage, loop агрегирует, observability только публикует.
- [ ] Reported, estimated и unavailable cost/usage различимы; отсутствие не изображается нулём.
- [ ] Secrets/raw provider causes не попадают caller-visible error или prompt.
- [ ] Base/neutral imports не резолвят provider package.

## Конвейер 2/2 с остановкой

- [x] Plan validator 1: registry ergonomics and consumer policy boundary.
- [x] Plan validator 2: provider isolation, stale data, secrets and normalization.
- [ ] Implementation validator 1: types/adapters/preflight and package isolation.
- [ ] Implementation validator 2: deterministic adapter plus optional live contract probe.
