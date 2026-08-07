---
title: URL builders for every HTTP endpoint
description: Строить contract-owned URL для POST, PUT, PATCH, DELETE и HEAD consumers без требования body arguments и ручных route strings
type: task
status: done
created: 2026-08-07
updated: 2026-08-07
completed: 2026-08-07 13:48 +00:00
related: docs/backlog/inbox/2026-08-07-contract-head-method.md
---

# URL builders for every HTTP endpoint

## Источник

Кросс-аудит consuming application: browser APIs, которым нужен только URL для
body endpoint, не должны хардкодить route или передавать body в URL builder.

## Инварианты

- URL строит существующий `planClientRequest`; второго route planner нет.
- Body/multipart methods принимают только dynamic scope keys и path params.
- `GET`/`DELETE` сохраняют typed flat query args и текущую serialization.
- Non-HTTP operations отсутствуют; builder синхронный и не выполняет I/O.

## План

- [x] Введены method-aware URL args: params + scope для body verbs, query input
      добавляется только `GET`/`DELETE`.
- [x] Расширен один существующий `createUrlBuilder(s)` без конкурирующего API.
- [x] Prefix/path/wildcard/query по-прежнему строит `planClientRequest`.
- [x] Runtime loose input с body/file fields отклоняется fail-first.
- [x] Покрыты zero-param POST, parametrized PUT/PATCH и multipart URL.
- [x] Relative/absolute base и dynamic prefix semantics сохранены.
- [x] Обновлены guide, reference, generated llms и changelog.
- [x] Изменение additive: ранее отсутствующие builder keys только добавлены.

## Tests

- [x] GET с params/query/wildcard остался byte-for-byte прежним.
- [x] Zero-arg POST и parametrized PUT/PATCH покрыты.
- [x] Multipart builder не требует file и не сериализует его.
- [x] DELETE query сохранён; HEAD будет покрыт в отдельной связанной таске.
- [x] Dynamic scope keys обязательны и удаляются из query.
- [x] Non-HTTP endpoint и body-only args недоступны на уровне типов.
- [x] Runtime loose input с body field падает понятной ошибкой.
- [x] URL совпадает с фактическим typed-client request URL.
- [x] Полный `bun run verify` зелёный: 858 tests, build, Node smoke, consumer lane.

## Acceptance

- [x] Browser URL consumers больше не хардкодят body endpoint paths.
- [x] Body schema не становится аргументом URL-only function.
- [x] GET URL behavior не регрессировал.
- [x] Один planner остаётся источником prefix/path/query semantics.

## Что сделано

- [x] Types: method-aware URL signatures реализованы в
      `packages/core/src/contract/define.ts`.
- [x] Runtime: all-method builder и fail-first body-field guard реализованы в
      `packages/core/src/browser/client.ts`.
- [x] Tests: all-method runtime/type coverage добавлен в
      `packages/core/tests/url-builder.test.ts`.
- [x] Docs: обновлены `docs/guide/client.md`, `docs/api/reference.md`, generated
      `packages/core/llms*.txt` и `CHANGELOG.md`.
- [x] Validation: полный `bun run verify` прошёл.
- [x] Не делалось: commit, push, release, deploy и consumer migration.
