---
title: "Decide a bounded policy for createCache"
description: "createCache использует тот же каркас, что createRateLimiter, но не ограничивает число записей и не объясняет почему."
type: task
status: done
created: 2026-08-10
updated: 2026-08-10
completed: 2026-08-10 12:50 +00:00
---

# Decide a bounded policy for createCache

## Зачем

`packages/core/src/server/cache.ts` построен на том же `createSweptMap`, что и
`createRateLimiter`. Ограничитель частоты ограничивает число записей и объясняет
это в коде; кеш — нет, и молчит о причине.

Это задача-развилка, а не дефект: у серверного кеша ключи задаёт приложение, и
разумная политика зависит от того, чем он считается по замыслу — вспомогательной
памятью с потолком или хранилищем, чей размер осознанно отдан приложению. Пока
решение не записано, отсутствие потолка неотличимо от недосмотра, а значит будет
«починено» кем-нибудь наугад.

## Результат

- Решение принято и записано в коде рядом с реализацией: либо потолок с политикой
  вытеснения, либо явное объяснение, почему размер принадлежит приложению.
- Разница с `createRateLimiter` перестаёт выглядеть недосмотром.

## План

- [x] Определить, кто владеет размером кеша: фреймворк или приложение.
- [x] Если фреймворк — потолок и вытеснение по образцу `createRateLimiter`, плюс
      тест на удержание.
- [x] Если приложение — конфигурируемый предел с безопасным значением по
      умолчанию и комментарий с обоснованием.

## Что сделано

- [x] Реализация: packages/core/src/server/cache.ts.
- [x] Регрессия: packages/core/tests/cache-rate-limit.test.ts::evicts the oldest entry when maxEntries is reached; packages/core/tests/cache-rate-limit.test.ts::rejects invalid capacity and TTL values
- [x] Публичная документация и changelog синхронизированы там, где изменился consumer-facing контракт.
- [x] Итоговый bun run verify подтверждает lint, typecheck, тесты, build, Node smoke и consumer lane.
