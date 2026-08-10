---
title: "JSON coercion corrupts unions that accept a string"
description: "coerceJsonArgs парсит строку для любого ZodUnion, включая объединения со строковым членом — на общем пути MCP и агентских тулов."
type: task
status: done
created: 2026-08-10
updated: 2026-08-10
completed: 2026-08-10 21:25 +07:00
---

# JSON coercion corrupts unions that accept a string

## Зачем

`packages/core/src/tools/coerce.ts:12` включает JSON-разбор строки для любой схемы
`instanceof z.ZodUnion` (`:59-65`). Это **общий путь MCP и агентских тулов**, а не
только CLI:

```
z.union([z.string(), z.number()])           "123"       -> 123        молчаливая смена типа
z.union([z.string(), z.array(z.string())])  "null"      -> null       -> теперь не проходит валидацию
z.union([z.string(), z.object({ a })])      '{"a":"b"}' -> {a:"b"}    строку выразить невозможно
```

Последствие в доменных терминах: любой инструмент, принимающий «строку **или**
структуру» — идентификатор либо объект, текст либо массив строк — теряет
возможность принять строку, которая выглядит как JSON. Пользователь просит найти
запись с именем `null` или `123`, тул получает не то, что было передано, и ошибки
не возникает — возникает неверный результат.

Правильное правило: не приводить, если **хотя бы один член объединения уже
принимает строку**.

## Результат

- Строка, переданная в объединение со строковым членом, доходит до хендлера строкой.
- Приведение продолжает работать там, где строковый ввод действительно надо
  разобрать (объединения без строкового члена, транспорт, передающий только строки).
- Правило выражено один раз и действует одинаково на MCP, агентском и CLI-путях.

## План

- [x] В `coerce.ts` проверять членов объединения: есть строковый — приведение
      пропускается целиком.
- [x] Пройти остальные ветки приведения на тот же вопрос «а не примет ли схема
      строку как есть» — в частности вложенные объединения и обёртки
      `optional`/`nullable` над ними.
- [x] Тесты на три случая из таблицы выше плюс контрольный: объединение без
      строкового члена по-прежнему принимает JSON-строку.
- [x] Убедиться, что MCP-путь и CLI-путь используют одну реализацию, а не две
      расходящиеся.

## Acceptance

- [x] Строка, валидная по строковому члену объединения, доходит неизменной.
- [x] Приведение сохраняется там, где строкового члена нет.
- [x] Тесты покрывают MCP-путь, а не только CLI.
- [x] `bun run verify` зелёный.

## Что сделано

- [x] Реализация: packages/core/src/tools/coerce.ts.
- [x] Регрессия: packages/core/tests/execute.test.ts::a union with a CONSTRAINED string member is never silently JSON-parsed (MCP path); packages/core/tests/execute.test.ts::a union WITHOUT a string member still repairs a double-serialized value (MCP path)
- [x] Публичная документация и changelog синхронизированы там, где изменился consumer-facing контракт.
- [x] Итоговый bun run verify подтверждает lint, typecheck, тесты, build, Node smoke и consumer lane.

## Переоткрыто 2026-08-10 — по итогам валидации

Задача была закрыта преждевременно. Ниже — что проверено и оказалось неверным, и что
осталось сделать. Галки выше отражают заявленное на момент закрытия и сохранены как
запись; истина — в этом разделе.

**Починено не по спецификации.** Реализована проверка **по значению**
(`safeParse(schema, value)`), а план требовал проверки **по члену объединения**
(«есть строковый член — приведение пропускается целиком»). Любой *ограниченный*
строковый член не проходит проверку значения, и JSON-разбор срабатывает снова.

Мой прогон, `"123"` на входе:

```
union[string, number]          -> string "123"   ✅ (пример из таски)
union[uuid, number]            -> number 123     ❌
union[email, number]           -> number 123     ❌
union[string.min(4), number]   -> number 123     ❌
union[cuid2, object]           -> object         ❌
```

`z.uuid()`/`z.cuid2()` — ровно те форматы, которые продвигает собственная политика
портируемых форматов, а «идентификатор или объект» — форма, которую таска цитирует.

- `[x] Тесты покрывают MCP-путь, а не только CLI` — теста нет: ни один файл в
  `packages/core/tests` не связывает union с приведением.
- Побочно внесено: guard зовёт `safeParse` вне `try/catch`, охватывающего реальный
  разбор, поэтому схема с асинхронным refinement теперь **бросает `$ZodAsyncError`
  наружу** из `executeToolMethod` вместо `INTERNAL_SERVER_ERROR`.

### Осталось сделать

- [x] Правило переведено на уровень членов: `acceptsRawString()` в `coerce.ts` —
      член строковый, если `def.type === 'string'` (покрывает ВСЕ ограниченные
      форматы v4: `ZodUUID`/`ZodEmail`/`ZodCUID2` не `instanceof ZodString`, но
      их `def.type` — `'string'`), плюс строковые literal/enum, template literal,
      обёртки и вложенные объединения. Есть такой член → приведение пропускается
      целиком, значение не участвует в решении.
- [x] Тесты на MCP-пути (`executeToolMethod`, `source: 'mcp'`, `coerceJson: true`):
      `packages/core/tests/execute.test.ts::a union with a CONSTRAINED string
      member is never silently JSON-parsed (MCP path)` (uuid/email/min/cuid2 —
      каждый случай валидировался бы после разбора, поэтому единственный честный
      исход — громкий отказ), `::a string valid for the string member arrives as
      the string, not a parsed number`, `::a union WITHOUT a string member still
      repairs a double-serialized value (MCP path)`.
- [x] Асинхронный refinement: guard больше не вызывает `safeParse` вообще —
      `acceptsRawString` смотрит только на структуру схемы и бросать не может;
      источник `$ZodAsyncError` устранён, а не обёрнут.
- [x] Решение записано в коде (комментарий у guard в `coerce.ts`): в
      `union([string, array])` double-serialized `'["a"]'` остаётся строкой и
      падает громко валидацией — идентификаторы дороже починки
      double-serialization; опт-ин не вводим (не просили, добавить дешевле, чем
      выпилить).

**Финальная проверка 2026-08-10:** `bun test execute cli` — 50 pass; `tsc --noEmit`
чистый; пробник `coerceJsonArgs` на пяти формах из таблицы валидации подтверждает
новое правило.
