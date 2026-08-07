---
title: createErrorHook нормализует ZodError → 400 + экспорт normalizeError + фикс boolean-migration на z.stringbool
description: Два пункта от агента на живой миграции потребителя. 1) createErrorHook мапил любой не-AppError в 500 — client fault (ZodError) одет как server fault; фикс — нормализация через normalizeError + экспорт его наружу. 2) migration-подсказка z.coerce.boolean() — footgun ('false'→true); правильно z.stringbool() (Zod v4).
type: task
status: done
created: 2026-07-18
updated: 2026-07-18
completed: 2026-07-18 12:00 +08:00
---

# createErrorHook normalize + normalizeError export + z.stringbool

## Контекст

Агент на миграции потребителя словил `500 UNKNOWN_ERROR` на кривой input вместо
честного 4xx. Прочитал исходник 0.20.0 (только читал), прислал два пункта.

## Анализ (проткнуто по исходнику)

**Пункт 1 — ZodError → 500.** Симптом реален, но диагноз агента смещён:
- Ядро (`create.ts` `respondError` → `normalizeError`) **уже** отдаёт 400 на ZodError без кастомного onError.
- Течёт только с кастомным onError — главный виновник мой `createErrorHook` (0.19): `AppError.is ? … : 500`, мимо `normalizeError`.
- Предложение агента «обернуть в parseMultipart» — не тот слой (ядро намеренно бросает сырой ZodError, чтобы onError мог заглянуть в поля).

**Пункт 2 — multipart coercion.** Поведение верное (schema owns type, консистентно с query; авто-коэрция = возврат футгана). Но агент вскрыл баг в МОЁМ migration-гайде: `z.coerce.boolean().parse('false') === true` (проверено на Zod 4.4.3). Правильно — `z.stringbool()`.

## Что сделано

- [x] `server/error-hook.ts`: `createErrorHook` нормализует через `normalizeError` → ZodError = 400 VALIDATION_ERROR (ремапится codeMap), AppError сохраняет код/статус, прочее = generic 500 без утечки
- [x] `server/index.ts`: экспорт `normalizeError` / `errorCode` / `formatZodError` (были только `internal/`) — для bespoke onError
- [x] Тест `error-hook.test.ts`: ZodError → 400 `bad_request` + поле в message (5 pass)
- [x] Фикс `z.coerce.boolean()` → `z.stringbool()`: docstring `multipart.ts`, `contracts.md` (multipart И query), CHANGELOG 0.20.0-запись
- [x] Тест `multipart.test.ts`: TypedSchema на `z.stringbool()` + новый кейс `'false'` → false (падал бы на coerce.boolean)
- [x] reference.md + guide (createErrorHook: ZodError→400 + normalizeError для кастомного onError)
- [x] CHANGELOG `[0.21.0]` (Fixed / Added / Docs)

## Что НЕ делалось

- Обёртка ZodError в `parseMultipart`/`parseRequestInto` — отвергнута (не тот слой, ломает инспекцию полей в onError).
- Авто-коэрция multipart во фреймворке — отвергнута (противоречит фиксу 0.20, §7).

Вышло в релизе 0.21.0. Потребитель уже отдавал 400 самостоятельно, но фикс
закрывает грабли для всех консьюмеров.
