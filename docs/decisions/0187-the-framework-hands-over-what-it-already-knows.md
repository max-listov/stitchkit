---
title: "ADR 0187: The framework hands over what it already knows"
description: "Five consumer requests turned out to be one defect: a fact the framework computes and does not publish, so every consumer derives it again from text, from a code name, or from the presence of a key — and derives it differently."
type: decision
status: accepted
created: 2026-09-22
updated: 2026-09-22
---

# ADR 0187 — The framework hands over what it already knows

## Context

Five separate requests arrived from one consumer in one evening. They named
different files and read as a wish list. They are one defect.

In each, the framework **already has** the fact. It does not publish it, so the
consumer reconstructs it — and the reconstruction is written once per consumer,
disagrees silently, and is discovered late:

- **The outcome of a tool call.** `runToolMethod` finishes every call through one
  exit that knows `{ok, code}`. The agent surface hands the consumer a
  serialized envelope, so "did this call fail" was re-derived from text. The
  consumer measured five places asking that question and getting five answers:
  four successful calls recorded as failures — the word `error` appeared inside
  a tool *description* in search results — and thirteen real failures recorded
  as successes.
- **Whether a refusal is worth repeating.** The status class distinguishes a
  rate limit from a permission failure without any heuristic. The model got the
  code name and guessed from the spelling, so a circuit breaker existed to cut
  the loop after four identical unrecoverable retries.
- **What the caller actually sent.** `beforeToolCall` is handed the raw
  arguments at the one point where they can still be shaped, and its return
  value was discarded — while `lifecycle.afterHandle` could already transform
  the output. The consumer closed a feature rather than introduce a second,
  divergent way to pass an argument.
- **That a tool body may be restartable.** `mountAgent` puts `step` / `sleep` /
  `waitFor` into a handler context, and only `agent-runtime` could supply them.
  A capability designed for mounted tools was reachable only by adopting a
  different product whole.
- **That an endpoint has no handler.** The registry knows exactly which
  endpoints are unimplemented and answers by refusing to start the whole
  application — correct in production, and on a watched dev stand it means the
  stand is down between two saves of one feature, for everyone on it.

## Decision

Publish the fact, at the seam that already exists, and refuse the shapes that
would create a second one.

1. **`beforeToolCall` may return replacement arguments.** They are validated by
   the contract schema like any other input, so this shapes a call and never
   bypasses the schema. `afterToolCall` reports the caller's arguments as `args`
   and the replacement separately as `effectiveArgs`: a rewrite is visible as a
   rewrite rather than by overwriting the evidence.
2. **The tool refusal carries `retryable`,** derived from the status of the
   normalized error — not from a lookup in `STITCH_ERROR_STATUS`, which knows
   only the framework's own codes and would report an application's declared
   `429` unrecoverable. `ErrorDefinition` may declare it where the status class
   is wrong in either direction, and the declaration travels on the failure so
   it survives the process hop that rebuilds the error from `{code, details,
   hint}`.
3. **`toolCallId` travels as ordinary call context,** so the outcome a consumer
   already receives through `afterToolCall` can be correlated with the call the
   model made. `AgentToolError` and `isAgentToolError` become public, so a
   consumer running its own loop brand-checks instead of parsing a message.
4. **The tools layer declares a durability port** (`ToolDurability`) and
   `mountAgent` accepts a factory for it — and **the engine ships beside the
   port**. `createLocalStepDurability` is exported from `stitchkit/tools`: its
   runtime closure is itself and zod, the ledger it needs is two methods over
   the application's own storage, and it holds no agent store, no run protocol
   and no model. That is every condition ADR 0142 sets for a primitive that
   leaves `agent-runtime`, met. An application supplies the two methods and
   gets replay, absolute deadlines, park/deliver and decode refusal; one with
   its own ledger engine implements the port directly. A build check holds the
   line that matters: the runtime proper — store, run protocol, runtime factory
   — never enters the `stitchkit/tools` chunk graph.
5. **`onMissingHandler: 'stub'`** mounts a `501` refusal instead of refusing to
   start, threaded through every binding form, covering both save orders.
   `'throw'` remains the default and the only production answer.

## What was refused, and why

**A dedicated `onToolOutcome` callback.** It was the consumer's preferred shape.
`afterToolCall` already receives the whole `ToolResult` on every exit and on all
three transports; a second callback beside it would be two ways to observe one
event, and it would serve `mountAgent` only while the same gap exists on MCP.
The missing piece was correlation, and correlation cost three lines.

**Exporting `createToolDurabilityContext` as the answer.** The request named
it, and the premise was wrong in a way worth recording: it is exported from *no*
entrypoint today — the consumer read it from a deep `dist` path — so this was
never relocating an export. It is also the wrong seam: it is the opaque
SDK-context trick `agent-runtime` uses to smuggle durability past the AI SDK,
and an application driving its own loop has a plainer door, `mountAgent`'s own
config. What the request was *for* — the engine — is what ships, from the
entrypoint the consumer already imports.

A first draft of this ADR refused the engine on the ground that its parameter
was "a type only the agent store constructs". That was false: the engine is
self-contained, and a validator reading the code caught it before release. The
false reason is recorded here rather than deleted, because an ADR that only
ever shows the right answer teaches nothing about how the wrong one looked.

**Renaming `_hint` to `hint`.** The request asked for it, and for both names to
be served for a while; this repository forbids aliases, and ADR 0077 had already
recorded that changing the envelope's shape is a separate decision. The argument
that settled it is not style: the envelope is **stored**, not merely
transmitted. A failed agent tool's envelope becomes a durable message part, so a
rename splits stored conversation history into two shapes with no migration, and
the break is invisible to every compiler because the envelope is typed
`Record<string, unknown>`. It stays `_hint`.

## Consequences

- `NOT_IMPLEMENTED` (501) joins `STITCH_ERROR_STATUS`. This is a breaking change
  by this repository's own precedent, and it was chosen deliberately over the
  alternative: the framework must not throw a code its own registry does not
  know, or the code travels in stitchkit's spelling past every consumer's
  `codeMap`. A gate holds that invariant mechanically and refused the quieter
  option.
- A declared option that no gate enumerates is a promise held by review. The
  tool mounts are not in `option-effects.test.ts`, so each option added here is
  pinned by a test that fails when the option stops being honoured, and each of
  those tests was falsified by mutation before it was trusted.
- `stitchkit/tools` carries the durability engine and must stay free of the
  runtime proper, and no source-level test can hold that — `import type` erases,
  so an import test is green either way. A build check scans the real chunk
  graph for the runtime's own names instead.
