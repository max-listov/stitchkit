---
title: "Isolate client cancellation request assertions"
description: "Убрать межтестовый race из счётчика запросов cancellation regression suite."
type: task
status: done
created: 2026-08-22
updated: 2026-08-22
completed: 2026-08-22
---

# Isolate client cancellation request assertions

## Зачем

Cancellation suite сравнивает общий счётчик HTTP-запросов до и после проверки.
Запоздавшие запросы из предыдущего abort-case могут увеличить этот счётчик и
ложно уронить assertion, хотя already-aborted вызов не отправлялся.

## План

- [x] Считать запросы отдельно по pathname.
- [x] Проверять только endpoint текущего assertion.
- [x] Прогнать suite многократно и полный release gate.

## Acceptance

- [x] Запоздавший запрос другого endpoint не влияет на проверку.
- [x] Реальный запрос проверяемого endpoint по-прежнему обнаруживается.

## Что сделано

- [x] `packages/core/tests/client-cancellation.test.ts` — request assertions
      изолированы по pathname вместо общего межтестового счётчика.
- [x] Регрессия: `packages/core/tests/client-cancellation.test.ts` — `an
      already-aborted signal never sends the request` и `scoped methods preserve
      cancellation without sending prefix keys`.
- [x] Gates: 50 повторов suite — 600 pass; `bun run verify` — green, включая
      packed Bun/Node consumers и оба starter browser lanes.

## Конвейер 0/0

Дополнительные plan и implementation validators не запускаются.
