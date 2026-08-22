---
title: "Provider-aware system instructions"
description: "Сохранять provider metadata system message без протекания provider policy в core."
type: task
status: done
created: 2026-08-22
updated: 2026-08-22
completed: 2026-08-22 16:22 +0000
related:
  - docs/backlog/done/2026-08-22-agent-runtime-consumer-parity.md
---

# Provider-aware system instructions

## План

- [x] Разрешить prompt composer вернуть structured system message, сохраняя string shorthand.
- [x] Передавать provider options без сериализации или потери cache metadata.
- [x] Документировать ownership: consumer/provider adapter задаёт metadata, core только переносит.

## Acceptance

- [x] Structured system message доходит до model call без изменения.
- [x] Provider-neutral consumer по-прежнему использует обычную строку.

## Конвейер 0/0

Без validators; gates — отдельной командой.

## Проверено

- `packages/core/tests/agent-runtime-parity.test.ts` — `passes structured instructions through the
  model boundary`; остальные runtime cases проходят через string shorthand.
- `packages/core/tests/agent-runtime-prompt-models.test.ts` — `preserves provider options on
  structured system instructions`.

## Что сделано

- [x] `packages/core/src/agent-runtime/prompt.ts` принимает AI SDK `Instructions`, сохраняя string
  shorthand и provider options.
- [x] `packages/core/src/agent-runtime/runtime.ts` передаёт structured instructions в model call без
  сериализации.
- [x] Regression cases перечислены в разделе `Проверено`.
