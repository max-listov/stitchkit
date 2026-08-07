---
title: Named trailing wildcard params
description: Заменить магический params['*'] на явный terminal wildcard /*name во всём contract/router/client/OpenAPI pipeline
type: task
status: done
created: 2026-08-07
updated: 2026-08-07
completed: 2026-08-07 13:56 +00:00
---

# Named trailing wildcard params

## Решение

Единый синтаксис — `/*filePath`; имя используется в Zod params, handler context,
typed client, raw routes и OpenAPI extension. Bare `/*` удалён без alias.

## План

- [x] Parser принимает только terminal `/*<identifier>`.
- [x] Identifier валидируется; duplicate с `:param` запрещён.
- [x] Router пишет decoded slash-joined remainder под named key, включая empty.
- [x] Ordering, allowedMethods, shadows и raw/contract matchers используют одну модель.
- [x] Contract definition требует совместимое named field в params schema.
- [x] Client planner consumes/segment-encodes named remainder.
- [x] OpenAPI extension публикует реальное parameter name.
- [x] Fixtures, Socket.IO route и актуальные docs переведены на named syntax.
- [x] Contracts/server/client guides, llms, changelog и upgrading обновлены.

## Tests

- [x] Param + nested wildcard, wildcard-only и empty remainder.
- [x] Percent decoding и slash-preserving client encoding.
- [x] Invalid/missing/non-terminal/duplicate names fail-first.
- [x] Specific precedence, allowed methods и shadow diagnostics.
- [x] Params Zod validation и typed handler/client args.
- [x] Raw routes используют ту же named модель.
- [x] OpenAPI extension проверен.
- [x] Полный `bun run verify` зелёный: 865 tests, build, Node smoke, consumer lane.

## Acceptance

- [x] Public contract code больше не использует `params['*']`.
- [x] Named wildcard одинаков в router, handler, client и OpenAPI.
- [x] Compatibility alias отсутствует.
- [x] Breaking migration описана механически.

## Что сделано

- [x] Shared parser: `packages/core/src/internal/route-pattern.ts`.
- [x] Contract validation: `packages/core/src/contract/define.ts`.
- [x] Router/raw/static/Socket.IO: `packages/core/src/server/router.ts`,
      `packages/core/src/server/socket-io.ts`, `packages/core/src/server/types.ts`.
- [x] Client/OpenAPI: `packages/core/src/browser/client-url.ts` и
      `packages/core/src/server/openapi.ts`.
- [x] Tests и docs обновлены по всем затронутым surfaces.
- [x] Validation: полный `bun run verify` прошёл.
- [x] Не делалось: commit, push, release, deploy и внешняя consumer migration.
