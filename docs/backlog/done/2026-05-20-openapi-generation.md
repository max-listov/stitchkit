---
title: OpenAPI 3.1 генерация из defineContract
description: Генерировать OpenAPI-спеку напрямую из контрактов stitchkit — контракт уже Zod-схема, спека бесплатна
type: task
status: done
created: 2026-05-20
updated: 2026-05-29
completed: 2026-05-29 15:22
---

# OpenAPI 3.1 генерация из `defineContract`

## Зачем

stitchkit метит в «лучший фреймворк». Контракты (`defineContract`) уже несут полную типовую информацию — Zod-схемы `params` / `input` / `output`, `desc`, `method`, `path`, `scope`. Из этого OpenAPI-спека генерится **бесплатно, без декораторов и дублирования** — контракт ЕСТЬ спека. Ни Elysia, ни Hono не дают этого «из коробки» так чисто.

## Факт — реализуемо

`z.toJSONSchema()` (Zod 4, проверено на `zod@4.4.3`) рабочий:
```
z.toJSONSchema(z.object({ id: z.string(), n: z.number().optional() }))
// → { type:'object', properties:{id:{type:'string'},n:{type:'number'}}, required:['id'], additionalProperties:false }
```
Zod → JSON Schema конвертится нативно. Значит OpenAPI-генератор — чистая сборка документа, без ручного интроспекта схем.

## Подход

Новый модуль `packages/core/src/server/openapi.ts`:

```ts
generateOpenApiDocument(config: {
  info: { title; version; description? };
  services?: ServiceDef[];
  groups?: { pathPrefix?; services }[];
}): OpenApiDocument   // { openapi:'3.1.0', info, paths }
```

Для каждого HTTP-exposed метода (`expose` включает `'HTTP'`):
- `path` — `service.prefix + method.path`, `:param` → `{param}` (OpenAPI-синтаксис).
- `parameters` — из `paramsSchema` (`in: path`) + для GET из `inputSchema` (`in: query`).
- `requestBody` — для non-GET с `inputSchema` → `content['application/json'].schema`.
- `responses` — `200` из `outputSchema`; коды ошибок — из общего error-envelope.
- `summary` — `method.desc`.

Опционально — `RawRoute`-хелпер `openApiRoute('/openapi.json', doc)` чтобы отдавать спеку эндпоинтом (+ Swagger-UI страница).

Объём ядра — ~100 строк.

## Открытые вопросы

- **Typed path params** — Hono выводит тип `params` из литерала пути (`'/x/:id'` → `{id:string}`) через template-literal types. Можно и нам, но это отдельная крупная TS-фича — НЕ в первой версии (сейчас `Record<string,string>`).
- `components`/`$ref` дедуп схем — в v1 инлайнить (валидный OpenAPI), рефы — позже если спека раздуется.
- Где брать список error-ответов на эндпоинт — из `scope` (auth → 401/403) + общего набора.

## Контекст

Идея возникла при обкатке stitchkit на реальном пилоте — nice-to-have, не блокер ни одной задачи, поэтому отложено в inbox.

## Что сделано

### Core (stitchkit)
- [x] `generateOpenApiDocument({ info, services, groups, servers })` → `{ openapi:'3.1.0', info, paths }` — `packages/core/src/server/openapi.ts`
- [x] HTTP-only фильтр методов = **то же правило, что у роутера** (`expose` отсутствует ИЛИ включает `'HTTP'`)
- [x] path-params (`in:'path'`), GET-input → query, non-GET input → JSON `requestBody`, `output` → 200, `scope≠public` → 401/403
- [x] конвертация через **единый** `toJsonSchema` + `jsonSchemaFields` (тот же walker, что CLI `--help`) — без дубля интроспекции
- [x] `openApiRoute('/openapi.json', doc)` — `RawRoute` отдаёт спеку
- [x] экспорт из `stitchkit/server` — `packages/core/src/server/index.ts`

### Decisions / tests
- [x] ADR 0018 — `docs/decisions/0018-openapi-generation.md`
- [x] `tests/openapi.test.ts` (paths, params, requestBody, error-responses, tool-only skip, `openApiRoute`)

### Что НЕ делалось (отложено явно)
- `components`/`$ref`-дедуп — схемы инлайнятся (валидный OpenAPI), рефы позже.
- Typed path-params из литерала пути (Hono-style) — отдельная крупная TS-фича.
- Swagger-UI страница.
