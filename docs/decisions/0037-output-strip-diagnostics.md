---
title: "ADR 0037 — The output strip stays, and becomes visible on demand"
type: decision
status: accepted
created: 2026-08-05
updated: 2026-08-05
---

# ADR 0037 — Make the output strip visible, do not change it

- **Status:** Accepted — extends [ADR 0014](0014-tool-http-parity.md).
- **Date:** 2026-08-05

## Context

`validateHandlerOutput` returns `parsed.data`, so a handler returning more than
its `output` schema declares has the extra fields **deleted**. A consuming project
migrating a live API found 153 of its 183 endpoints in that state.

The behaviour is **correct**: the contract is the published shape of the response,
and a handler leaking internal fields is the bug. The problem is that it is
*invisible* — TypeScript cannot catch it (structural typing does not reject excess
properties on a value that is not an object literal), nothing logs it, and the
client simply receives fewer fields than before the migration.

This is the output-side sibling of [ADR 0034](0034-advertised-schema-key-policy.md),
with the sign flipped: there the framework deleted data it had no right to delete;
here it deletes data it *should*, but says nothing.

## Decision

**Keep the strip. Add an opt-in diagnostic.**

- `createServer` / `createHandler` gain `warnOnOutputStrip?: boolean` (default
  off). When on, every key present before validation and absent after it is
  reported through the configured logger as a dot-path, prefixed with the endpoint
  identity (`serviceName.key`) — a path alone is not actionable without knowing
  which handler produced it.
- The tool mounts get the same via `onOutputStrip?: (toolName, paths) => void` on
  `mountMcp` / `mountAgent` / `createToolRunner`. They strip identically, so a
  diagnostic that only covered HTTP would send a migrating consumer hunting.
- **The diff runs only when a reporter is attached.** With the flag off there is
  no walk and no cost on the response path.
- **Deep, not top-level.** A field trimmed three levels down is exactly what a
  top-level comparison misses. Arrays are walked by index (`rows[0].b`).

## Alternatives considered

- **Warn by default.** Rejected — a key comparison on every response, and a
  permanent log line for consumers whose handlers legitimately return internal
  fields they never meant to publish. Noise becomes the default for correct
  behaviour.
- **A strict mode that fails on extra keys.** Rejected — that turns a cosmetic
  leak into a 500 on a working endpoint. The output contract is a *publication*
  boundary, not a validation boundary; failing there punishes the wrong side.
- **Documentation only.** Rejected as sufficient, kept as necessary: the
  `upgrading.md` paragraph ships regardless, because a consumer who never reads
  about the flag still needs to know the behaviour exists.

## Consequences

- **Additive.** No default changes; a consumer that sets nothing sees byte-identical
  behaviour and cost.
- **The flag is for a bounded window.** Turn it on while migrating, read the list,
  fix or widen the contracts, turn it off. It is not meant to run in production
  forever, and the docs say so.
- **A `.loose()` / `.catchall()` output reports nothing**, because nothing is
  removed — consistent with ADR 0034's key policy on the input side.
- **Not covered:** a field that a `.transform()` rewrites rather than removes. The
  diff compares presence, not value, so a transformed field is not "stripped" and
  is not reported. Stated rather than solved — reporting value changes would fire
  on every legitimate coercion.
