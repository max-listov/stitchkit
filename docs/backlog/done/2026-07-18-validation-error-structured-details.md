---
title: VALIDATION_ERROR несёт структурные details.issues + экспорт zodIssues
description: Ответ на фидбек агента gecko-voice. Он не мог использовать createErrorHook, потому что normalizeError плющил ZodError-issues в текстовый message, а его machine-клиенту нужны структурные поля. Фикс — normalizeError кладёт { path, code, message }[] в details, + экспорт zodIssues(). Отвергнуто его же предложение нормализовать ДО хука (теряет сырой ZodError).
type: task
status: done
created: 2026-07-18
updated: 2026-07-18
completed: 2026-07-18 18:00 +08:00
related: docs/backlog/done/2026-07-18-errorhook-normalize-and-stringbool.md
---

# VALIDATION_ERROR → structured details.issues + zodIssues export

## Контекст (фидбек агента после 0.21.0)

Агент подтвердил, что его кастомный `onError` (без `createErrorHook`) получает
сырой ZodError — верно, ядро нормализует только при отсутствии хука. Предложил:
нормализовать в `respondError` ДО вызова хука.

## Анализ

**Отвергнуто «нормализовать до хука»** — его же кейс это опровергает: он извлекает
`ZodError.issues` для machine-клиента (хаба), а `normalizeError` плющил issues в
текстовый `message`. Пре-нормализация лишила бы его (и всех) сырого сигнала.
Правильный дизайн — трёхслойный, уже есть: сырой error в хук / `normalizeError`
экспортнут / `createErrorHook` зовёт его внутри.

**Настоящий корень** (почему агент не мог пойти batteries-included путём):
`VALIDATION_ERROR` нёс issues только в тексте, `details` пустой. Фикс — дать
структуру.

## Что сделано

- [x] `internal/errors.ts`: `normalizeError(ZodError)` кладёт `details: { issues: [{ path, code, message }] }` (cap 20), текст message сохранён
- [x] `zodIssues(error)` + `ZodIssueSummary` — структурная проекция (сиблинг formatZodError); рефактор `issuePath` (общий для обоих)
- [x] Экспорт `zodIssues` / `ZodIssueSummary` из `stitchkit/server`
- [x] Тесты: `errors.test.ts` (normalizeError → details.issues; zodIssues path/code/message; (root)) — 28 pass в связке
- [x] Доки: reference.md (zodIssues + обновлён normalizeError), guide error-envelope (пример с issues), createErrorHook note (info.details.issues снимает блокер), контракт onError «сырое в хук»
- [x] CHANGELOG `[0.22.0]` (Added / Docs)

## Что НЕ делалось

- Нормализация в `respondError` до хука — отвергнута (теряет сырой ZodError, ломает инспекцию полей).
- Cap на issues в details = 20 (bounds response size; текстовый message по-прежнему cap 5).

## Для агента

Теперь `VALIDATION_ERROR.details.issues` — структурные поля. Его ZodError-ветка
может либо перейти на `createErrorHook` (issues приходят в `info.details`), либо
остаться, но использовать экспортнутый `zodIssues(err)` вместо ручного разбора.

Вышло в релизе 0.22.0.
