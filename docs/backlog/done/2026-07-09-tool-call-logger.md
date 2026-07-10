---
title: createToolLogger() — готовый пресет для hooks.afterToolCall
description: Наблюдаемость MCP/AGENT-туллов — универсальный паттерн, но пишется руками в каждом проекте. Пресет для afterToolCall с форматированным логом (ok/warn + durationMs + endpoint.serviceName/.key). Опционально — метрика-хук.
type: task
status: done
created: 2026-07-09
updated: 2026-07-10
completed: 2026-07-10 04:35 +08:00
---

# `createToolLogger()` — пресет логирования tool-call

## Зачем

Наблюдаемость тулов (MCP/AGENT) — универсальный паттерн, который каждый проект
пишет заново. У потребителя, мигрировавшего на 0.18 (`mcp/server.ts`), свой
`hooks.afterToolCall`: форматирует `ok/warn + durationMs + endpoint.serviceName/.key`.
Тот же код будет в каждом проекте флота.

## Идея

Штатный пресет поверх уже существующего `hooks.afterToolCall` (`ToolCallHooks`):

```ts
mountMcp(server, services, {
  hooks: createToolLogger({ log: console.info }),   // ok/warn + durationMs + serviceName.key
});
```

- Тонкая обёртка над существующим хуком — generic-принцип не нарушает (ADR 0008,
  тот же класс, что `createCursorQuery`).
- Идентификация эндпоинта из `endpoint.serviceName` / `.key` — стабильная
  identity (ADR 0022), уже в `MethodDef`.
- Опционально — метрика-хук (counter/histogram по `(serviceName, key, ok)`),
  но без встроенного бэкенда метрик: приложение отдаёт sink.

## Приоритет

DX, не блокер. Из пачки «дубли по флоту» (2026-07-09), источник — агент на живой
миграции. Дёшево; можно делать вместе с `createContractFactory` / error-каркасом.


## Реализовано (0.19.0)

Вышло в релизе 0.19.0. Код + тесты + доки + reference. Файл перенесён в done/.
