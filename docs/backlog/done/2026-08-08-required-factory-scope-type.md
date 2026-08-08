---
title: Required scope type from createContractFactory
description: Make the factory's required literal scope remain non-optional on the returned contract metadata.
type: task
status: done
created: 2026-08-08
updated: 2026-08-08
completed: 2026-08-08 06:53 +00:00
---

# Required scope type from `createContractFactory`

## Problem

`createContractFactory` requires a scope and preserves its concrete literal, but
returns `ContractDef<T, TScope>`. `ContractDef.meta` is `ContractMeta<TScope>`,
whose `scope` remains optional for plain `defineContract`, so consumers still see
`contract.meta.scope` as `TScope | undefined`. The public type is weaker than the
factory's runtime guarantee.

## Decision

Keep `ContractMeta.scope` optional for ordinary contracts and introduce a scoped
factory return type whose `meta.scope` is required. Do not change runtime
behaviour and do not weaken the literal-preserving factory signature.

## Plan

1. Add an exported scoped contract type that composes the ordinary contract shape
   with `meta: ContractMeta<TScope> & { scope: TScope }` without duplicating the
   rest of contract metadata.
2. Make `ScopedDefineContract` return that type while preserving the concrete
   `const TContractScope` literal.
3. Keep the implementation cast-free and continue forwarding every contract
   metadata field through the validated `defineContract` path.
4. Add compile-time fixtures proving required scope, literal preservation,
   allowed-scope enforcement and compatibility with scoped clients/builders.
5. Update the contracts guide, API reference, generated consumer docs and
   changelog.

## Acceptance

- [x] A factory contract with scope `'user'` exposes `meta.scope` as exactly
  `'user'`, not `'user' | undefined` and not the complete allowed union.
- [x] Assigning `undefined`, another allowed literal or an unknown scope fails at
  compile time.
- [x] Omitting scope at the factory call site still fails at compile time.
- [x] Plain `defineContract` keeps its existing optional/default-public model.
- [x] `implement`, scoped clients, scoped URL builders and all transports accept
  the stronger contract without adapters.
- [x] Runtime tests and packed-consumer typechecks pass.

## Что сделано

- [x] **Contract:** добавлен экспортируемый `ScopedContractDef` с обязательным
  literal `meta.scope`; factory сохраняет точный scope без casts —
  `packages/core/src/contract/factory.ts`.
- [x] **Types/tests:** compile-time fixtures проверяют literal, `undefined`,
  неизвестный и отсутствующий scope, а runtime test проходит через
  `implement`/server/client — `packages/core/tests/contract-factory.test.ts`.
- [x] **Docs:** contracts guide, API reference и changelog описывают усиленный
  return type; generated `llms.txt` пересобран штатным build pipeline.
- [x] **Gates:** `bun run verify` полностью зелёный, включая packed consumers.
