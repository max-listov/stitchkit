---
title: "ADR 0078 — The scope map is derived from the auth hook"
description: A rule declares its context contribution by performing it — a typed per-rule inject — and createScopedImplement consumes the derived map, removing the hand-written map that drifted beside the hook.
type: decision
status: accepted
created: 2026-08-17
updated: 2026-08-17
---

# ADR 0078 — The scope map is derived from the auth hook

- **Status:** Accepted — extends [ADR 0075](0075-per-scope-handler-context.md)
- **Date:** 2026-08-17

## Context

ADR 0075 shipped `createScopedImplement` with a hand-written scope→context map
and named the consequence honestly: the map is an application claim the
framework does not verify. Both first adopters hit that consequence on day one.
One mistyped the map and the compiler punished innocent handlers; the other
compared his draft against the hook's actual `inject` and found it wrong in
four scopes out of six — "one big superset lie traded for six small unverifiable
ones".

The root: the application already has a place where the contribution is
declared **by being performed** — `createAuthHook`'s `inject`. The map was a
second, parallel description of the same fact, and two hand-written
descriptions of one fact drift.

A second, related report: the documented `public: object` pattern is wrong in
substance. A `'public'` rule admits the anonymous caller — it does not refuse
to know the logged-in one. `resolve` and `inject` still run, and public
endpoints legitimately read the identity (`init` / `me` / `logout`). Typing
public as "no fields" pushes those handlers toward casts.

## Decision

A rule may take an object form, **`ScopedAuthRule`**: `{ rule, inject? }`,
where `inject(identity, ctx)` returns the fields this scope contributes and the
hook merges them into the context. The return type is the declaration:
**`RuleScopes<TRules>`** derives the scope→context map from the rules object,
`createAuthHook` returns a hook carrying that map at the type level
(**`ScopedAuthHook`**, a type-only marker property), and **`AuthScopes<typeof
hook>`** feeds it to `createScopedImplement` unchanged:

```ts
const hook = createAuthHook({ resolve, rules })
export const implementFor = createScopedImplement<AuthScopes<typeof hook>>()
```

Derivation rules:

- a rule whose type **admits** `'public'` yields **`Partial`** fields — injected
  when an identity is present, absent otherwise, and the type says exactly that.
  Membership, not the exact literal: `flag ? 'public' : 'authenticated'` may
  skip the inject at runtime, so a union containing `'public'` must derive
  optional too;
- any other rule's fields are required — the rule rejected the request before
  the handler if no identity resolved;
- a bare rule (no object form) contributes `object` — a scope with no declared
  fields;
- a scope with no rule at all is no key of the map, so a contract using it
  fails to compile through the derived map — mirroring the hook's own
  fail-closed `no rule for scope` at the type level.

At runtime the per-rule `inject` runs after the shared one, only when an
identity resolved, and **before** the rule check — the contribution is not the
gate, so it may run for an identity the rule then rejects and must stay pure.
It must also be **synchronous**: the type forbids a thenable and the runtime
throws on one, because `Object.assign(ctx, promise)` merges nothing — the exact
silent drift this decision exists to remove. Fields computed *inside* an async
rule (a DB-looked-up role) are outside the derived map's reach; those scopes
stay on the hand-written map, which remains the fallback for applications
without an auth hook, with an explicit generic, or with context enrichment
outside the hook.

## Runtime drift-checking: rejected

A dev-mode warning comparing "fields actually injected" against "fields
declared for the scope" (the `warnOnOutputStrip` analogue requested alongside)
is **rejected**. The runtime cannot see the declared map — types erase — so the
check would need a runtime restatement of the map, recreating the exact
two-descriptions problem this decision removes. Derivation eliminates the drift
class by construction wherever the hook is the source; a hand-written map
remains an unverified claim, now documented as the fallback's price.

## Consequences

- One declaration fills the context and types the handlers; the map cannot
  drift from the hook because it is computed from it.
- `AuthHookConfig` gains a second type parameter with a default, and
  `createAuthHook` a `const` rules parameter. Existing callers keep compiling;
  callers who pass an explicit identity generic forgo derivation (TypeScript
  has no partial inference) and keep the hand-written map.
- The derived map cannot express fields injected outside the hook (a
  `beforeHandle` that enriches the context). Those remain the hand-written
  map's territory, or a manual intersection with the derived map.
- The shared `inject` stays untyped and contributes nothing to the map — it
  predates this decision and remains for identity attachment that no scope owns.
