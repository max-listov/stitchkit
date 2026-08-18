---
title: "Unix: подсказка следующего шага в ошибке «exists and is not a socket»"
description: Ошибка отказа от не-сокета по пути unix-листенера не подсказывает действие — добавить «remove it manually if it is debris», как в соседней ветке про compiled executable.
type: task
status: inbox
created: 2026-08-18
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
