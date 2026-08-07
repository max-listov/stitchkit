---
title: Framework-owned native Agent tools
description: Дать AI SDK native tools тот же identity, lifecycle, validation, hooks и multimodal runner, что contract и native MCP operations
type: task
status: done
created: 2026-08-07
updated: 2026-08-07
completed: 2026-08-07 14:20 +00:00
---

# Framework-owned native Agent tools

## Источник

Кросс-аудит двух реальных consuming applications на Stitchkit 0.38.0. Оба
consumer-а используют `mountAgent` для contract tools, но добавляют native AI SDK
tools напрямую. Один и тот же multimodal file operation приходится отдельно
описывать для protected native MCP и raw Agent tool.

Названия и доменная логика consumers намеренно не фиксируются в публичном репо.

## Проблема

`registerTool` выровнял native MCP operations с contract runner, но Agent surface
остаётся асимметричной. Raw AI SDK `tool()` не получает framework guarantees:

- `OperationIdentity` и единый `RequestEvent`;
- fresh `inToolCallContext` на каждый параллельный call;
- lifecycle/RBAC;
- input/output validation одним runner;
- `ToolCallHooks`, audit и error normalization;
- единое определение multimodal operation для MCP и Agent.

## Инварианты

- Один executable Zod parser остаётся source of truth.
- Native operation не становится fake contract и не получает HTTP path.
- Framework владеет runner-ом, consumer — identity, schemas и handler-ом.
- Параллельные calls не разделяют mutable request context.
- MCP и Agent adapters не должны заставлять handler импортировать типы обоих SDK.
- Raw SDK escape hatch может существовать только как явно названный low-level
  boundary и не обещает lifecycle/hooks.

## Уточнённая модель после сверки SDK

- `defineRuntimeTool` создаёт один neutral definition: identity, input/output
  schemas, handler и `transports: ['MCP', 'AGENT']` (default — оба).
- Handler возвращает neutral validated output, а не SDK envelope.
- `present.mcp` возвращает MCP content/metadata без `structuredContent`;
  framework добавляет validated output как structured content.
- `present.agent` использует официальный AI SDK `toModelOutput`, поэтому rich
  media попадает в model result, а execute/UI получает neutral output.
- `nativeTools({ registerTool })` принимает runtime definition; `rawServer`
  остаётся единственным явно unprotected MCP escape hatch.
- `mountAgent(..., { runtimeTools })` добавляет те же definitions в AI SDK
  `ToolSet`; прямой consumer `tool()` остаётся raw boundary вне гарантий Stitchkit.
- Старые `NativeMcp*` types удаляются без aliases: один public definition, один runner.

## План

### 1. Neutral definition

- [x] Спроектировать transport-neutral native operation definition поверх
      существующих `ToolOperation`, `OperationIdentity` и `executeToolMethod`.
- [x] Определить public API (`defineRuntimeTool` / registrar / mount API) после
      проверки текущих MCP и Agent call graphs; не создавать второй runner.
- [x] Типизировать name, description, identity, input, optional output,
      annotations и handler context без assertions в consumer callsite.

### 2. Result model

- [x] Отделить neutral handler result от MCP/AI SDK wire result.
- [x] Поддержать JSON и multimodal text/image/audio/file parts с явными adapters.
- [x] Не терять SDK-specific metadata: либо типизированные per-transport
      presentation callbacks, либо доказанная общая модель с lossless mapping.
- [x] Fail-first отклонять result, который выбранный transport не умеет выразить.

### 3. Agent mount

- [x] Добавить framework-owned registration/mount для native Agent tools.
- [x] Каждый execute прогонять через input parse, fresh context, lifecycle,
      handler, output validation, hooks и error normalization.
- [x] Сохранить AI SDK ToolSet types и compatibility с `activeTools` /
      prepare-step orchestration без Stitchkit-owned agent policy.

### 4. Cross-transport reuse

- [x] Позволить одному definition явно публиковаться в MCP, Agent либо обоих.
- [x] MCP registration продолжает использовать protected registrar и не
      регрессирует schema profile / SDK rejection observability.
- [x] Исключить duplicate names между contract/native surfaces тем же ratchet,
      которым пользуется `collectTools`.

### 5. Public surface и docs

- [x] Экспортировать public types только из `stitchkit/tools`.
- [x] Обновить MCP/Agent guide, API reference, generated llms surface и upgrade guide.
- [x] Добавить changelog entry; если существующая сигнатура меняется — оформить
      breaking migration без aliases или deprecated wrappers.

### 6. Tests

- [x] Agent JSON success, validation failure, handler error и output strip.
- [x] Parallel calls получают разные contexts и корректные trace/audit events.
- [x] Одинаковая identity проходит MCP и Agent adapters.
- [x] Multimodal file result проверен реальным MCP SDK и AI SDK execution path.
- [x] Lifecycle deny не вызывает handler, hook terminal event остаётся ровно один.
- [x] Node declaration smoke не содержит Bun-only types.
- [x] Полный `bun run verify` зелёный: 885 tests, build, Node smoke и consumer lane.

## Acceptance

- [x] Consumer не вызывает raw AI SDK `tool()` ради framework-managed operation.
- [x] Один native definition может безопасно работать в MCP и Agent.
- [x] Contract и native Agent calls имеют одинаковые lifecycle/audit guarantees.
- [x] Multimodal content не сводится к JSON-заглушке.
- [x] Нет второго execution engine и compatibility shims.

## Что сделано

- [x] **Core:** добавлен neutral `defineRuntimeTool` и единый type family в
      `packages/core/src/tools/runtime-tool.ts`; execution делегирован существующему runner.
- [x] **MCP:** protected registrar в `packages/core/src/tools/native-mcp.ts`
      принимает runtime definition, сохраняет rich content и владеет
      `structuredContent`/`isError`.
- [x] **Agent:** `packages/core/src/tools/agent.ts` монтирует `runtimeTools` и
      использует AI SDK `toModelOutput` для multimodal model result.
- [x] **Public API:** экспорты обновлены в `packages/core/src/tools.ts`, packed
      consumer проверяет один definition на обеих поверхностях.
- [x] **Tests:** `packages/core/tests/runtime-tools.test.ts` покрывает success,
      failures, lifecycle, audit isolation, duplicate names и multimodal parity;
      native MCP tests мигрированы на neutral result.
- [x] **Docs:** обновлены guide, API reference, upgrade migration, changelog,
      generated llms и ADR 0055.
- [x] **Не делалось:** raw `McpServer.registerTool` и AI SDK `tool()` не оборачиваются;
      они остаются явно low-level boundaries без framework guarantees.
