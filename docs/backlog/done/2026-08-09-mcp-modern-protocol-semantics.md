---
title: "MCP 2026-07-28 — discovery, routing headers и cacheable deterministic surfaces"
description: "Закрепить modern wire semantics поверх v2 transport: server/discover, проверяемые headers, честные cache hints, стабильный каталог и MCP Apps regression lane."
type: task
status: done
created: 2026-08-09
updated: 2026-08-09
completed: 2026-08-09 16:14 +00:00
related: docs/backlog/done/2026-08-09-mcp-2026-v2-release.md
---

# MCP modern protocol semantics

## Зачем

Modern handler сам умеет wire envelope, `server/discover` и проверку стандартных
headers, но framework должен правильно объявить изменчивость surfaces и не
потерять проверенную operation identity в observability. Без явной политики SDK
будет безопасно отвечать `ttlMs: 0`, а prepared finite surfaces не дадут пользы
клиентскому cache/prompt stability.

## Результат

- Discovery точно отражает capabilities реального handler.
- `MCP-Protocol-Version` и routing `Mcp-Param-*` headers проверяются официальным
  SDK; объявленные tool parameters получают `x-mcp-header`, а header/body
  mismatch возвращает protocol error `-32020` до framework handler.
- Tool/resource lists имеют детерминированный порядок.
- Cache hints зависят от владельца surface, а private результаты никогда не
  смешиваются между authorization contexts.
- MCP Apps metadata/resources сохраняются в modern и legacy-stateless eras.

## Политика кэширования

- Default остаётся безопасным: `{ ttlMs: 0, cacheScope: 'private' }`.
- Static direct surface и finite registry могут получить **только явно**
  настроенный TTL,
  но scope остаётся `private`, если visibility выбирается после auth.
- Identity-dependent factory без bounded key не получает положительный TTL.
- Порядок формируется каноническим registry/descriptor order и одинаков для
  manifest, MCP discovery и Agent surface.
- Framework не обещает `public` автоматически; это отдельное осознанное поле.

## Целевая публичная форма

```ts
createMcpHandler({
  services,
  cache: {
    default: { ttlMs: 0, scope: 'private' },
    operations: {
      listTools: { ttlMs: 60_000, scope: 'private' },
    },
  },
});
```

Positive TTL всегда explicit. Routing metadata описывается через официальный
`x-mcp-header`; Stitchkit не вводит собственные header names и не использует
self-reported client info как RBAC identity.

## План

- [x] Сверить точные v2 `ServerOptions.cacheHints`, resource `cacheHint` и
      `server/discover` types; не дублировать wire schemas.
- [x] Ввести один object-shaped Stitchkit cache policy в MCP server config с
      безопасными defaults и без positional API.
- [x] Разрешить per-operation policy только там, где SDK и ownership дают ясную
      семантику; resource override не должен протекать в list metadata.
- [x] Не выводить positive TTL из prepared/static автоматически: все surfaces
      получают `ttlMs: 0`/`private`, пока consumer явно не задаст policy для
      конкретной immutable operation/resource.
- [x] Закрепить детерминированный порядок contracts/runtime tools/resources и
      cross-check с `buildToolManifest`/`listToolNames`.
- [x] Проверить, что `list_changed` и cache invalidation не заявляются без
      notification mechanism; prepared surface меняется только при deploy.
- [x] Добавить nested MCP transport metadata к `RequestEvent`: negotiated era,
      self-reported client info, resolved method/tool name и routing headers после
      SDK validation. Self-reported client info не становится auth principal и
      не расширяет generic `RuntimeContext`.
- [x] E2E: отсутствующий/неверный `MCP-Protocol-Version`, malformed/mismatched
      `Mcp-Param-*` и body parameters дают SDK protocol rejection (`-32020` для
      header mismatch) до lifecycle/tool handler; reject создаёт transport audit,
      но не successful tool-call event.
- [x] Проверить `x-mcp-header` annotations в discovery и routing сквозь gateway;
      отдельно документировать, что browser clients не зеркалят dynamic headers
      автоматически из-за CORS и должны использовать body/default routing.
- [x] E2E: повторный cacheable list возвращает одинаковый **семантический** порядок
      и hints; private scopes не объявляются shareable. Byte equality не является
      контрактом сериализатора.
- [x] E2E Apps: UI tool discovery, `ui://` resource read, MIME type, `_meta.ui`,
      text fallback и raw multimodal content работают в modern и legacy-stateless.
- [x] Проверить актуальный `@modelcontextprotocol/ext-apps`: если его peer остаётся
      на v1, не смешивать его server type с v2; зафиксировать transitive состояние
      и тестировать только публичный extension contract.
- [x] Обновить guide/API/architecture с таблицей surface kind → cache policy и
      примерами gateway routing headers.

## Не входит

- Собственный reverse proxy/WAF/rate limiter.
- Client response-cache implementation.
- `subscriptions/listen` и mutable runtime catalogs.
- Автоматический public cache для unauthenticated endpoints.

## Acceptance

- [x] Modern discovery/list responses соответствуют `2026-07-28` и содержат
      обязательные cache fields.
- [x] Static/finite и dynamic surfaces получают ожидаемую различную freshness.
- [x] Один и тот же surface выдаёт stable semantic ordering между запросами;
      тест не зависит от byte-for-byte JSON serialization.
- [x] Header/body mismatch не вызывает lifecycle, handler или audit success event.
- [x] Validated method/name доступны observability без нового untrusted auth path.
- [x] Apps/UI resource и multimodal regression tests зелёные на v2 runtime.

## Конвейер 2/2 со стопом

- [x] Валидатор плана 1: protocol cache/header/discovery correctness.
- [x] Валидатор плана 2: prepared surface/API/Apps compatibility boundaries.
- [x] Findings внесены; ожидается owner stop-gate перед кодом.
- [x] Валидатор реализации 1: wire conformance и negative tests.
- [x] Валидатор реализации 2: deterministic/cache isolation/Apps audit.

## Правки валидатора 1

- Исправлена routing-модель на реальные `MCP-Protocol-Version`, `Mcp-Param-*`,
  `x-mcp-header` и `HeaderMismatch (-32020)` вместо выдуманной пары headers.
- Добавлены browser/CORS limitation и fail-first capability semantics.
- Transport rejection отделён от успешного lifecycle/tool audit.

## Правки валидатора 2

- Убрана автоматическая положительная freshness даже для prepared surface:
  безопасный default всегда zero/private, opt-in задаётся явно.
- Детерминизм определён как semantic ordering, не byte equality.
- Self-reported client info изолирован от auth identity, Apps v1 dependency — от
  публичных v2 types.

## Что сделано

- [x] Modern `2026-07-28` discovery/routing semantics и header mismatch handling
      реализованы на transport boundary в `packages/core/src/tools/mcp-handler.ts`.
- [x] Object-shaped cache policy с zero/private default и explicit finite-surface
      opt-in добавлена в `packages/core/src/tools/mcp.ts`.
- [x] Negotiated MCP metadata добавлена в canonical observability event через
      `packages/core/src/observability/event.ts` и `audit.ts`.
- [x] Stable semantic ordering, cache isolation и negative routing matrix покрыты
      `packages/core/tests/mcp-v2-modern.test.ts` и preparation-cache tests.
- [x] MCP Apps UI resource, MIME/meta и multimodal behavior проверены существующим
      `packages/core/tests/mcp-app.test.ts` на v2 runtime.
