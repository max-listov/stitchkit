---
title: "Лёгкий экспорт implementRemote без MCP SDK"
description: Запрос потребителя: implementRemote живёт только в stitchkit/tools, который статически тянет @modelcontextprotocol/server и ai в CLI-бандл — нужен entrypoint/структура без этих peer-зависимостей.
type: task
status: inbox
created: 2026-08-18
---

# implementRemote без MCP SDK в бандле

## Зачем

`implementRemote` нужен CLI-потребителю, но экспортируется только из
`stitchkit/tools`, статически тянущего `@modelcontextprotocol/server` и `ai`
в бандл. Проверить фактическую статичность (в socket-слое peers лениво —
возможно, tools просто не следует тому же паттерну) и либо перевести tools на
lazy-import, либо дать лёгкий entrypoint.

## Результат

- CLI-бандл потребителя с implementRemote не содержит MCP SDK/ai;
  проработка и реализация по конвейеру после команды.
