---
title: Типизированный контекст для tool-пути (createToolkit)
description: Типобезопасная проводка context на MCP/agent/CLI-транспортах — фабрика createToolkit, зеркало createImplement
type: task
status: done
created: 2026-05-29
updated: 2026-05-29
completed: 2026-05-29 15:22
related: docs/backlog/inbox/2026-05-20-tools-layer-followups.md
---

# Типизированный контекст для tool-пути

Извлечён из **Item 1** [tools-слой follow-up'ов](../inbox/2026-05-20-tools-layer-followups.md)
(items 2 и 3 остаются в inbox). Сделан вместе с CLI-транспортом, чтобы CLU
родился типизированным, а не добавил четвёртый untyped wiring-сайт.

## Гэп

Хендлер типизирован (`createImplement<AppContext>()` даёт `ctx.user` на всех
поверхностях). Проводка — нет: `context` транспорта и `ToolExtend.resolve`
возвращали `Record<string, unknown>`, TS не ловил забытый/не того типа `user`.
Рантайм-дыры нет — чистый DX-гэп, протекающий питч про fullstack type safety на
tool-стороне.

## Решение (подход 2 — фабрика)

`createToolkit<AppContext>()` фиксирует тип контекста один раз и возвращает
context-pinned `mountMcp` / `mountAgent` / `buildMcpServer` / `createMcpHandler`
/ `createStdioMcpServer` / `createCli` — каждый проверяет `context` (и
`ToolExtend.resolve`) против `AppContext`. Чистый typing-sugar: каждый метод
форвардит в нижележащую функцию verbatim; loose-путь сохранён (ADR 0003).
Единственное структурное изменение — `ToolExtend` стал generic
(`ToolExtend<TContext>`, default `Record<string, unknown>`).

Выбран подход 2 (фабрика), а не подход 1 (generic по всем конфигам): та же
безопасность на границе, где приложение и так объявляет контекст, без
инвазивного протаскивания generic через весь mount-стек. Решение записано в
**[ADR 0017](../../decisions/0017-typed-tool-context.md)**.

## Что сделано

- **Shared:** `ToolExtend<TContext>` → generic, `resolve` возвращает
  `Partial<TContext>` (`packages/core/src/tools/mount.ts`).
- **Core:** `createToolkit<TContext>()` + `Toolkit<TContext>`
  (`packages/core/src/tools/toolkit.ts`), экспорт из `stitchkit/tools`
  (`packages/core/src/tools.ts`).
- **CLI:** `CliConfig<TAuth, TContext>` / `createCli` generic «из коробки»
  (`packages/core/src/tools/cli.ts`).
- **Тест:** typed-context-путь через `toolkit.createCli`
  (`packages/core/tests/cli.test.ts`).
- **Реальный потребитель:** приложение перевело свой MCP-handler на
  `createToolkit<AppContext>().createMcpHandler` — инжект `context`
  (`{userId,isAdmin,…}`) стал типобезопасен против контекста хендлера.
  Фабрика — НЕ мёртвый код (есть реальный consumer).
- **Что НЕ делалось:** подход 1 (generic-конфиги) — отвергнут; items 2/3
  follow-up'ов (implementRemote-проверка, per-session кэш MCP) остались в inbox.
