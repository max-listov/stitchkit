---
title: "staticRoute serves through in-root symlinks"
description: "isWithinDir проверяет только строку пути; staticRoute, в отличие от view_file, не подтверждает realpath — и заодно живёт не в своём модуле."
type: task
status: done
created: 2026-08-10
updated: 2026-08-10
completed: 2026-08-10 12:50 +00:00
---

# staticRoute serves through in-root symlinks

## Зачем

`internal/within-dir.ts:8-15` — чисто лексическая проверка: она сравнивает строки
путей и ничего не знает о файловой системе. `tools/view-file.ts:118-123` это
понимает и перепроверяет через `realpath`. `server/router.ts:310` — нет:

```
staticRoute через симлинк внутри корня -> 200, тело: PRIVATE KEY MATERIAL
percent-encoded ..                     -> 404 (заблокировано корректно)
```

Любой статический корень, куда может попасть симлинк — каталог загрузок, вывод
сборки, каталог, собираемый скриптом, — отдаёт произвольные читаемые файлы.
`security.test.ts:110-141` покрывает только строковые случаи.

Отдельным пунктом того же захода: `staticRoute` (`server/router.ts:293-327`)
вообще живёт не там. Заголовок модуля описывает его как «route matching — contract
route table (build / match / validate) and the raw-route matcher», а внутри — целый
статический файловый сервер: percent-decode, guard обхода, `stat`, `readFile`,
`mimeForPath`, `X-Content-Type-Options: nosniff`. Он единственная причина, по
которой роутер импортирует `node:fs/promises`, `node:path`, `./mime` и
`../internal/within-dir`. Дом для него уже существует — `server/file.ts` с
`serveFile`, `parseByteRange`, `weakETag`.

## Результат

- Статическая раздача не отдаёт файл, чей реальный путь вне объявленного корня.
- Проверка принадлежности каталогу применяется одинаково всеми потребителями.
- Список импортов роутера честно отражает его обязанность.

## План

- [x] Подтверждать `realpath` перед отдачей файла в `staticRoute` — так же, как это
      делает `view-file.ts`.
- [x] Свести обе проверки к одному помощнику, чтобы «лексическая» и «реальная»
      части не расходились у разных вызывающих; в `within-dir.ts` явно указать в
      комментарии, что лексическая проверка сама по себе недостаточна.
- [x] Пройти остальных потребителей `isWithinDir` на тот же вопрос.
- [x] Перенести `staticRoute` из `server/router.ts` в `server/file.ts` вместе с
      относящимися к нему импортами; публичная поверхность не меняется.
- [x] Тесты: симлинк внутри корня, указывающий наружу, — отказ; обычный файл —
      по-прежнему отдаётся; percent-encoded обход — по-прежнему отказ.

## Acceptance

- [x] Симлинк, ведущий за пределы корня, даёт отказ, а не 200.
- [x] `server/router.ts` больше не импортирует `node:fs/promises`.
- [x] Публичные экспорты не изменились (сверка снапшотом поверхности, см.
      `feature-readiness-gate`).
- [x] `bun run verify` зелёный.

## Что сделано

- [x] Реализация: packages/core/src/server/file.ts and packages/core/src/internal/within-dir.ts.
- [x] Регрессия: packages/core/tests/security.test.ts::does not follow an in-root symlink outside the root
- [x] Публичная документация и changelog синхронизированы там, где изменился consumer-facing контракт.
- [x] Итоговый bun run verify подтверждает lint, typecheck, тесты, build, Node smoke и consumer lane.
