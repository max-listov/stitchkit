---
title: "Async operation: wait теряет per-capability scope и суффикс identity"
description: defineAsyncOperation строит wait в обход capability-identity, из-за чего документированный scopes.wait не применяется, а audit-action не отличается от базовой операции.
type: task
status: done
created: 2026-08-20
updated: 2026-08-20
completed: 2026-08-20 15:17 +00:00
related: docs/backlog/done/2026-08-20-async-operation-protocol.md
---

# Wait capability: scope override и identity

## Зачем

В `packages/core/src/tools/async-operation.ts` каждая capability получает
identity через локальный хелпер `identity(capability, method)`, который
применяет `config.scopes?.[capability] ?? config.identity.scope` и суффикс
`action.capability`. **`wait` — единственное исключение**: он собирается как
`defineWaitTool({ ...common('wait'), identity: config.identity, ... })`, то есть
получает базовую identity напрямую.

Два следствия:

1. **Авторизационное.** `scopes` объявлен как
   `Partial<Record<AsyncOperationCapability, string>>` и включает `'wait'`, но
   значение никогда не доезжает. `identity.scope` превращается в
   `OperationIdentity.scope` (`tools/runtime-tool.ts:277`), а именно им
   охраняются tool-вызовы (`tools/execute.ts:110` — «tools are scope-guarded
   exactly as HTTP routes are»). Потребитель, написавший
   `scopes: { wait: 'admin' }`, получает wait под базовым scope — **шире, чем
   он объявил**, молча.
2. **Наблюдаемость.** Audit/observability видит action `export` вместо
   `export.wait`, тогда как соседние capability дают `export.status`,
   `export.cancel`. Это единственное нарушение конвенции стабильной
   `(service, action)` identity (ADR 0022) в наборе.

Per-capability `scopes` не покрыт ни одним тестом — поэтому дефект и прожил до
валидации.

## Результат

- `wait` получает identity по тому же правилу, что и остальные capability:
  scope-override применяется, action — `${identity.action}.wait`.
- Поведение остальных capability не меняется.
- Тест закрывает весь `scopes`-map, а не только wait: каждая настроенная
  capability экспонирует именно свой scope.

## План

- [x] Передать в `defineWaitTool` identity, построенную тем же
      `identity('wait', 'GET')`; убедиться, что `defineWaitTool`/
      `managedNativeIdentity` не переопределяют scope.
- [x] Проверить, не опирается ли что-то (presenters, mount, snapshot-фикстуры)
      на текущий action без суффикса; при необходимости обновить фикстуры.
- [x] Тест: descriptor со `scopes: { status, wait, cancel, result, artifacts }`
      — у каждого runtime-tool в `runtimeTools` ровно свой scope и action с
      суффиксом capability.
- [x] Тест: без `scopes` все capability наследуют `identity.scope`.
- [x] Строка `Fixed` в `CHANGELOG.md` — изменение поведения identity/scope для
      уже собранных descriptor'ов описать явно.

## Acceptance

- [x] `scopes.wait` наблюдаемо применяется; без фикса тест красный.
- [x] Action каждой capability — `${identity.action}.${capability}`.
- [x] `bun run verify` зелёный.

## Что сделано

- [x] Core: `packages/core/src/tools/async-operation.ts` передаёт wait через
      единый capability identity builder, включая method, suffixed action,
      per-capability scope и meta.
- [x] Docs: behavior отражён в `CHANGELOG.md` и
      `docs/decisions/0089-async-operations-describe-transport-not-jobs.md`.
- [x] Регрессия: packages/core/tests/async-operation.test.ts::every capability uses its suffixed action and configured scope override; packages/core/tests/async-operation.test.ts::every capability inherits the base scope when no override is configured
