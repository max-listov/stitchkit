---
title: "meta cascades from the contract; expose deliberately does not"
description: ContractMeta gains a meta default that endpoints shallow-merge over, removing per-endpoint duplication. The expose cascade is rejected — it does not close the hole it was proposed for, and the real fix (a listToolNames snapshot) needs no framework change.
type: task
status: done
created: 2026-08-05
updated: 2026-08-05
completed: 2026-08-05 14:05 +07:00
related: docs/backlog/done/2026-08-05-tool-name-validation.md
---

# Cascade `meta`, document the `expose` guard, do not cascade `expose`

Supersedes the original combined task after two plan validators took it apart.

## What changed after validation

The original task carried a safety title over an ergonomics body. Both validators
converged on that independently:

- **The cascade does not close the reported hole.** "Forget one line → the endpoint
  is silently an AI tool" stays true for anyone who forgets it at *both* levels.
  Quantified: with ~4 endpoints per contract it divides the chance of the mistake
  by 4 and multiplies the blast radius by 4 — expected exposure roughly flat.
- **It opens a new silent vector.** Today exposure is written on the endpoint, so
  moving an endpoint between contracts is exposure-neutral. With a cascade, moving
  it into a contract that does not declare `expose` turns it into a tool **with no
  diff on the endpoint itself**.
- **The real fix already ships.** `listToolNames(services)` resolves every tool
  through the same resolver the mounts use; pinned in a snapshot it fails the build
  the moment a forgotten `expose` adds a tool. Probed on the reporter's exact
  scenario — the forgotten endpoint is named, attributed and transport-tagged.
- **An `expose` cascade would need five more edit sites** to not regress:
  `browser/client.ts` and `tools/remote.ts` read `endpoint.expose` directly,
  `ExposesHttp` types the client off it, `defineContract`'s `toolName` validator
  reads `ep.expose` (so it would both stop throwing where it should and start
  throwing on a legal contract), and `createContractFactory` **rebuilds** the meta
  object and would silently drop the new field — reintroducing the exact bug in the
  safest-looking code path.
- **`meta` has none of that.** Only `implement` and `implementRemote` read it, and
  the duplication it removes is the larger one the reporter actually hit (73
  endpoints repeating what 8 contracts could declare).

**Decision: cascade `meta` only.** Reject the `expose` cascade, and close the
safety case with documentation pointing at the snapshot guard.

## Merge semantics: shallow merge, not override

The original plan said override. Validator-2 falsified its justification: `meta` is
not decoration — `server/openapi.ts` documents `meta: { public: true }` as the
recommended declarative allowlist for the published spec. Under override, a
contract declaring `{ public: true }` plus one endpoint adding `{ rateTier: 2 }`
**silently drops `public`** and the endpoint vanishes from the spec with no diff
explaining why. Shallow merge (endpoint keys win, one level, no deep merge, no
unset sentinel) matches how the repo tells people to use `meta`.

## Plan

- [x] `contract/define.ts` — `ContractMeta` gains `meta?: Record<string, unknown>`,
      **and both `defineContract` overloads**, whose meta parameter is an inline
      literal type, not `ContractMeta` (editing the interface alone changes nothing
      at call sites).
- [x] `server/implement.ts` — `meta: { ...contract.meta.meta, ...endpoint.meta }`,
      next to the existing `scope` cascade. Undefined on both sides must stay
      `undefined`, not `{}` — readers test `method.meta?.public`.
- [x] `tools/remote.ts` — the same merge; it is a second `MethodDef` producer and
      already had to be patched once for `meta`.
- [x] `contract/factory.ts` — stop rebuilding the meta object; forward it. Without
      this a factory-built contract silently loses the field.
- [x] Tests: endpoint keys win; contract keys survive alongside; neither declared →
      `meta` stays `undefined`; the openapi allowlist case (`{ public: true }` at
      contract level + `{ rateTier: 2 }` on an endpoint keeps both); the same
      through `implementRemote`; a factory-built contract keeps its contract-level
      `meta`.
- [x] `docs/guide/mcp-and-agents.md` — an explicit note that an endpoint with no
      `expose` is a tool on MCP **and** AGENT, and that the way to catch a
      forgotten one is the `listToolNames` snapshot (the section already exists).
- [x] `docs/guide/contracts.md` — document the `meta` cascade and the shallow-merge
      rule.
