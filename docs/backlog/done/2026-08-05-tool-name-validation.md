---
title: "Derived tool names are never validated — an illegal name ships and fails at the first model call"
description: toToolName normalises only the hyphen, so any other character rides into the advertised tool name; nothing in stitchkit, the MCP SDK or the ai SDK ever checks the string, so the failure lands provider-side and takes the whole tool list with it.
type: task
status: done
created: 2026-08-05
updated: 2026-08-05
completed: 2026-08-05 12:40 +07:00
---

# Tool names: normalise the whole character class, then assert at mount

Reported by a consuming project migrating 149 tools. Every claim below verified
against v0.25.0 source by two independent plan validators.

## Facts

- `toToolName` (`tools/names.ts:19`) does `serviceName.replace(/-/g, '_')` — **only
  the hyphen**. Probed: `toToolName('admin/analytics','overview')` →
  `overview_admin/analytic`.
- **Nothing validates a tool name anywhere.** `@modelcontextprotocol/sdk@1.29`
  `registerTool` checks only for a duplicate (`server/mcp.js:699-704`) and its wire
  `name` is a bare `z.string()`; `ai@7` has no name regex at all; stitchkit assigns
  the name (`mount.ts:103`) and never inspects it. So the failure is provider-side
  — and it is **not scoped to the bad tool**: the request carrying the tool list is
  rejected, so *every* tool from that mount goes dark. (The charset
  `^[a-zA-Z0-9_-]{1,64}$` is the providers' rule, stated as such — it is not
  verifiable from this repo.)
- `defineContract` (`contract/define.ts:147-186`) checks placement and uniqueness of
  an **explicit** `toolName`, never the string, never a derived name.
- `singularize` runs on the whole normalised name (`names.ts:20`), so
  `SINGULAR_EXCEPTIONS` only matches a bare service name: `admin/analytics` →
  `admin/analytic`, and `bot-status` → `get_bot_statu`.
- This repo's **own fixtures** already derive illegal names today —
  `tool-extensions.test.ts` (`prefix: '/test'`, `'/items'`) and `node.test.ts`
  (`'/api'`) produce `do_thing_/test`, `list_/items`, `create_/item`. They pass only
  because the assertions are `toBeTruthy()` / `.includes('create')`.

## Decision: normalise the class, assert at the mounts, hard-throw

