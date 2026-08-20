---
title: "Unix: подсказка следующего шага в ошибке «exists and is not a socket»"
description: Ошибка отказа от не-сокета по пути unix-листенера не подсказывает действие — добавить «remove it manually if it is debris», как в соседней ветке про compiled executable.
type: task
status: done
created: 2026-08-18
updated: 2026-08-20
completed: 2026-08-20 13:57 +00:00
related: 2026-08-18-unix-socket-transport.md
---

# Unix: actionable-текст ошибки «not a socket»

## Зачем

Обратная связь живого потребителя после интеграции 0.53.0: guard
`reclaimStaleUnixSocket` при обычном файле по пути сокета честно отказывается
(«exists and is not a socket — refusing to remove it»), но не говорит, что
делать дальше. Соседние ветки (compiled executable, timeout пробы) уже
подсказывают «remove the file manually if …».

## Результат

- Текст ошибки в `packages/core/src/server/bun.ts` дополнен подсказкой вида
  «remove it manually if it is debris»; тест, пиняющий сообщение, обновлён.
- Non-blocking мелочь — едет со следующим минором/патчем, отдельный релиз не
  нужен.

## План

- [x] Дополнить только regular-file guard actionable manual-removal hint,
      сохранив отказ от автоматического unlink.
- [x] Ужесточить exact regression: сообщение содержит следующий шаг, файл после
      ошибки физически остаётся на месте.
- [x] Обновить Unreleased changelog одной fixed-note; отдельный ADR/API change
      не нужен.
- [x] Прогнать полный `bun run verify`; релиз не входит.

## Acceptance

- [x] Ошибка явно предлагает удалить path вручную, только если это debris.
- [x] Framework по-прежнему никогда не удаляет regular file автоматически.
- [x] `bun run verify` зелёный.

## Что сделано

- [x] Runtime: `packages/core/src/server/bun.ts` дополняет только regular-file
      refusal actionable hint; unlink behavior не менялся.
- [x] Docs: `CHANGELOG.md` фиксирует safe next step без отдельного API/ADR.
- [x] Регрессия: packages/core/tests/unix-transport.test.ts::refuses a regular file at the socket path and does not unlink it
