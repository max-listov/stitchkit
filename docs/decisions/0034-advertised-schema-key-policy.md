---
title: "ADR 0034 — The advertised tool schema carries each object's key policy"
type: decision
status: superseded
created: 2026-08-03
updated: 2026-08-03
---

# ADR 0034 — The advertised tool schema carries each object's key policy

- **Status:** Superseded by [ADR 0050](0050-executable-tool-surface-conformance.md)
  — its executable-advertised-schema premise no longer holds. Originally accepted,
  superseding the "advertised-only" premise of
  [ADR 0031](0031-deep-union-flatten.md) and [ADR 0033](0033-sound-flatten-collisions.md)
  (specifically 0033's *Alternatives → hard-reject `.strict()` variants* and the
  `.strict()`/`catchall` line of its *Known residual*).
- **Date:** 2026-08-03

## Context

ADR 0031 and 0033 both rest on one sentence: the flattened schema is
**advertised-only**, "the original schemas stay the validation schemas", so
dropping `.strict()` from the advertised hint is *invariant-safe (looser)*.

**That premise is false, and it costs data.** Both transport SDKs parse the
caller's arguments with the advertised schema and hand the tool callback the
**parsed result**:

- MCP — `McpServer.validateToolInput()` does `safeParseAsync(tool.inputSchema, …)`
  and returns `parseResult.data`, which is what reaches `executeToolHandler`
  (`@modelcontextprotocol/sdk` 1.29). `normalizeObjectSchema` passes a real
  `ZodObject` through untouched, so whatever policy stitchkit sets is the policy
  that runs.
- Agent — `zodSchema(...).validate` returns `result.data`, and `doParseToolCall`
  sets `input: parseResult.value` (`ai` 7).

A bare `z.object()` does not merely advertise loosely — **it deletes** every key
its shape does not declare. So each object stitchkit rebuilt while deriving the
advertised schema (the deep flatten walk, the params+input merge, the extend
fold) silently removed keys before the contract schema could object. A consuming
project hit exactly this: a `.strict()` object inside a discriminated-union
variant rejects an unknown key when parsed directly, but the same call over MCP
**succeeded** with the key gone — the model was told its wrong argument was fine.

The behaviour was path-dependent, which is why it survived so long: a key present
in ≥2 variants is widened to `z.unknown()` by 0033's collision rule, and
`z.unknown()` deletes nothing — so the *same tool* reported an honest error on one
field and silently swallowed the next. The "working" field worked by accident.

No test caught it: the repo's strictness tests (`parity.test.ts`,
`execute.test.ts`) call `executeToolMethod` directly and never cross the SDK's
parse step, which is where the whole defect lived.

## Decision

1. **Every object rebuilt for the advertised schema carries its source's key
   policy.** One helper in `tools/schema.ts` — `rebuildObject`, which copies
   `def.catchall` from a single source object — serves the three rebuild sites
   that *have* a single source: the flatten walk's `ZodObject` branch,
   `mergeSchemas`, `applyExtend`. The fourth site,
   `flattenDiscriminatedUnion`'s flat object, has no single source (it replaces
   every variant at once), so it applies a **merged** policy through the same
   underlying `withKeyPolicy` — see point 2. A plain source needs no special
   case: the rebuilt object strips exactly as the contract object would.
2. **A union's flat object merges the variants' policies.** It stands in for all
   of them and cannot tell which one the caller meant, so it takes the policy that
   cannot **destroy the evidence** the real union needs:
   - every variant strict → **strict**. Sound, because the flat shape is the union
     of all variant keys, so it only rejects a key no variant declares.
   - no variant strict → **plain**. Strips exactly as every variant would.
   - **mixed** (a strict variant beside a plain one), or any variant that keeps
     unknown keys (`.loose()`, `.catchall(T)`) → **loose**. Plain here would delete
     the very key the strict sibling exists to reject — the original bug, one
     ordinary variant away. Forward it and let the union judge.

   A *typed* catchall is widened, never copied — copying it would reject a sibling
   variant's differently-typed extra key.
