---
title: Tool≡HTTP паритет — закрытие хвостов после внешнего ревью
description: Auth-хук на tool-пути молча no-op, ADR паритета не написан, нет cross-surface теста — четыре пробела из внешнего аудита
type: task
status: done
created: 2026-05-20
updated: 2026-05-20
completed: 2026-05-20 23:15
related: docs/backlog/done/2026-05-20-tools-surface-integrity.md
---

# Tool≡HTTP паритет — закрытие хвостов

## Зачем

Внешний аудит после релиза 0.2.0 (проверка кода, не changelog) подтвердил: из
~20 пунктов tools-surface-integrity закрыто 15-16 по-настоящему. Но 4 хвоста
остались, и один — реальная auth-дыра.

## Пробел 1 — `createAuthHook` молча no-op на tool-пути (P1, security)

`createAuthHook` (`server/middleware/auth.ts:125`):

```typescript
return async (ctx, endpoint) => {
  if (!(ctx.req instanceof Request)) return;   // ← tool-путь: req нет → ХУК ВЫХОДИТ
```

`createAuthHook` — единственный штатный auth-механизм. Весь построен на
`ctx.req`. На tool-пути `ctx.req` отсутствует → хук **целиком no-op**.

`execute.ts` обещает «tools are scope-guarded exactly as HTTP routes are».
`mcp-and-agents.md` — «pass the same createAuthHook result ... scope-checked by
the identical rules». Обе формулировки **ложь**: tool с `scope:'admin'`
вызывается кем угодно. Failed-**open**.

### Решение

Identity на tool-пути приходит не из `req`, а из transport-auth: MCP API key →
`buildMcpServer` `context(auth)` → поля контекста. К моменту `lifecycle.
beforeHandle` идентичность уже в `ctx`.

`createAuthHook` получает второй резолвер для не-HTTP контекстов:

```typescript
export interface AuthHookConfig<TIdentity> {
  // ...existing...
  /**
   * Resolve identity on a non-HTTP context (a tool call) where there is no
   * `req`. The transport (MCP / agent) has already authenticated the caller;
   * this locates the identity it injected into `ctx`. Without it, a scoped
   * tool call with no `req` fails closed (rejected).
   */
  resolveFromContext?: (ctx: RuntimeContext) => Awaited<TIdentity> | null;
}
```

Тело хука: ветвление по `ctx.req instanceof Request`. HTTP → `resolve(ctx)`.
Tool → `resolveFromContext(ctx)`. Нет `resolveFromContext` + scope требует
auth → `identity = null` → `onAnonymous()`. **Fail closed, не open.**

## Пробел 2 — ADR паритета не написан, номер украден (P2)

Задача `tools-surface-integrity` планировала «Новый ADR 0013 — tool-поверхность
несёт те же гарантии что HTTP». Номер 0013 занят runtime-agnostic core. ADR
паритета (F5/F15/F16/F17) **никогда не написан**. Инвариант держится кодом без
ADR-дома.

### Решение

`docs/decisions/0014-tool-http-parity.md` — tool-поверхность несёт те же
контрактные гарантии что HTTP: disjoint-срез params/input, output-валидация,
lifecycle-гейт, защита reserved-keys. Уточняет ADR 0007 (паритет MCP≡agent →
расширяется до tool≡HTTP). Фиксирует **намеренные** различия: error envelope
`{error, details?, _hint?}` ≠ HTTP `ErrorEnvelope`; multipart endpoint —
HTTP-only, в tool не превращается.

## Пробел 3 — нет cross-surface parity теста (P2)

`execute.test.ts` юнит-тестит tool-путь. Нет теста «одни args через HTTP и
через tool → идентичный accept/reject». Сторожа от регрессии нет.

### Решение

`tests/parity.test.ts` — один контракт, прогон одних args через `createHandler`
(HTTP) и `executeToolMethod` (tool), ассерт идентичного accept/reject:
valid input, invalid input, strict-схема, output-валидация.

## Пробел 4 — мелочь (P3)

- multipart endpoint молча скипается в `collectTools` — задокументировано в
  коде-комментарии, runtime-лог не нужен (collectTools без logger). Различие
  фиксируется в ADR 0014.
- tool error envelope ≠ HTTP envelope — фиксируется в ADR 0014 как намеренное.

## Порядок

1. Фикс `createAuthHook` + `resolveFromContext`
2. ADR 0014
3. Cross-surface parity тест
4. Обновить доки (`auth-and-errors.md`, `mcp-and-agents.md`) — модель
   tool-path auth
5. CHANGELOG

---

## Что сделано

### Пробел 1 — auth-хук no-op на tool-пути (security)
- [x] `AuthHookConfig.resolveFromContext?` — резолвер identity для не-HTTP
  контекста (`server/middleware/auth.ts:99-106`)
- [x] `createAuthHook` тело — ветвление по `ctx.req instanceof Request`:
  HTTP → `resolve`, tool → `resolveFromContext` (`auth.ts:138-144`)
- [x] Убран `if (!(ctx.req instanceof Request)) return;` — больше нет
  silent no-op. Нет `resolveFromContext` → identity null → fail closed
- [x] 8 тестов `tests/auth-hook.test.ts` — HTTP-путь, tool fail-closed,
  resolveFromContext sync/async, scope rule

### Пробел 2 — ADR паритета
- [x] `docs/decisions/0014-tool-http-parity.md` — tool≡HTTP паритет, уточняет
  ADR 0007
- [x] `docs/decisions/README.md` — ADR 0014 в индексе

### Пробел 3 — cross-surface parity тест
- [x] `tests/parity.test.ts` — 4 теста: valid, invalid type, strict extra key,
  output mismatch — прогон через `createHandler` и `executeToolMethod`

### Пробел 4 — мелочь
- [x] Намеренные различия (error envelope, multipart HTTP-only) зафиксированы
  в ADR 0014, секция «Intentional differences»

### Бонус — 5-й баг, найден parity-тестом
- [x] HTTP output-mismatch давал `VALIDATION_ERROR` (400) — handler вернул
  кривой output, но это серверный фолт. Теперь `INTERNAL_SERVER_ERROR` (500),
  как на tool-пути (`server/create.ts:184-196`)

### Качество
- [x] 216 тестов pass (было 204, +12), 0 fail
- [x] Lint, typecheck, build — green
- [x] CHANGELOG — секция «Tool ≡ HTTP parity — follow-up fixes»
- [x] Доки `auth-and-errors.md` + `mcp-and-agents.md` — модель tool-path auth

### Ссылки на код
- `packages/core/src/server/middleware/auth.ts` — `resolveFromContext`, фикс хука
- `packages/core/src/server/create.ts:184-196` — output-mismatch → 500
- `packages/core/tests/parity.test.ts`, `tests/auth-hook.test.ts`
- `docs/decisions/0014-tool-http-parity.md`
