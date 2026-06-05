---
title: implementRemote — пробросить EndpointDef.meta в MethodDef
description: implementRemote (tools/remote.ts) строит MethodDef без поля meta — для remote-проксированных контрактов meta молча теряется (в отличие от implement.ts). 1 строка + тест. DO. Не сейчас — в батч после миграции.
type: task
status: done
created: 2026-06-05
updated: 2026-06-05
completed: 2026-06-05 01:00
related: docs/decisions/0021-endpoint-meta-passthrough.md, docs/backlog/inbox/2026-06-05-stitchkit-post-migration-batch.md
---

# implementRemote — meta passthrough

**Тип работы: DO (код, 1 строка + тест).** Преexisting-баг, найден при разборе
meta-passthrough при миграции консьюмера. Ортогонален interface-вопросу.

## Проблема

`tools/remote.ts` (`implementRemote`) строит `MethodDef` и копирует
`method/path/desc/toolName/expose/ui/annotations/scope/paramsSchema/inputSchema/
outputSchema/multipart` — но **НЕ `meta`**. То есть для контракта, примонтированного
через `implementRemote` (тонкий локальный MCP/agent поверх remote API), значение
`EndpointDef.meta` молча теряется. `implement.ts` (`server/implement.ts`) `meta`
пробрасывает — поведение рассинхронено.

## Фикс

В `tools/remote.ts`, в объекте `methods[key]` (рядом с `annotations`):

```ts
meta: endpoint.meta,
```

(`meta` на общей `EndpointDefBase`, поэтому без `in`-guard, как в `implement.ts`.)

## Acceptance

- [x] `tools/remote.ts` копирует `meta`.
- [x] Тест: `implementRemote(contract, client).methods[k].meta` === `endpoint.meta`.
- [x] `bun run verify` зелёный.

## Почему не сейчас

Коммиты в стич на паузе до конца миграции; идёт в консолидированный батч 0.6.0.
Не блокер (консьюмер использует `implement`, не `implementRemote`).

## Что сделано (2026-06-05)

- [x] `tools/remote.ts` — `meta: endpoint.meta` (+ заодно `serviceName`/`key`
  identity) в MethodDef-литерал.
- [x] Тест `tests/methoddef-identity.test.ts` — `implementRemote(...).methods.gated.meta`
  === meta; `.list.meta` === undefined.
- [x] CHANGELOG `[Unreleased]`.
- [x] `bun run verify` зелёный (360 tests).

Реализовано в рабочем дереве; коммитится с релизом 0.6.0.
