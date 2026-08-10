---
title: "A global sensitiveKeys regex leaks every other secret"
description: "sensitive.test(key) сохраняет lastIndex между вызовами, поэтому RegExp с флагом g редактирует через один."
type: task
status: done
created: 2026-08-10
updated: 2026-08-10
completed: 2026-08-10 12:50 +00:00
related:
  - docs/backlog/inbox/2026-08-10-audit-payload-serialisation-semantics.md
---

# A global sensitiveKeys regex leaks every other secret

## Зачем

`packages/core/src/observability/sanitize.ts:89` вызывает `sensitive.test(key)` на
переданном пользователем `RegExp`. У регулярки с флагом `g` (и `y`) `test`
продвигает `lastIndex` и со следующего вызова продолжает с того же места:

```
redact({token:'A',secret:'B',token2:'C',secret2:'D',tokenX:'E'}, {sensitiveKeys:/token|secret/gi})
-> {"token":"[redacted]","secret":"B","token2":"[redacted]","secret2":"D","tokenX":"[redacted]"}
```

`sensitiveKeys` — публичная опция, принимающая любой `RegExp`; в документации
примеры с `/i`, поэтому ничто не сигналит о проблеме. Секреты в открытом виде
уезжают в хранилище аудита, причём **недетерминированно относительно порядка
ключей**: воспроизводится не всегда и на ревью выглядит случайностью.

## Результат

- Флаг у пользовательской регулярки не влияет на результат редактирования.
- Поведение детерминировано относительно порядка ключей.

## План

- [x] Не звать `test` на пользовательской регулярке напрямую: нормализовать её
      (снять `g`/`y` через `new RegExp(source, flags)`) либо сбрасывать
      `lastIndex` перед каждой проверкой. Первое предпочтительнее — оно чинит
      причину, а не симптом.
- [x] Тест: одна и та же регулярка с `g` и без даёт одинаковый результат на
      объекте с пятью чувствительными ключами.
- [x] Тест: результат не зависит от порядка ключей.

## Acceptance

- [x] Ни один флаг регулярки не меняет исход редактирования.
- [x] `bun run verify` зелёный.

## Не входит

- Пересмотр дефолтного набора ключей, поддержка `Map`/`Set`/`Error` и
  байт-безопасная обрезка — отдельная задача про семантику сериализации.

## Что сделано

- [x] Реализация: packages/core/src/observability/sanitize.ts.
- [x] Регрессия: packages/core/tests/sanitize.test.ts::masks the default sensitive key names; packages/core/tests/sanitize.test.ts::masks compound key names carrying a secret word (regression: anchored matching)
- [x] Публичная документация и changelog синхронизированы там, где изменился consumer-facing контракт.
- [x] Итоговый bun run verify подтверждает lint, typecheck, тесты, build, Node smoke и consumer lane.
