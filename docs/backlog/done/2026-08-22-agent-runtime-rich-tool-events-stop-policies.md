---
title: "Rich tool events and named stop policies"
description: "Публиковать safe tool input/result и поддержать named custom loop stop conditions."
type: task
status: done
created: 2026-08-22
updated: 2026-08-22
completed: 2026-08-22 16:22 +0000
related:
  - docs/backlog/in-progress/2026-08-22-agent-runtime-consumer-parity.md
---

# Rich tool events and named stop policies

## План

- [x] Расширить stable tool event optional JSON-safe input/output metadata.
- [x] Добавить named custom stop policies рядом с max-steps policy.
- [x] Persist/publish имя сработавшей policy без выдачи internal provider errors наружу.

## Acceptance

- [x] UI adapter получает tool input/result без чтения unstable AI SDK union.
- [x] Consumer выражает repeated-error и другие stop conditions без собственного loop.
- [x] Sensitive/internal tool errors не становятся public payload по умолчанию.

## Конвейер 0/0

Без validators; gates — отдельной командой.

## Проверено

- `packages/core/tests/agent-runtime-parity.test.ts` — `publishes safe tool payloads and the name of a
  custom stop policy`, `redacts internal tool failures from application events`.

## Что сделано

- [x] `packages/core/src/agent-runtime/events.ts` задаёт stable JSON-safe tool status payload.
- [x] `packages/core/src/agent-runtime/runtime.ts` публикует tool input/result, redacts internal
  failures и сохраняет имя сработавшей custom stop policy.
- [x] Regression cases перечислены в разделе `Проверено`.
