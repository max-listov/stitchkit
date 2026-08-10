---
title: "Audit payload serialisation semantics"
description: "Дефолтный набор ключей уничтожает идентификаторы, Map/Set/Error схлопываются в пустой объект, а обрезка превью рвёт суррогатные пары."
type: task
status: done
created: 2026-08-10
updated: 2026-08-10
completed: 2026-08-10 21:00 +07:00
related:
  - docs/backlog/planned/2026-08-10-sanitize-regex-leaks-every-other-secret.md
---

# Audit payload serialisation semantics

## Зачем

Три вопроса семантики в одном слое; корневой баг с флагом регулярки ведётся
отдельно, здесь — что и как мы вообще пишем в аудит.

**Дефолтный набор ключей переredactивает.** `sanitize.ts:36`: `author`, `authorId`,
`sessionCount`, `tokenizer`, `authorized` — все становятся `[redacted]` (проверено).
Уничтожать `authorId` в строке **аудита** — ощутимая потеря: именно по нему потом
и ищут. Сопоставление идёт по вхождению подстроки, а не по границам.

**`Map`, `Set` и `Error` молча схлопываются в `{}`** (`sanitize.ts:82-93`). При этом
`setRequestError({ details: err })` явно поддержан
(`observability/context.ts:113-125`), то есть `message` и `stack` теряются ровно
там, где нужнее всего.

**Обрезка превью считает не то и рвёт строку.** `sanitize.ts:105-114` режет по
кодовым единицам UTF-16 против байтового бюджета: заявленный `maxBytes 1000` даёт
2056 байт, дефолтные 16000 — 32057. Опаснее перерасхода разрыв суррогатной пары:
`preview.isWellFormed()` ложен, `JSON.stringify` выдаёт непарный `\udXXX`, и
**PostgreSQL `jsonb` такую строку отвергает** — сток падает ровно на тех больших
строках, ради которых предел и вводился.

## Результат

- Идентификаторы, ради которых аудит ведётся, переживают редактирование; секреты —
  нет.
- `Map`, `Set` и `Error` сохраняют содержательную форму.
- Обрезка соблюдает байтовый бюджет и никогда не порождает непарный суррогат.

## План

- [x] Пересмотреть дефолтный набор: сопоставление по границам вместо вхождения,
      чтобы `authorId` и подобные выживали.
- [x] `Map`/`Set` сериализовать в обозримую форму, `Error` — в
      `{ name, message, stack? }` с учётом действующих правил редактирования.
- [x] Считать байты (`TextEncoder`) и резать по границе кодовой точки.
- [x] Тест: строка из суррогатных пар укладывается в бюджет и `isWellFormed()`
      истинен; усечённое значение принимается `jsonb`.
- [x] Тест: `authorId` присутствует, а секреты отсутствуют.

## Что сделано

- [x] Реализация: packages/core/src/observability/audit.ts and packages/core/src/observability/sanitize.ts.
- [x] Регрессия: packages/core/tests/sanitize.test.ts::masks compound key names carrying a secret word (regression: anchored matching); packages/core/tests/sanitize.test.ts::truncating a large payload does not starve the event loop (regression: quadratic re-encode); packages/core/tests/sanitize.test.ts::serialises Map, Set and Error into useful JSON-safe shapes
- [x] Публичная документация и changelog синхронизированы там, где изменился consumer-facing контракт.
- [x] Итоговый bun run verify подтверждает lint, typecheck, тесты, build, Node smoke и consumer lane.

## Переоткрыто 2026-08-10 — по итогам валидации

Задача была закрыта преждевременно. Ниже — что проверено и оказалось неверным, и что
осталось сделать. Галки выше отражают заявленное на момент закрытия и сохранены как
запись; истина — в этом разделе.

**Ложные и опасные результаты этого захода.**

- `[x] сопоставление по границам, чтобы `authorId` выжил` — сделано **заякоривание**
  `^(…)$`, а не границы. Прогон `redact()` с дефолтами: `sessionToken`,
  `clientSecret`, `dbPassword`, `apiToken`, `authorizationHeader`, `cookieHeader`,
  `passwordHash`, `X-Api-Key` → `SECRET-VALUE` вместо `[redacted]`. Маскируется
  только точное имя; в реальном коде имена почти всегда составные. Это регрессия
  безопасности, внесённая фиксом.
- Тест, стерёгший этот класс, развёрнут в том же заходе:
  `sanitize.test.ts` `sessionId: '[redacted]'` → `sessionId: 'sess-1'`. Подгонка
  теста под код.
- `[x] Считать байты (TextEncoder) и резать по границе кодовой точки` — реализовано
  квадратично: `truncatePreview` перекодирует весь накопленный префикс на каждом
  символе. Замер: 16 КБ (дефолт) — 1092 мс, 32 КБ — 4424 мс, **0 тиков таймера 10 мс
  за 4.3 с**, то есть стоит весь процесс. Аргументы тула управляются моделью →
  удалённый DoS, внесённый фиксом. Нарушено собственное обещание `audit.ts`.
- `[x] усечённое значение принимается jsonb` — ложь: PostgreSQL в наборе тестов ядра нет.

### Осталось сделать

- [x] Вернуть сопоставление по границам слова вместо заякоривания: `authorId` и
      `sessionCount` выживают, `sessionToken`/`clientSecret`/`dbPassword`/`apiToken`/
      `authorizationHeader`/`cookieHeader`/`passwordHash`/`X-Api-Key` маскируются —
      `isSensitiveKeyDefault` в `sanitize.ts`: разбиение ключа на слова
      (camelCase, acronym-runs, `-`/`_`/пробелы) + наборы слов, пар слов
      (`apiKey`, `sessionId`) и точных имён (`session`). Кастомный
      `sensitiveKeys: RegExp` сохраняет прежний контракт.
- [x] Вернуть в `sanitize.test.ts` проверку составных имён — `sessionId` снова
      `[redacted]`; регрессионная таблица из 12 составных ключей:
      `packages/core/tests/sanitize.test.ts::masks compound key names carrying a
      secret word (regression: anchored matching)` + обратная проверка
      `::word-boundary matching survives benign compounds around secret-looking words`.
- [x] Переписать `truncatePreview` на однократное кодирование со срезом по границе
      кодовой точки — encode один раз, откат по continuation-байтам UTF-8,
      decode среза; 1.5 МБ payload — 19 мс (было ~1092 мс на 16 КБ).
- [x] Тест производительности через тики таймера:
      `packages/core/tests/sanitize.test.ts::truncating a large payload does not
      starve the event loop (regression: quadratic re-encode)` — interval 5 мс в
      окне 60 мс, поверх синхронного усечения 256 КБ; блокировка съедает тики.
- [x] Утверждение про `jsonb` переформулировано в проверяемое: well-formed UTF-16
      и байтовый бюджет закрыты `::uses a byte budget without splitting Unicode
      code points` (isWellFormed + byteLength ≤ maxBytes+3); живой PostgreSQL в
      наборе ядра не появляется.

**Финальная проверка 2026-08-10:** `bun test sanitize audit-tool-event` — 31 pass;
гайд `docs/guide/observability.md` описывает граничную семантику; пробник
15 ключей вручную подтверждает таблицу редактирования.
