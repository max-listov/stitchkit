---
title: "Multimodal agent history projection"
description: "Проецировать durable file references в настоящие model file/image parts через resolver."
type: task
status: done
created: 2026-08-22
updated: 2026-08-22
completed: 2026-08-22 16:22 +0000
related:
  - docs/backlog/in-progress/2026-08-22-agent-runtime-consumer-parity.md
---

# Multimodal agent history projection

## План

- [x] Добавить async resolver canonical file reference → supported model content.
- [x] Не превращать resolvable image/file parts в текстовые placeholders.
- [x] Сохранить explicit fallback policy для unresolved attachments.

## Acceptance

- [x] Image history приходит модели как multimodal part с исходным media type.
- [x] Store остаётся storage-neutral и хранит reference, не provider object.

## Конвейер 0/0

Без validators; gates — отдельной командой.

## Проверено

- `packages/core/tests/agent-runtime-history.test.ts` — `resolves durable image references into real
  multimodal file parts`.

## Что сделано

- [x] `packages/core/src/agent-runtime/history.ts` проецирует canonical file reference через async
  resolver в настоящий AI SDK file part с исходным media type.
- [x] `packages/core/src/agent-runtime/schemas.ts` сохраняет storage-neutral durable reference.
- [x] Regression case указан в разделе `Проверено`.
