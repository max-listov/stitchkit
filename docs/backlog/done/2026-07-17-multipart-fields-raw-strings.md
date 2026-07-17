---
title: Multipart-поля — сырые строки, схема коэрсит (убрать content-sniffing футган)
description: parseMultipart прогонял каждое текстовое поле через JSON.parse — тип поля зависел от содержимого строки ('33111715' → number, ловил z.string() → 400 по лотерее). Фикс — поля остаются строками, тип определяет Zod-схема (z.coerce), как с query-параметрами.
type: task
status: done
created: 2026-07-17
updated: 2026-07-17
completed: 2026-07-17 12:00 +08:00
---

# Multipart text fields → raw strings (schema owns the type)

## Проблема (найдено на живой миграции, др. агент)

`parseMultipart` (`server/multipart.ts`) прогонял каждое текстовое поле через
`safeJsonParse` → тип поля определялся **содержимым строки**, а не контрактом:
`'33111715'` → `number` (ловил `z.string()` → 400), `'true'` → bool, `'[1,2]'` →
массив, `'ab12cd34'` → строка. Лотерея по символам id (~2.3% запросов 400).
Нарушение §7 (схема — единственный источник правды о типе, не эвристика по данным).
Тот же класс, что query-параметры в 0.18, только инвертированный.

## Решение (Option A — чини source)

Поля остаются сырыми строками; тип определяет Zod-схема через `z.coerce`, объект
в поле — явный опт-ин `z.preprocess`. Ровно конвенция query-input.

## Что сделано

- [x] `server/multipart.ts`: блок `JSON.parse`-полей заменён на `fields[key] = value`; убран импорт `safeJsonParse` (остался `isUnsafeKey`); docstring переписан
- [x] `tests/multipart.test.ts`: переписан вводящий в заблуждение тест «parses JSON string fields» → «numeric id stays string под z.string()»; новый блок «multipart field typing» (z.coerce.number/boolean, z.preprocess-JSON, raw-string). 17 pass
- [x] `docs/guide/contracts.md`: раздел «Multipart text fields» (зеркало query-input)
- [x] CHANGELOG `### ⚠️ Breaking changes` с before→after (z.number→z.coerce.number, объект→z.preprocess)
- [x] Бонус: убран value-level proto-pollution вектор (парсинг значений полей)

## Что НЕ делалось

- Клиент (`appendFormFields`) не трогался — он и так шлёт `String(value)`/`JSON.stringify`, симметрично: скаляр→строка→`z.coerce`, объект→JSON-текст→`z.preprocess`.
- Костыль B (`z.coerce.string()` в потребителе) отвергнут (§28/§12 — симптом, футган остаётся всем).
- Потребители (hub/gecko/bro) — их `z.string()` заработает как есть; `z.number()` на multipart-поле → `z.coerce.number()` (делает агент в их репо).

## Ссылки

Вышло в релизе 0.20.0. Код: `packages/core/src/server/multipart.ts`.
