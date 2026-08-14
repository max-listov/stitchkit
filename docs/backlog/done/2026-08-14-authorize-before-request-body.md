---
title: Авторизация до чтения request body
description: Ввести отдельную pre-body authorization-фазу, чтобы отклонённый JSON или multipart-запрос не читался и не буферизовался до проверки scope
type: task
status: done
created: 2026-08-14
updated: 2026-08-14
completed: 2026-08-14 07:21 +00:00
---

# Авторизация до чтения request body

## Зачем

Сейчас HTTP dispatcher сначала вызывает `parseRequestInto()`, включая полное чтение
JSON или buffered multipart, и только затем запускает `beforeHandle`. Поэтому
`createAuthHook`, подключённый как `beforeHandle`, отклоняет запрос до handler, но уже
после расходования ресурсов на его body. Для публичного upload endpoint с лимитом в
сотни мегабайт неавторизованный клиент может заставить процесс прочитать и удержать
весь допустимый payload до ответа `401/403`.

Нельзя просто переставить весь `beforeHandle` перед parsing: существующие lifecycle
hooks законно используют валидированные `params`/`input`. Нужна отдельная фаза с узкой
семантикой — идентификация и разрешение доступа до чтения payload.

## Результат

- После route match и валидации path params запускается отдельный `authorize` hook.
- Отказ `authorize` проходит через канонические `onError`, CORS, logging и
  observability, но request body остаётся непрочитанным.
- `beforeHandle` сохраняет текущую семантику: получает полностью валидированный
  контекст непосредственно перед handler.
- `createAuthHook` становится каноническим HTTP `authorize` hook; старое HTTP-подключение
  через `beforeHandle` удаляется, а не сохраняется compatibility wrapper-ом.

## Целевой lifecycle

```text
onRequest
→ route match + operation identity
→ path params validation
→ global authorize
→ route-group authorize
→ query / JSON / multipart parsing and validation
→ global beforeHandle
→ route-group beforeHandle
→ handler
→ afterHandle
→ output validation and response
```

Для MCP/Agent/CLI тело уже принято соответствующим transport до Stitchkit runner.
Там тот же `createAuthHook` продолжает подключаться как tool lifecycle
`beforeHandle`; HTTP и tool wiring должны быть явно показаны рядом в документации.

## Публичный API

```ts
const auth = createAuthHook({ authenticate, authorize });

createServer({
  services,
  hooks: {
    authorize: auth,
    beforeHandle: applicationPreconditions,
  },
});

createMcpHandler({
  services,
  lifecycle: { beforeHandle: auth },
});
```

`authorize` получает `RuntimeContext` с `req`, URL, headers, trace/client metadata и
валидированными `params`, но без `input`, `file` или иных payload-derived значений.
Тип hook должен отражать эту границу, чтобы auth-код не мог случайно зависеть от body.

## План

- [x] Разделить сборку контекста на URL/params-фазу и payload-фазу; не дублировать
      route matching, error context или schema parsing.
- [x] Добавить `authorize` в global и route-group lifecycle types и dispatcher.
- [x] Выполнить global/group authorization в прежнем стабильном порядке до первого
      чтения request body.
- [x] Перевести `createAuthHook` и все repo callsites/tests/docs на HTTP `authorize`;
      не оставлять alias через `beforeHandle`.
- [x] Сохранить tool lifecycle wiring через `beforeHandle`, поскольку tool transport
      не имеет отдельной body-reading фазы.
- [x] Обеспечить одинаковую нормализацию ошибок, trace/operation identity, CORS и одну
      completion event для отказов обеих authorization-фаз.
- [x] Обновить user guide, API reference, `llms.txt` source docs и upgrade guide.
- [x] Добавить breaking-change запись в `[Unreleased]` с before → after примером.

## Тестовая матрица

- [x] Unauthorized JSON request возвращает ожидаемый error envelope, а instrumented
      `ReadableStream` подтверждает ноль прочитанных body chunks.
- [x] Unauthorized multipart request с большим payload не читает ни одного chunk и
      не вызывает multipart parser.
- [x] Authorized request читает и валидирует body ровно один раз.
- [x] Invalid path params отклоняются до authorization с сохранённой endpoint identity.
- [x] Invalid JSON/multipart после успешной authorization попадает в `onError`, а
      handler и `beforeHandle` не запускаются.
- [x] Global и route-group `authorize` выполняются в документированном порядке;
      отказ первого не запускает второй.
- [x] `beforeHandle` по-прежнему видит валидированные `params`, `input` и multipart.
- [x] Node smoke и consumer lane подтверждают Fetch-clean API и отсутствие Bun types.

## Acceptance

- [x] Ни один body chunk отклонённого scoped HTTP request не читается до успешной
      авторизации.
- [x] Для public/unscoped endpoints поведение parsing и validation не меняется.
- [x] В HTTP API существует один канонический auth wiring — `hooks.authorize`.
- [x] Ошибки authorization наблюдаемы тем же способом, что остальные contract errors.
- [x] Документация не обещает, что обычный `beforeHandle` работает до body parsing.
- [x] Полный `bun run verify` зелёный.

## Не входит

- Rate limiting, CSRF policy и доменная проверка принадлежности сущности.
- Изменение raw routes: они по-прежнему сами владеют auth и чтением body.
- Compatibility alias, вызывающий один auth hook сразу в двух HTTP-фазах.

## Что сделано

- [x] **Contract/server:** в `packages/core/src/server/types.ts`, `context.ts` и
      `create.ts` добавлена отдельная `authorize`-фаза после path params и до первого
      чтения payload; `beforeHandle` сохранён как post-validation lifecycle.
- [x] **Auth adapter:** `packages/core/src/server/middleware/auth.ts` поддерживает
      `AuthorizationContext` для HTTP и прежний `RuntimeContext` для tool lifecycle без
      второго HTTP auth-пути.
- [x] **Документация:** обновлены auth/server/multi-tenant/testing guides, API reference,
      upgrade guide, changelog и ADR 0072.
- [x] **Тесты:** `packages/core/tests/authorize-before-body.test.ts` —
      `rejects JSON and multipart requests without reading a body chunk`,
      `validates params before authorize and preserves global/group order`,
      `a global rejection stops group authorize and payload lifecycle`,
      `authorized input is parsed before beforeHandle and handler`,
      `invalid payload after authorize skips beforeHandle and handler`.
- [x] **Гейты:** полный `bun run verify` прошёл, включая Node smoke и consumer lane.