- [x] **ADR 0036** + index row — records both halves: `meta` cascades, `expose`
      deliberately does not, with the reasoning above so the next reader does not
      re-propose it.
- [x] `CHANGELOG.md` — additive.

## Acceptance

- [x] A contract-level `meta` reaches every endpoint that does not override it,
      through `implement` **and** `implementRemote` **and** the scoped factory.
- [x] An endpoint adding one key keeps the contract's other keys.
- [x] `expose` behaviour is byte-identical to 0.25.0.
- [x] The guide states the fail-open default and the snapshot guard.

## Process (конвейер 2/2)

- [x] 2 plan validators — both findings folded in; the decision was reversed as a
      result (no `expose` cascade, shallow merge instead of override)
- [x] Implementation
- [x] `bun run verify` green
- [x] 2 implementation validators
- [x] "Что сделано" + `done/`

## Правки валидатора реализации

Verified: merge correct in all three producers; `expose` **byte-identical** to
HEAD (validator diffed three trees — worktree, worktree with the four meta files
reverted, and pure HEAD — over a six-endpoint matrix through `collectTools`,
`listToolNames`, `createClient`, `mountMcp`, `mountAgent`: empty diff both ways);
no framework code assigns meaning to `method.meta`, so nothing downstream moved.

Three defects found and fixed:

1. **CONFIRMED-BUG — the CHANGELOG entry landed in released sections.** My
   `replace` matched every `### Fixed` in the file, so the block was inserted
   **twelve times**, inside `[0.25.0]`, `[0.21.0]`, `[0.19.0]`, `[0.15.x]` … and
   was **absent from `[Unreleased]`**. Released sections are immutable history.
   All copies removed, one block inserted under `[Unreleased]`; `git diff` on
   `CHANGELOG.md` is now +72/−0, so nothing historical was touched.
2. **CONFIRMED-BUG (latent) — aliasing.** `mergeMeta` returned the contract's own
   object by reference whenever the endpoint declared no `meta`, so one hook doing
   `endpoint.meta.x = …` would corrupt every sibling endpoint, the contract
   definition itself, and every later `implement` of it. Identity was also
   inconsistent — merged case fresh, inherited case shared. Now always a copy, and
   pinned by a mutation-isolation test.
3. **MISSING — `docs/api/reference.md`** still described `ContractMeta` as
   "`prefix` + optional `scope`". That file is what `gen:llms` turns into the
   `llms.txt` shipped inside the package, so the new field was invisible to a
   consuming project's agent. Updated.
- **WEAK-TEST → strengthened.** "an endpoint key wins" used a single key on both
  sides, which is indistinguishable from ignoring the contract entirely; it now
  carries a second contract-only key that must survive.

## Что сделано

- [x] `contract/define.ts` — `ContractMeta.meta`, both `defineContract` overloads
      (their meta parameter is an inline literal, so the interface alone would have
      changed nothing), and the internal `mergeMeta` helper (always copies).
- [x] `server/implement.ts`, `tools/remote.ts` — the merge at both `MethodDef`
      producers; `contract/factory.ts` forwards the meta object instead of
      rebuilding it; `ScopedDefineContract` accepts `meta`.
- [x] `tests/contract-meta-cascade.test.ts` — 9 tests: inheritance, endpoint-wins
      with survivors, the OpenAPI allowlist case, `undefined` not `{}`, mutation
      isolation, `implementRemote`, the scoped factory, and `expose` unchanged.
- [x] **ADR 0036** + index row — records both halves, including the reasoning for
      *not* cascading `expose` so it is not re-proposed.
- [x] `docs/guide/contracts.md` (the cascade + shallow-merge rule),
      `docs/guide/mcp-and-agents.md` (the fail-open `expose` default and the
      `listToolNames` snapshot as its guard), `docs/api/reference.md`,
      `CHANGELOG.md` under `[Unreleased]`.
- [x] **Rejected and recorded, not silently dropped:** the `expose` cascade
      (does not close the hole, opens a new silent vector, needs five more edit
      sites) and flipping the default to `['HTTP']` (breaks silently, supersedes
      ADR 0016). Both in ADR 0036 → `Alternatives considered`.

**Gate:** `bun run verify` exit 0 — **641 pass / 0 fail**, build + Node smoke green.
