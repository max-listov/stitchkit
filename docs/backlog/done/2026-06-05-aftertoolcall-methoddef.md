---
title: afterToolCall должен получать MethodDef (как afterHandle получает endpoint)
description: ToolCallHooks.afterToolCall отдаёт только toolName — без MethodDef. Консьюмеру для аудита/метрик нужны serviceName/key/method/meta, и чтобы их получить, он вынужден строить toolName→identity карту и РЕПЛИЦИРОВАТЬ внутренний tool-naming (toToolName). HTTP-путь (afterHandle/onError) уже отдаёт endpoint: MethodDef — tool-путь должен быть симметричен.
type: task
status: done
created: 2026-06-05
updated: 2026-06-05
completed: 2026-06-05 03:00
related: docs/decisions/0022-endpoint-identity.md
---

# afterToolCall должен получать MethodDef

## Контекст (от первого консьюмера)

Консьюмер пишет audit-строку на каждую мутацию одинаково для HTTP и tool-surface.
HTTP-хуки отдают `MethodDef` напрямую:

```ts
afterHandle(ctx, result, endpoint)   // endpoint: MethodDef → endpoint.serviceName / .key / .method
onError(ctx, error, endpoint?)       // тоже MethodDef
```

А tool-хук — нет:

```ts
// stitchkit/tools — ToolCallHooks
afterToolCall(toolName, args, result, durationMs, ctx)   // только toolName: string
```

## Проблема

Чтобы получить identity (`serviceName`, `key`, `method`, `meta`) в `afterToolCall`,
консьюмер вынужден:

1. Построить на старте карту `toolName → {serviceName, key, method}` обходом всех
   сервисов.
2. **Реплицировать внутренний нейминг stitchkit**: имя тула = `method.toolName ??
   toToolName(service.name, methodKey)`. `toToolName` — приватная функция ядра
   (`collectTools`, `index-*.js:274`). Консьюмер копирует её алгоритм у себя.

Это хрупко: если ядро поменяет правила нейминга (singularize-исключения, snake-case,
`-`/`/` обработку), карта молча разъедется и **часть tool-call'ов перестанет
попадать в аудит** (у консьюмера это реально случилось с авто-именованными тулами без
явного `toolName` — `create_api_key`/`delete_api_key` не аудировались).

## Что просим

Передавать `MethodDef` (или хотя бы `{ serviceName, key, method, meta, toolName }`)
в `afterToolCall`, как `afterHandle` получает `endpoint`:

```ts
afterToolCall(toolName, args, result, durationMs, ctx, endpoint /* MethodDef */)
```

Ядро уже знает `method` в точке вызова хука (оно резолвит `toolName` из него же),
так что прокинуть `MethodDef` — дёшево. Тогда консьюмер читает identity напрямую,
карта и реплика нейминга исчезают, tool-путь становится симметричен HTTP-пути.

## Acceptance

- [x] `ToolCallHooks.afterToolCall` получает `MethodDef` последним аргументом —
      `execute.ts` (передаётся `method`, который ядро уже держит в скоупе).
- [x] Сигнатура задокументирована рядом с `afterHandle` — `guide/mcp-and-agents.md`
      (секция `lifecycle`/`hooks`, показана симметрия HTTP↔tool).
- [x] `beforeToolCall` — тоже получает `MethodDef`.

## Workaround у консьюмера (до фикса)

the consumer replicates the naming: `method.toolName ?? toToolName(serviceName, key)`
in `buildToolIdentity()` (marked `TODO(stitchkit)`). Removed after the fix.

## Что сделано (2026-06-05)

- [x] **`ToolCallHooks`** (`tools/execute.ts`) — `beforeToolCall` и `afterToolCall`
  получают `endpoint: MethodDef` последним аргументом; `executeToolMethod`
  прокидывает `method` (уже в скоупе). Симметрия с HTTP `afterHandle(ctx, result,
  endpoint)`.
- [x] **Тест** — `tests/execute.test.ts`: хуки получают `MethodDef` с
  `serviceName`/`key`/`method`.
- [x] **Док** — `guide/mcp-and-agents.md` (пример `afterToolCall` читает
  `endpoint.serviceName`/`.key`) + CHANGELOG. Привязка к ADR 0022.
- [x] **Снять у консьюмера:** после релиза консьюмер убирает `buildToolIdentity`-карту
  и реплику `toToolName` → читает identity напрямую.

Ships in the **0.7.0** батч (migration-hardening).
