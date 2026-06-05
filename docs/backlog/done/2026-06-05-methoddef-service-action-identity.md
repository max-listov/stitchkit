---
title: MethodDef / audit — first-class (service, action) identity
description: Хуки и audit не могут получить пару (service=prefix контракта, action=ключ эндпоинта). MethodDef её не несёт; createAuditHook вообще не получает MethodDef (читает ALS-контекст). Реальный DX-гэп — всплыл при миграции консьюмера (per-endpoint audit). DO + ADR. Не сейчас — после миграции.
type: task
status: done
created: 2026-06-05
updated: 2026-06-05
completed: 2026-06-05 01:00
related: docs/decisions/0021-endpoint-meta-passthrough.md, docs/backlog/inbox/2026-06-05-stitchkit-post-migration-batch.md
---

# MethodDef / audit — first-class (service, action) identity

**Тип работы: DO (код + ADR).** Найдено при миграции консьюмера (per-endpoint
audit-лог `logMutation` с колонками `service` + `action`). Не блокер — у консьюмера
есть обход (стемп в `meta`, читать в `afterHandle`). Делаем после миграции, в
батче 0.6.0, когда форма фикса подтвердится реальным консьюмером.

## Проблема

Аудит/обсервабилити, ключёванные по **(service, action)** = (префикс контракта,
ключ эндпоинта), не могут получить эту пару из stitchkit:

- **`MethodDef` не несёт identity.** В нём есть `method`/`path`/`toolName`, но нет
  ни имени сервиса (`contract.meta.prefix`), ни ключа эндпоинта (напр.
  `updatePartial`). `implement()` оба значения знает (`contract.meta.prefix` +
  ключ цикла), но дропает.
- **`createAuditHook` вообще НЕ получает `MethodDef`** (проверено,
  `observability/audit.ts`):
  - HTTP-ветка строит `RequestEvent` из `getRequestContext()` (ALS) — там нет ни
    MethodDef, ни meta;
  - tool-ветка = `afterToolCall(toolName, args, result, ctx)` — тоже без MethodDef.
- **`RequestEvent`** несёт `path` и `toolName`, но **не** `(service, action)`:
  из `path` (`/api/bots/:botId/broadcasts/...`) можно вытащить service, но НЕ
  action (ключ метода в путь не попадает); `toolName` есть не у всех (HTTP-only
  эндпоинты без toolName). И для HTTP `RequestEvent` не несёт output-тело.

→ Любой консьюмер с per-endpoint аудитом упрётся (как раньше с `meta`).

## Важное разграничение — это ДВА слоя

- **C1 — identity на `MethodDef`.** `MethodDef.serviceName` (= prefix контракта)
  + `MethodDef.key` (= ключ эндпоинта), заполняются в `implement()`. Помогает
  lifecycle-хукам, которые ПОЛУЧАЮТ MethodDef: `beforeHandle(ctx, _, endpoint)` /
  `afterHandle(ctx, result, endpoint)`. Хук читает `endpoint.serviceName`/`.key`
  нативно, без `meta`-хака.
- **C2 — service/action в audit-пути.** `createAuditHook` не видит MethodDef →
  чтобы пара попала в audit-row через него, нужно стемпить (service, action) в
  ALS request-context на dispatch и вынести в `RequestEvent`. Отдельный, больший
  фикс — нужен ТОЛЬКО если консьюмер остаётся на `createAuditHook`.

Это РАЗНЫЕ фиксы. Какой именно нужен — покажет миграция (консьюмер, вероятно, уйдёт
на аудит через `afterHandle`, т.к. `createAuditHook` всё равно не даёт output для
HTTP → тогда хватает **C1**).

## Рекомендация

- **C1 как основной** — чисто, generic, для всех консьюмеров, тот же паттерн, что
  с `meta`-passthrough (ADR 0021). `implement()` уже знает prefix + key.
- **C2 — только если** подтвердится спрос на service/action именно в
  `createAuditHook`-пути (не через afterHandle).
- Новый **ADR 0022** (extends ADR 0002/0021): generic-ядро не моделирует домен, но
  отдаёт стабильную (service, action) identity на MethodDef для хуков/аудита;
  альтернативы (стемп в meta — side-channel; дерайв из path/toolName — теряет
  action на HTTP-only) отвергнуты.

## Acceptance

- [x] `MethodDef.serviceName` + `MethodDef.key` (**required**, не опц.) + заполнение
      в `implement()` и `implementRemote`.
- [x] Тест: `service.methods[k]` несёт `serviceName == prefix` и `key == k`.
- [x] Тест: `afterHandle(ctx, result, endpoint)` видит `endpoint.serviceName`/`.key`.
- [x] C2 (RequestEvent несёт `service`/`action`) — **отклонён** (3 агента:
      `createAuditHook` не несёт output, аудит через `afterHandle`). НЕ делаем.
- [x] ADR 0022 + строка в `docs/decisions/README.md`.
- [x] `docs/guide/observability.md` — как ключевать audit по (service, action).
- [x] `bun run verify` зелёный (360 tests).

## Почему не сейчас

Миграция = валидационный проход: она подтвердит, нужен ли C1, C2 или оба, и
точную форму. Релизить до этого = риск re-fix. Плюс прямое указание: коммиты в
стич не делаем до конца миграции. Обход на стороне консьюмера (стемп в meta, читать в
afterHandle) разблокирует прямо сейчас.

## Что сделано (2026-06-05)

Решение: **C1 only** (3 Opus-агента единогласно; C2 отклонён — `createAuditHook`
не несёт output для HTTP, аудит идёт через `afterHandle`, туда C1 и доезжает).

- [x] `MethodDef.serviceName` + `key` (**required**) — `server/types.ts`.
- [x] Заполнение в `implement` (`server/implement.ts`) и `implementRemote`
  (`tools/remote.ts`).
- [x] Починены 2 тест-литерала `MethodDef` (`auth-hook.test.ts`, `execute.test.ts`).
- [x] **ADR 0022** + строка в `docs/decisions/README.md`.
- [x] Тест `tests/methoddef-identity.test.ts` (3): implement identity, `afterHandle`
  читает, `implementRemote` identity+meta.
- [x] `docs/guide/observability.md` — секция «key audit by (service, action)».
- [x] CHANGELOG `[Unreleased]`. `bun run verify` зелёный (360 tests).

Реализовано в рабочем дереве; коммитится с релизом 0.6.0.