**Rejected — widening the replace to `[-/]`** (the reporter's proposal): fixes one
symbol, leaves the class. **Rejected — normalise without validating**: an explicit
`toolName` still ships illegal, and a name that normalises to nothing ships as
`get_`.

**Throw, not an `onIncompatibleSchema`-style policy knob.** The repo already splits
these cleanly: *representability* defects get a policy (`'throw' | 'warn' | 'skip'`,
`mcp.ts:203`) because an endpoint can be valid on HTTP while its schema is not
expressible as JSON Schema; *identity* defects always throw (duplicate tool name
`mcp.ts:139`, `agent.ts:59`, `cli.ts:318`; extend conflict `mount.ts:63`; the three
`define.ts` checks). A name outside the provider charset is an identity defect. And
of the three policy values only `skip` would even be coherent — `'warn'` would
register the illegal name anyway and poison the entire tool list, which is strictly
worse than not mounting it.

## Corrections folded in from plan validation

1. **Drop the leading-digit claim.** `get_2fa` is legal under the providers' regex,
   and a derived name is always verb-prefixed so it can never start with a digit.
   Test it as *legal*, not as a rejection.
2. **Normalise both halves.** The method key is a `Record<string, …>` key and
   `define.ts:163` itself notes a runtime-built contract bypasses the type — so
   `user.profile` as a key yields `user.profile_user`. Normalising the service alone
   would leave the plan's own "nothing illegal can be derived" claim false. Same
   rule, both halves; for a normal identifier key it is a no-op.
3. **No run-collapsing, no trimming.** Applying them to the whole string renames
   names that are legal today (`get__internal` → `get_internal`, `list_a__b` →
   `list_a_b`, `get_foo_` → `get_foo`) for pure cosmetics. Dropping collapse/trim
   removes an entire breaking class at no cost. Only illegal characters are touched.
4. **An empty normalisation must throw.** `'///'` and a fully non-ASCII prefix
   normalise to separators only, and `get_` / `list_` **passes** the charset regex —
   so the assertion as originally specified would ship a degenerate name that also
   collides across every such service. Require at least one `[a-zA-Z0-9]` in the
   normalised service segment.
5. **Assert in the mounts, not inside `collectTools`.** `listToolNames` calls
   `collectTools` (`list-names.ts:41`) and is *the documented migration diagnostic*
   (`docs/guide/mcp-and-agents.md`) — a consumer holding one illegal name must still
   be able to run the tool that shows them which one. Implement as an opt-out on
   `collectTools` (assert by default), with the read-only listers passing `false`.
6. **Drop the new collision check.** All three mounts already dedupe derived names
   across every service in the mount (`mcp.ts:139`, `agent.ts:59`, `cli.ts:318`) —
   probed, they throw with a usable message. `collectTools` is per-service and
   could not see a cross-service collision anyway. Keep only a regression test that
   the existing guards fire on newly-merged names.
7. **`validateMcpSchemas` walks `'MCP'` only** (`mcp.ts:234`), so an AGENT-only or
   CLI-only endpoint with a bad name is invisible to the build probe. Either state
   that limit or widen the probe. Decision: state it, and cover AGENT/CLI with their
   own mount-time tests — widening the probe's transport set is a separate change.
8. **`implementRemote`** (`remote.ts:60-66`) is a second name producer over someone
   else's contract — the likeliest source of an illegal prefix from outside the
   author's control. It inherits the check through `collectTools`; note it in the
   CHANGELOG.

## Breaking-change accounting (two classes, both must be listed)

- **Illegal names now throw at mount.** Nothing that worked stops working — such a
  tool was rejected provider-side — but a build that mounted yesterday can fail
  today. This repo's own `/test` / `/items` / `/api` fixtures are in this class.
- **Renames from `singularize`-on-last-segment.** All legal today, all currently
  wrong: `get_user_setting` → `get_user_settings`, `get_bot_statu` → `get_bot_status`,
  `get_chat_analytic` → `get_chat_analytics`, `get_site_new` → `get_site_news`. An
  MCP host config or agent prompt pinned to the old name breaks. The migration
  recipe is `listToolNames` before/after — which exists precisely for this
  (`list-names.ts:1-11`) and must be named in `upgrading.md`.

## Plan

- [x] `tools/names.ts` — normalise `[^a-zA-Z0-9_]` → `_` on **both** halves, no
      collapse/trim; `singularize` applied to the last `_` segment.
- [x] `tools/names.ts` — internal `assertToolName(name, service, method)`:
      charset + length + "normalised service segment is not empty", throwing with
      the endpoint identity and, on over-length, pointing at an explicit `toolName`
      as the only remedy. **Module-internal** — exporting it from `stitchkit/tools`
      would require a `docs/api/reference.md` row (`reference-coverage.test.ts`).
- [x] `tools/mount.ts` — assert in `collectTools` behind an opt-out; the read-only
      listers (`list-names.ts`, and `manifest.ts` if it collects) opt out.
- [x] Tests: slash / dot / space / unicode-only / empty-after-normalisation /
      >64 chars / illegal explicit `toolName`; leading digit is **legal**;
      `admin/analytics` → `overview_admin_analytics`; `SINGULAR_EXCEPTIONS` honoured
      behind a prefix; `get__internal` and `list_a__b` unchanged; `listToolNames`
      still reports an illegal name instead of throwing; the existing duplicate
      guards fire on merged names; a bad name fails `validateMcpSchemas`,
      `mountAgent` and `createCli`.
- [x] **ADR 0035** + row in `docs/decisions/README.md` — the derivation rule and the
      identity-throws-vs-representability-policy line.
- [x] Docs: `docs/guide/contracts.md` (the `toolName` section — and its stale
      "defaults to `prefix_key`"), `docs/guide/mcp-and-agents.md` (derivation),
      `docs/guide/upgrading.md` (both breaking classes + the `listToolNames` diff
      recipe), `skills/stitchkit/SKILL.md` (one line: `prefix` and `toolName` are
      `[a-zA-Z0-9_-]`, ≤64 after derivation — the cheapest prevention here).
      `llms.txt` regenerates from these.
- [x] `CHANGELOG.md` — `### ⚠️ Breaking changes` with both classes.

## Acceptance

- [x] `toToolName('admin/analytics','overview')` is provider-legal.
- [x] An illegal explicit or derived name throws at every mount, naming the endpoint.
- [x] A name that normalises to separators only throws rather than shipping `get_`.
- [x] `listToolNames` still lists an illegal name (diagnostic survives).
- [x] Names legal today are byte-identical **except** the documented singularize
      class.

## Process (конвейер 2/2)

- [x] 2 plan validators — findings folded in above
- [x] Implementation
- [x] `bun run verify` green
- [x] 2 implementation validators
- [x] "Что сделано" + `done/`

## Правки валидатора реализации-1 (mandate)

- **WRONG → fixed.** Three doc files claimed characters outside `[a-zA-Z0-9_-]`
  are normalised — but the hyphen is *inside* that class and **is** normalised in
  the service half. A reader would expect `get_bot-status`. The accepted class and
  the derivation class are different sets; `contracts.md`, `mcp-and-agents.md` and
  `SKILL.md` now say so explicitly.
- **MISSING → fixed.** `summarizeTransports` is a second read-only lister and did
  not opt out, so a boot summary died on a bad name — before the consumer could
  reach the `listToolNames` diagnostic the upgrade guide points at.
- **Undocumented breaking sub-case → recorded.** `'_'` / `''` prefixes derive
  `get__` / `get_`, which are provider-**legal** and now throw. The only place a
  working name stops working; named in the CHANGELOG and ADR.
- **NIT → fixed.** `'///'` derives `get____`, not `get_` (only an empty prefix
  gives literally `get_`). Example corrected everywhere it appeared.
- Confirmed correct: explicit `toolName` rescues an unusable prefix (the prefix
  never enters the name); `implementRemote` inherits; error messages name the
  endpoint; no casts; helper stays module-internal so `reference-coverage` passes.

## Правки валидатора реализации-2 (adversarial)

Brute-forced 78 652 charset-safe prefix combinations and 88 088 (prefix × method)
pairs against the pre-change derivation. Four blockers, all fixed:

1. **Undocumented rename of legal names via the method half.** `-` is inside the
   accepted charset, so `get-user_note` shipped and worked; normalising the method
   key with the service rule renamed it to `get_user_note` — 5 972 such renames in
   the corpus, in the very commit that promises not to do that silently. Fixed by
   splitting the rule: the service half keeps its historical `-` → `_`, the method
   half normalises only `[^a-zA-Z0-9_-]`. The prefix half was verified sound —
   the only divergences are the documented singularize class.
2. **`summarizeTransports` threw** (same finding as validator-1). Fixed.
3. **The CLI was held to a provider rule it has no provider for.** A
   `expose: ['CLI']` contract with prefix `поиск` mounted yesterday and refused to
   start today, and the CHANGELOG's "nothing that worked stops working" was false
   while that held. The assertion now skips `'CLI'`.
4. **ADR's load-bearing premise was factually wrong.** `@modelcontextprotocol/sdk@1.29`
   *does* validate (SEP-986 `validateAndWarnToolName`) — warn-only, against
   `[A-Za-z0-9._-]{1,128}`, so dots are legal and the limit is 128. The decision
   survives (warn-only does not stop anything) but the reasoning was rewritten, and
   the ADR now states plainly that stitchkit is *stricter than MCP on purpose* —
   64 and no dot is OpenAI's rule, the tightest surface.
- **WEAK-TEST ×4 → the load-bearing one fixed.** The validator restored the
  pre-change sources and ran the new suite: 4 of 21 passed without the fix. The
  serious one was the "byte-identical" test — it varied only the prefix and
  hard-coded `get`/`list` as the method, so it could not fail on the one way the
  change broke byte-identity. A hyphenated-method-key case was added, which fails
  against the old code and *is* finding 1.
- **Native tools → covered.** `mountWait` / `mountDownload` / `mountUpload` passed
  their names straight to `registerTool`. They share the `tools/list` with contract
  tools, so the ADR's own argument applies to them; they now assert too.
- Confirmed no-bug: `hasUsableChars` simplified (normalisation can neither create
  nor destroy an alphanumeric); the explicit-`toolName` skip is correct; regex
  anchors admit no trailing newline; cross-service collisions still caught by the
  pre-existing dedupe.

## Что сделано

- [x] `tools/names.ts` — per-half normalisation (`normalizeService` /
      `normalizeMethod`), `singularizeTail`, `assertToolName`, `hasUsableChars`.
- [x] `tools/mount.ts` — assertion in `collectTools` behind `assertNames`
      (default on), skipped for `'CLI'`, plus the unusable-prefix guard.
- [x] `tools/list-names.ts`, `tools/transports.ts` — read-only listers opt out.
- [x] `tools/mount-{wait,download,upload}.ts` — native names asserted.
- [x] `tests/tool-name-validation.test.ts` — 24 tests: normalisation matrix,
      hyphenated method key, byte-identity, singularize renames, mount-time throws
      (MCP / agent / build probe), unusable prefix, over-length, read-only
      diagnostics, CLI exemption, collision regression.
- [x] **ADR 0035** + index row; `contracts.md`, `mcp-and-agents.md`,
      `upgrading.md` (the `listToolNames` diff recipe), `SKILL.md`, `CHANGELOG.md`
      with `### ⚠️ Breaking changes`.
- [x] Out of scope, recorded in the ADR: `nativeTools?.(server)` (consumer code);
      `validateMcpSchemas` walking MCP only; partial registration when several
      services are mounted in one call (pre-existing).

**Gate:** `bun run verify` exit 0 — **626 pass / 0 fail** (was 602), build + Node
smoke green.
