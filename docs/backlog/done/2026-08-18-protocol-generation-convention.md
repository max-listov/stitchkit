---
title: "Конвенция поколения протокола в realtime-доке"
description: Рецепт «v: z.literal(N) первым полем» и различение отказа по поколению от битой схемы через уже существующий Zod error в onRejected — доками, без нового механизма.
type: task
status: done
created: 2026-08-18
updated: 2026-08-20
completed: 2026-08-20 13:57 +00:00
---

# Конвенция поколения протокола

## Зачем

Любой распределённый потребитель приходит к полю поколения
(`v: z.literal(1)` первым полем), чтобы чужая запись опознавалась раньше, чем
интерпретировалась. Сегодня отказ по несовпадению поколения и битая схема
выглядят в `onRejected` одинаково, а лечатся по-разному (обнови соседа vs чини
баг).

Решение — **доками, не механизмом**: `RealtimeRejectedEvent.error.cause` уже
несёт исходный Zod error, а какое поле является «поколением» — знает только
приложение; учить фреймворк слову «version» значило бы вшить конвенцию в код.
Фактический path для Stitchkit event tuple — `[0, 'v']`, а не `['v']`: нулевой
segment принадлежит первому Socket.IO argument. Отличить отказ по поколению
можно по первому `invalid_value` issue на этом точном path.

## Результат

- Раздел realtime guide «Protocol generations»: почему literal-поле первым,
  рецепт различения в `onRejected` (по Zod issues в `error.cause`), что делать при
  несовпадении (не чинить схему, а обновлять соседа).
- Явная фиксация границы: механизм различения в core не добавляем, пока минимум
  два потребителя не упрутся в недостаточность рецепта (тогда — отдельная
  задача с их фактами).

## План

- [x] Написать раздел в `docs/guide/realtime.md`: `v: z.literal(N)` первым
      tuple/object field, классификатор поверх `RealtimeRejectedEvent.error`
      и operational response на mismatch.
- [x] Классифицировать только Zod literal issue на точном path `[0, 'v']`; все
      остальные validation failures остаются schema/data defects.
- [x] Проверить тот же recipe runtime-тестом на literal mismatch, malformed
      payload и вложенный одноимённый field.
- [x] Зафиксировать отсутствие нового core API/CHANGELOG entry и регенерировать
      llms через полный build.

## Acceptance

- [x] Сниппет из гайда различает «поколение» и «битая схема» в реальном тесте.
- [x] В доке зафиксировано, почему это конвенция, а не API.
- [x] `bun run verify` зелёный.

## Что сделано

- [x] Docs: `docs/guide/realtime.md` даёт self-contained classifier и честно
      фиксирует tuple prefix `[0, 'v']`, upgrade-peer response и границу
      application convention.
- [x] Core/API: новый mechanism, export или changelog feature намеренно не
      добавлялись; build регенерировал `packages/core/llms*.txt`.
- [x] Регрессия: packages/core/tests/realtime-protocol-generation.test.ts::classifies only the first payload generation literal mismatch
