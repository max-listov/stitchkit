---
title: Коды отказа приёма превращаются в generic 500
description: ApplicationAdmissionError и GrammyWebhookUnavailableError наследуются от обычного Error, поэтому normalizeError отдаёт 500 вместо объявленного 503.
type: task
status: done
tags: [application, errors, published-bug]
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25 04:04 +00:00
---

# Коды отказа приёма превращаются в generic 500

## Зачем

Дефект в **опубликованном** 0.60.0. Проверено чтением:

- `application/kernel.ts:131` — `class ApplicationAdmissionError extends Error`
  с полем `code`, но это не `AppError`.
- `application/grammy.ts:124` — `GrammyWebhookUnavailableError` устроен так же.
- `internal/errors.ts:89` — `normalizeError` начинается с `AppError.is(err)`;
  для обычного `Error` дальше идёт generic-ветка → `INTERNAL_SERVER_ERROR`/500.

Следствия: объявленный `APPLICATION_NOT_ACCEPTING`/503 до HTTP не доходит,
`createErrorHook({ unmappedCode })` его не видит, а документация про «ошибка
путешествует сама собой» неверна.

Добавление строки в `STITCH_ERROR_STATUS` доказало членство в реестре, но не
поведение транспорта — реестр и `normalizeError` проверялись порознь.

## Результат

- `ApplicationAdmissionError` — брендированный `AppError<'APPLICATION_NOT_ACCEPTING'>`.
- grammY-ошибка тоже брендирована; её provider-specific код может остаться вне
  общего реестра, но `AppError`-природа обязательна.
- Регрессия поведенческая: настоящий `createErrorHook`, настоящий ответ, статус
  503 и код в теле — а не проверка членства в реестре.

## План

- [x] Перевести оба класса на `AppError`, сохранив имя и сообщение.
- [x] Тест: запрос через реальный pipeline при закрытом приёме отдаёт 503 с
      кодом, и `unmappedCode` не срабатывает.
- [x] Проверить, нет ли других `extends Error` с полем `code`, которые
      обещают транспортный код.
- [x] `CHANGELOG.md`: это исправление поведения публичной поверхности.

## Acceptance

- [x] Отказ приёма доходит до вызывающего как 503 с объявленным кодом.
- [x] `bun run verify` зелёный.

## Что сделано

- [x] `ApplicationAdmissionError` и `GrammyWebhookUnavailableError` —
      брендированные `AppError` со статусом 503.
- [x] `GRAMMY_WEBHOOK_NOT_ACCEPTING` добавлен в `STITCH_ERROR_STATUS`: код,
      который бросает фреймворк, реестр обязан знать, кто бы ни стоял за ним.
- [x] **Дыра в самом гейте полноты закрыта**: он искал только
      `new AppError('CODE'` и не видел `super('CODE'` в подклассе — то есть
      ровно тот способ, которым оба кода и разошлись с реестром. Скан теперь
      идёт за кодом, а не за одной формой записи; проверено на убийство.
- [x] Поведенческая регрессия в `error-hook.test.ts`: обе ошибки проходят
      настоящий `createErrorHook` и приходят как 503 с отображённым кодом.
- [x] `CHANGELOG.md` → `[0.60.1]`.
