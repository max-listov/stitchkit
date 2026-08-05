---
title: "Two callback signatures drop context they could carry — createErrorHook throws ctx away, nativeTools never receives auth"
description: createErrorHook discards ctx so a ready-made error envelope cannot carry traceId; nativeTools is the only McpServerBuildConfig callback of three that does not receive the resolved auth.
type: task
status: done
created: 2026-08-05
updated: 2026-08-05
completed: 2026-08-05 15:10 +07:00
---

# Give two callbacks the context their siblings already get

Both reported by a consuming project; both verified in v0.25.0. Bundled because
they are the same shape of defect (a callback that cannot see what the framework
already holds), both additive, both small. **Split them the moment either grows a
design question** — they share a task, not a rationale.

## 1. `createErrorHook` discards `ctx`

`server/error-hook.ts:66` — `return (_ctx, error) => {`. The hook signature
receives the `RuntimeContext`, the helper drops it, and `render` / `onError` only
see `ResolvedError`. `RuntimeContext` carries `traceId` and `spanId`
(`contract/define.ts:209-210`), so a consumer who wants a trace id in the error
envelope — the ordinary reason to have one — must abandon the helper and hand-roll
`onError`. The helper's whole purpose is to remove that boilerplate.

**Options.**

- **A — pass `ctx` as a second argument** to `render(info, ctx)` and
  `onError(error, info, ctx)`. Additive for callers (a function declared with
  fewer parameters stays assignable), no new concepts.
- **B — fold the trace fields into `ResolvedError`.** Narrower surface, but it
  bakes an opinion about which context fields matter, and the next consumer wants
  a different one (tenant, user id). Rejected.
- **C — leave it, document the hand-rolled path.** Rejected: the helper exists to
  be the ready path, and the hand-rolled `onError` is ~30 lines of exactly the
  normalisation the helper already does correctly.

**Chosen: A.**

## 2. `nativeTools` does not receive `auth`

`tools/mcp.ts` — `services?: ServiceDef[] | ((auth: TAuth) => ServiceDef[])` and
`context?: (auth: TAuth) => Record<string, unknown>`, but
`nativeTools?: (server: McpServer) => void`. Two of three identity-aware, the
third not. A native tool that needs the caller's identity (a per-tenant file
lister, a user-scoped view) cannot get it, while a contract tool can.

**Options.**

- **A — `nativeTools?: (server, auth) => void`.** Additive; existing one-parameter
  callbacks keep working unchanged.
- **B — `(auth) => (server) => void`.** Symmetric with `services`/`context` in
  *form*, breaking in fact, and awkward at the call site. Rejected.

**Chosen: A.** Note it does **not** make native tools auth-*gated* — gating is
`lifecycle`'s job, and native tools bypass it by design (they are not contract
methods). The doc must say so, or someone will read the parameter as a guarantee.

## Plan

- [x] `server/error-hook.ts` — thread `ctx` into `render` and `onError`; update
      `ErrorHookConfig` types; keep both parameters optional at the call site.
- [x] `tools/mcp.ts` — `nativeTools?: (server: McpServer, auth: TAuth) => void`;
      pass the resolved auth in `buildMcpServer`.
- [x] Tests: an error envelope built by `createErrorHook` carries `ctx.traceId`;
      a one-parameter `render` still compiles and runs; `nativeTools` receives the
      same auth object `context` receives; a one-parameter `nativeTools` still
      works.
- [x] `docs/api/reference.md` if either signature is described there; a line in
      the guide that `nativeTools` receiving auth is **not** a scope gate.
- [x] `CHANGELOG.md` — additive.

## Acceptance

- [x] `traceId` reaches the error envelope through the ready-made helper alone.
- [x] Existing callbacks of both kinds compile and behave unchanged.

## Process (конвейер 2/2)

- [x] 2 plan validators
- [x] Implementation
- [x] `bun run verify` green
- [x] 2 implementation validators
- [x] "Что сделано" + `done/`

## Что сделано

- [x] `server/error-hook.ts` — `render(info, ctx)` и `onError(error, info, ctx)`
      получают `RuntimeContext`; `createErrorHook` больше не выбрасывает его в
      `(_ctx, error)`. Пример в докстринге показывает `traceId: ctx.traceId` — это
      и есть причина, по которой параметр понадобился.
- [x] `tools/mcp.ts` — `nativeTools?: (server, auth) => void`, `buildMcpServer`
      передаёт разрешённую identity. В докстринге явно сказано, что это **не**
      scope-гейт: нативные тулы не контрактные методы, `lifecycle` для них не
      выполняется — иначе параметр прочитают как гарантию.
- [x] `tests/hook-signature-consistency.test.ts` — 6 тестов: traceId доезжает до
      конверта через готовый хелпер; `onError` видит тот же ctx; **колбэк с одним
      параметром продолжает работать** (аддитивность обеих правок); `nativeTools`
      получает ту же identity, что `services` и `context`, и она реально доходит
      до результата тула через живой MCP round-trip.
- [x] `docs/guide/auth-and-errors.md` — пример `render` показывает `ctx.traceId`;
      `docs/guide/mcp-and-agents.md` — таблица `McpHandlerConfig` и фраза про то,
      что identity получают все три колбэка; `CHANGELOG.md` под `[Unreleased]`.
- [x] Обе правки аддитивные: функция, объявленная с меньшим числом параметров,
      остаётся присваиваемой, так что ни один существующий консьюмер не двигается.

**Gate:** `bun run verify` exit 0 — 641 pass / 0 fail (в составе набора 0.26.0).
