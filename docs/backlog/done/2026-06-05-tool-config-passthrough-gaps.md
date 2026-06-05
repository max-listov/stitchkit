---
title: Tool-config passthrough gaps — extend в createMcpHandler, meta в implementRemote
description: Два мелких passthrough-пробела во время реальной multi-tenant миграции консьюмера. Фичи есть в нижнем слое, но не доезжают через верхний config. Каждый — 1-2 строки.
type: task
status: done
created: 2026-06-05
updated: 2026-06-05
completed: 2026-06-05 02:07
related: docs/decisions/0007-mcp-agent-tools.md
---

# Tool-config passthrough gaps

Вылезли при миграции первого внешнего multi-tenant консьюмера. Оба — фича уже
есть в нижнем слое, но не пробрасывается через верхний config. Каждый закрывается
1-2 строками; пока обойдены на стороне консьюмера.

## Gap 1 — `extend` не доезжает до `createMcpHandler` / `buildMcpServer`

`ToolExtend` (`{ schema, resolve, filter }`) принимает только `mountMcp` /
`mountAgent` (`McpMountConfig.extend`, `AgentMountConfig.extend`). Но
`McpServerBuildConfig` его **не содержит**, и `buildMcpServer` зовёт
`mountMcp(server, services, {...})` **без** `extend`. Значит через
`createMcpHandler` (batteries-path) добавить tool-arg (напр. `tenantId`/`botId`
для «один api-ключ → много тенантов») нельзя — только через ручной `mountMcp`,
что лишает консьюмера готового HTTP/SSE-lifecycle.

**Симптом у консьюмера:** `error TS2353: 'extend' does not exist in type
'McpHandlerConfig'`. Обход — руками оборачивать ServiceDef (добавлять tenant-arg
в `paramsSchema` + резолвить в хендлере), т.е. дублировать логику `extend`.

**Фикс:** добавить `extend?: ToolExtend` в `McpServerBuildConfig` и пробросить в
`mountMcp` внутри `buildMcpServer` (≈2 строки) — симметрично `context`/`hooks`/
`lifecycle`, которые уже проброшены. (Опционально и в stdio-config.)

## Gap 2 — `implementRemote` не пробрасывает `meta`

`implementRemote(contract, http)` строит `ServiceDef` из контракта, но (как было с
`implement` до 0.5.0) не копирует `endpoint.meta` в `MethodDef.meta`. Консьюмер с
per-endpoint метадатой (`requiredFeature` и т.п.) теряет её на remote-проксировании.

**Фикс:** скопировать `meta: endpoint.meta` в `implementRemote` (1 строка), как в
`implement`.

## Контекст (необязательно к фиксу)

Связанный наблюдаемый пробел — у `MethodDef` нет `serviceName` + endpoint-`key`,
поэтому lifecycle-хуки (`beforeHandle`/`afterHandle`) не знают, какой сервис/метод
вызван (нужно для per-endpoint аудита). Консьюмер обошёл через стемпинг в `meta`.
Кандидат на отдельное решение (добавить identity в `MethodDef`) — но это уже не
«passthrough», вынесено сюда лишь как заметка.

## Acceptance
- [x] `McpServerBuildConfig.extend` + проброс в `buildMcpServer` → `mountMcp`
      (`tools/mcp.ts`). `McpHandlerConfig extends McpServerBuildConfig` → доезжает и
      до batteries-path (`createMcpHandler`), снимая `TS2353` у консьюмера.
- [x] `implementRemote` копирует `meta` — `tools/remote.ts` (`meta: endpoint.meta`).
- [x] Тесты — `tests/tools.test.ts` (`buildMcpServer` форвардит `extend` через
      extend-conflict) + CHANGELOG.
- [x] `bun run verify` зелёный — 414 tests.

## Что сделано (2026-06-05)

- [x] **Gap 1 — `extend` в MCP build** — `McpServerBuildConfig.extend?: ToolExtend`
  + проброс в `mountMcp` внутри `buildMcpServer` (`packages/core/src/tools/mcp.ts`).
  `McpHandlerConfig` наследует → batteries-path покрыт.
- [x] **Gap 2 — `implementRemote` meta** — уже в дереве (`tools/remote.ts`,
  `meta: endpoint.meta`; закрыто в рамках batch #2).
- [x] **Identity-нота** (`MethodDef` serviceName/key) — закрыта отдельно в **ADR 0022**
  (batch #3); здесь была только заметкой.
- [x] **Тест** — `tests/tools.test.ts` `describe('buildMcpServer')`.

Ships in the **0.6.0** batch. (ADR 0007 upheld — passthrough, без нового ADR.)