3. **A variant's `.default()` is unwrapped, like its `.optional()`.** Every field
   of the flat object is advertised optional, so a surviving default materialises
   on *every* call — injecting a non-matching variant's field into the payload,
   which the real union then rejects as an unrecognized key. That turned a legal
   call into a hard `VALIDATION_ERROR` in exactly the all-strict configuration
   this ADR recommends. (Pre-existing since ADR 0031; fixed here because this ADR
   is what makes all-strict unions the sound choice.)
4. **`mergeSchemas` takes the input schema's policy, never the params one.**
   `executeToolMethod` slices flat args by the params shape's keys and routes
   everything else into the input slice, so a params catchall can never fire while
   an undeclared top-level key is judged by the input schema.
5. **A policy JSON Schema cannot represent degrades to `z.unknown()`** rather than
   being copied or dropped. Copying `.catchall(z.date())` would fail the mount's
   JSON Schema probe and, under the default `onIncompatibleSchema: 'throw'`, take
   every tool down; dropping it would silently delete data. Loose keeps the
   invariant and stays representable.

**Invariant (replaces 0033's "looser is safe"):** *the advertised schema never
removes what the contract schema would have kept, and never accepts what it would
have rejected by deletion.* Note the deliberately narrow wording — the contract
schema is **not** "the only judge": a rejection may legitimately come from either
channel (see Consequences).

## Alternatives considered

- **Advertise every object as loose** (`z.looseObject` everywhere) so nothing is
  ever stripped and every rejection lands as stitchkit's `VALIDATION_ERROR` with
  hooks and hints. Rejected — it emits `additionalProperties: true` on every
  object, which *invites* a model to invent keys. The reporting consumer wants the
  opposite: the schema should say up front that extra keys are not allowed.
- **Leave it and document the limit.** Rejected — silent data loss is the one
  failure mode an LLM caller cannot recover from: it gets a success and never
  learns its argument was wrong.

## Consequences

- **Breaking (0.25.0).** A call that was previously accepted with a key silently
  removed now fails. Ships behind a minor bump.
- **Rejection moves channel for strict violations.** The SDK now rejects before the
  tool callback runs. `callTool` still **resolves** — it does not throw — but with
  an `isError: true` result whose text is the SDK's own
  `MCP error -32602: Input validation error: … Unrecognized key: "…"`, instead of
  stitchkit's `{ error, details, _hint }` envelope (agent: an `invalid: true` tool
  call). `beforeToolCall` / `afterToolCall` **do not fire** for it — verified —
  so those calls move from "logged as a success" to "not logged at all". Accepted:
  both channels reject, which is the property that matters; the mixed channel is a
  residue of the SDKs owning the parse.
- **A filtered `ToolExtend` can now reject cross-tool.** With `extend.filter`, the
  extra key is advertised on some tools and not others; a model that learned
  `tenantId` from tool A and sends it to a strict, non-extended tool B was
  sanitized before and is rejected now. Correct, but it is the most likely
  "worked yesterday" surprise in a real consumer.
- **Advertised JSON Schema changes** for strict/loose contract objects
  (`additionalProperties: false` / `{}`) on the MCP surface and in
  `buildToolManifest`. The agent surface is unaffected in advertisement — `ai`
  forces `additionalProperties: false` onto every object regardless — so the
  policy shows up there only in what validation does. OpenAPI is untouched (it
  converts contract schemas directly, never the merged one).
- **Still lossy, by construction:** per-variant strictness (a key legal in variant
  A and illegal in B) cannot be expressed in one flat object, and object-level
  refinements are not advertised. Both remain enforced by the original schemas in
  `executeToolMethod`.
- **Not covered — `z.intersection`.** Zod v4 drops both sides' catchall when it
  intersects objects (verified: a strict side alone rejects, the intersection
  accepts and strips), so `mergeSchemas`' params + non-object-input branch and
  `applyExtend`'s non-object branch still strip. MCP is protected (a non-object
  merged schema is rejected at mount), the agent and CLI surfaces are not. Tracked
  as its own task — it needs a different instrument than a catchall copy.
