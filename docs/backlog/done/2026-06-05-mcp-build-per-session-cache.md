---
title: Кэш детерминированной части MCP-build для статичных services (perf)
description: Measure and cache only the deterministic schema-preparation part of MCP server construction for static services while keeping every session, auth context and callback isolated.
type: task
status: done
created: 2026-06-05
updated: 2026-08-07
completed: 2026-08-07 06:47 +00:00
related: docs/backlog/done/2026-05-20-tools-layer-followups.md
---

# Per-session перестройка `McpServer` — кэш для статичных services

> **Target release:** 0.37.0. Profiling is the first implementation step and a
> correctness gate. The prepared surface is also required by the planned
> stateless default and canonical schema-validation profile.

> **Вынесено из** [`tools-layer-followups`](../done/2026-05-20-tools-layer-followups.md)
> (Item 3) при его закрытии. Item 1 и Item 2 того файла закрыты в релизе 0.4.0;
> этот пункт остался единственным живым — отложен на потом, если понадобится.

## Priority: 0.37.0 measured performance work

## Что за гэп

`tools/mcp-handler.ts` в ветке «fresh session» зовёт `buildMcpServer` —
`collectTools` + `mergeSchemas` + probe каждой схемы + `registerTool` — **на
каждую новую MCP-сессию** (`mcp-handler.ts` ~стр. 167 и 240). После перехода на
stateless-by-default этот путь будет выполняться на каждый HTTP-запрос. Для
статичного массива `config.services` результат детерминирован и должен стать
immutable prepared surface, общей для mounting и validation.

## Почему отложено

- Чистый перф, не дефект целостности/безопасности.
- Влияние малое: сессия живёт долго (много вызовов на сессию), не пересоздаётся
  на каждый запрос. Для десятка тулов — доли миллисекунды.
- Чистого фикса «собрать один раз» нет: в модели MCP SDK каждой сессии нужен свой
  `McpServer` + `transport` (инстанс не шарится). Кэшировать можно только дорогую
  детерминированную часть.

## Implementation plan

1. [x] Add a focused benchmark for fresh-session construction with representative
   static service counts and record where time is spent: collection, schema
   flattening/conversion/probing, SDK registration and server construction.
2. [x] Split MCP mounting into a deterministic `prepareMcpSurface` phase and a
   per-server registration phase. Reuse the same prepared descriptors in the
   object-shaped schema validation profile, portable-format validation and
   mounting so compatibility cannot drift.
3. [x] Cache only an immutable prepared descriptor set for a static `services`
   array. The handler closure is the cache/invalidation boundary: constructing a
   handler captures `services`, `extend`, flattening, schema validation and
   logger together, so there is no partial global key to drift.
4. [x] Always create a fresh `McpServer`, tool runner and callbacks per session.
   Never cache auth/context, lifecycle closures, hooks, native registrations,
   resources, transports or mutable request state.
5. [x] Keep auth-dependent `services(auth)` on the uncached path. Pin with a test
   where two identities receive different tool sets and contexts.
6. [x] Add parity tests proving cached and uncached builds advertise identical
   schemas and produce identical validation, lifecycle, hook and result
   behaviour. Record before/after benchmark numbers in the task result.
7. [x] Document the optimization in the 0.37.0 changelog. No public API change is
   expected; write an ADR only if preparation becomes a new public abstraction.

## Dependencies

- [`MCP schema validation profile`](./2026-08-07-mcp-schema-validation-profile.md)
  defines every policy input included in preparation.
- [`Portable JSON Schema formats`](./2026-08-07-portable-json-schema-formats.md)
  runs over the prepared schemas.
- [`Stateless MCP default`](./2026-08-07-stateless-mcp-default.md) consumes the
  immutable surface while keeping fresh request state.

## Acceptance

- [x] A benchmark demonstrates the cost and the improvement for static services
- [x] Schema collection/conversion/probing runs once for a stable static configuration
- [x] Stateless requests reuse prepared descriptors without sharing request state
- [x] Every MCP session still owns a fresh server, runner, identity and request state
- [x] Auth-dependent service factories are never shared across identities
- [x] Cached and uncached paths are behaviourally and schema-equivalent
- [x] Cache invalidation covers all descriptor-shaping inputs through handler lifetime
- [x] No global mutable session cache, timer or consumer-visible configuration is introduced

## Что сделано

- [x] **Preparation:** `packages/core/src/tools/mcp.ts` separates immutable
  `prepareMcpSurface` from per-server `mountPreparedMcp` and
  `buildMcpServerFromPrepared`.
- [x] **Handler cache:** `packages/core/src/tools/mcp-handler.ts` prepares a
  static services array once inside the handler closure; `services(auth)` stays
  on the per-identity path.
- [x] **Isolation:** every build still creates a new SDK server, tool runner,
  context, native registration and resource registration. No auth, lifecycle
  closure, hook, transport or request state enters the prepared surface.
- [x] **Parity tests:** `packages/core/tests/mcp-preparation-cache.test.ts`
  verifies frozen descriptors, identical advertised schemas/results,
  lifecycle/hooks parity, fresh server/context per request and identity-specific
  preparation.
- [x] **Benchmark:** `packages/core/scripts/benchmark-mcp-preparation.ts` compares
  the static prepared path with the same handler forced through the uncached
  factory path. For 30 stateless initialize requests: 12 tools measured
  **43.50 → 15.90 ms (2.7×)**; 159 tools measured
  **354.97 → 13.16 ms (27.0×)** on ML-DEV.
- [x] **Docs:** `docs/guide/mcp-and-agents.md` and `CHANGELOG.md` explain the
  handler-lifetime cache and its isolation boundary.
- [x] **Verification:** focused tests, lint, typecheck, build, public declaration
  guard and packed minimal/full consumer lanes passed.

## Ссылки

- Код: `packages/core/src/tools/mcp-handler.ts`, `tools/mcp.ts` (`buildMcpServer`,
  `collectTools`, `mergeSchemas`).
- Исходный набор follow-up'ов: `docs/backlog/done/2026-05-20-tools-layer-followups.md`.
