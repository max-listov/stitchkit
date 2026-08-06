---
title: "Parallel tool calls share one request context — the audit rows swap identities"
description: executeToolMethod opens no per-call scope, so two tool calls in one agent step write into the same AsyncLocalStorage store and the last setRequestDimensions wins for both rows.
type: task
status: done
created: 2026-08-06
updated: 2026-08-06
completed: 2026-08-06 18:20 +07:00
related: docs/decisions/0029-audit-endpoint-identity-and-dimensions.md
---

# Parallel tool calls share one request context

## Reported from production, reproduced here

A consuming project found two `broadcast_delete` audit rows from one agent step
carrying the **same** `entityId` while their argument previews differed. Not a
hypothesis on their side, and not one here either — reproduced against this repo
in a dozen lines, through the real `mountAgent` and the real `createAuditHook`:

```
broadcast_delete | payload: {"id":"A"} | dimensions: {"entityId":"B"}
broadcast_delete | payload: {"id":"B"} | dimensions: {"entityId":"B"}
```

Call A's row says it acted on B. The audit trail is not merely incomplete, it is
**wrong**, and nothing anywhere reports a problem.

## Root

`executeToolMethod` opens **no scope of its own**. Everything it calls —
`lifecycle.beforeHandle`, the handler, the hooks — runs inside whatever
`AsyncLocalStorage` store the caller was in, which for MCP-over-HTTP is the one
store for the whole request.

The AI SDK executes a step's tool calls with `Promise.all`. So `beforeHandle(A)`
writes `entityId: A` into the shared store, `beforeHandle(B)` overwrites it with
`B`, and both rows read whatever was last written when they finish
(`audit.ts:155`, `requestCtx?.dimensions`).

This is not specific to `dimensions`. Every late-bound field on the context has
the same shape: `setRequestUser`, `setRequestError`, `setRequestEndpoint`. A tool
that resolves a different user, or records a different failure, corrupts its
sibling's row the same way.

It is also not specific to the AI SDK — anything that runs two tool calls
concurrently in one request hits it, including a project that fans out itself.

## The fix, and the choice inside it

**Recommended: `executeToolMethod` runs each call in its own context**, forked
from the ambient one. `runWithRequestContext` already exists
(`observability/context.ts:56`) and `node:async_hooks` is permitted in core by
ADR 0013, so this is a wrap, not new machinery:

- a **copy** of the parent context, so the trace/span, source, timing and client
  info still describe the enclosing request and the tool span stays a child of it
  (`audit.ts:130` already builds a child span);
- with its **own** `dimensions` / `userId` / `error`, so nothing a call records
  can reach a sibling — or the enclosing request's row.

Two things this changes that must be decided, not discovered:

1. **Writes stop propagating outward — and for a single-call request that is a
   real loss, not only a tidy-up.** The reporter's baseline (below) shows a plain
   MCP call with no agent loop putting its `entityId` on the enclosing request's
   row today, and calls that *correct*: one request, one tool, the entity is the
   request's. After the fork it stops.

   The information is not destroyed — it is on the tool row, joinable by the
   shared `traceId`. So the honest framing is not "nothing is lost" but "the
   field moves to the row that owns it, and a join is now required where a direct
   read used to work". Decide it in that form; a consumer who reads only the
   request row will see a regression and deserves the CHANGELOG to say so.
2. **A tool call with no ambient context.** On stdio MCP there is no request
   store at all, so `setRequestDimensions` is a no-op today. Forking would give
   every call a context and make those helpers start working there. Probably
   wanted; definitely a change.

**The narrower alternative** — pass dimensions explicitly on the tool event
instead of reading the context — fixes the reported symptom and leaves
`setRequestUser` / `setRequestError` corrupting each other. Worth naming only to
reject: it treats the one field that was noticed rather than the shape that
produced it.

## Acceptance

- [x] Two concurrent tool calls in one request produce rows whose `dimensions`
      belong to their own call — asserted with the reproduction above.

      **Corrected during validation:** the criterion originally named `userId`
      and `errorDetail` too. Neither was ever swappable *on a tool row* — that
      row reads `userId` from the `ToolCallContext` and the error fields from the
      `ToolResult`, never from the request context. Only `dimensions` came from
      the ALS. The criterion was written against a model of `audit.ts` that was
      not accurate; what those two fields actually suffered was the outward leak,
      which the fork also closes.
- [x] The tool span is still a child of the request's trace, and `traceId` still
      correlates a tool row with the HTTP row it ran under
- [x] A call that records nothing still inherits the request's identity fields
      (a fork must not blank what the request already knew)
- [x] Sequential calls behave exactly as before — pinned, since this touches
      every tool call there is
- [x] Decided and documented: writes no longer propagate outward; a stdio call
      gains a context
- [x] ADR — this changes what a context *is* on the tool path, and ADR 0029's
      `dimensions` contract is written against the request scope
- [x] `CHANGELOG.md` — behaviour change, likely breaking for anyone whose tool
      handler wrote identity outward on purpose

## Not part of this

The reporter's second item — a tool error arriving as a **string** on the
streaming path, so `InvalidToolInputError.isInstance` cannot classify it — is not
ours. `getErrorMessage` does not exist anywhere in this package
(`grep -rn getErrorMessage packages/core/src` → nothing); the stringification is
the AI SDK's on its stream. Worth telling them where to look rather than
absorbing it. Confirmed by the reporter at `ai/dist/index.js:8559`; they classify
on the `tool-call` chunk instead, where the error is still an object, and that
works.

## Verification offered by the reporter

They will run both paths (agent loop and HTTP) on their own deployment once the
implementation exists. Take it **before** the release: their traffic is the only
place the concurrent case occurs naturally, and a fact from there beats another
probe from here.

**They have the nested case, which is the one worth measuring.** Their agent loop
opens its own `runWithRequestContext` at its single entry point, so an outer MCP
request and an inner loop context are alive at the same time in their deployment.
That is precisely the shape question the fork has to answer — what a tool call
inherits when there are two candidate parents — and it exists there naturally
instead of being staged here. Ask for that path specifically, not just the
concurrent one.

(A caution recorded here earlier — that their `clientId` was safe only by
accident of traffic — was wrong, and they disproved it with the entry point
above. Two loops in one request cannot share a context in their design. The
general rule they adopted, that a per-call field comes from the call's arguments
rather than the context, stands on its own and they keep it.)

## Baseline from the reporter's production, taken BEFORE the fix

Their nested case: an `agent_send` MCP request → an agent loop → four tool calls
(two `create`, two `updatePartial`, in concurrent pairs).

1. **One `traceId` across everything** — the outer HTTP row, the loop's own audit
   row, and all four tool rows carry `0910ff00b7245f8e30b5503f0d965061`. Spans
   differ, and all four tools share one `parentSpanId` (the loop's span), so the
   hierarchy request → loop → tools already reads correctly.
2. **The tool calls see the loop's `dimensions`**, not the request's. Both
   contexts wrote; no conflict was observable because the values coincide (same
   project, same bot).
3. **No outward leak in their deployment already** — the outer request's row
   carries only its own dimensions, without the `entityId` the tools set, because
   the loop runs in its own context. A plain MCP call *without* an agent does put
   its `entityId` on the request row.

**The constraint this puts on the fix, in their words:** if a tool row's
`traceId` stops matching the outer request's, that is a loss — the chain is
stitched by exactly that field. So the fork copies `trace` verbatim; minting a
fresh trace per call is not an option where a parent exists.

They hold the numbers and will re-run the same scenario on request and send a
diff.

## The tempting alternative, rejected before someone proposes it

Most MCP requests carry exactly one tool call, and for those the outward write is
not a leak at all — the entity really is the request's. So the obvious idea is to
keep propagating outward **when there is only one call**, and isolate only when
there are several.

Rejected. Cardinality is not known when the write happens, so it would have to be
inferred — merge on completion if no sibling was ever active, or count children
per parent. Both make the same code behave differently under concurrency, which
is precisely the property that produced this defect: a row that is correct while
traffic is thin and wrong when it is not, with nothing to distinguish the two.
A rule that holds regardless of load is worth more than a field that saves a
join in the common case.

The reporter sharpened this, and his form is the one to keep: the alternative is
not an optimisation, it is *the same property that caused the original bug* —
behaviour that depends on whether a sibling happened to be running. Only the lie
moves. Instead of `entityId` being wrong, the **place you look for it** would be.
And it is untestable where it matters: on a dev stand a request almost always
carries one call, so the rule would look correct right up to production.

What that obliges instead: make the join cheap and say so. Both rows carry the
same `traceId` (verified in the reporter's baseline), so recovering the entity is
one join, and the CHANGELOG should show it rather than leave a reader to conclude
the field vanished.

## Validator notes — the plan

Two read-only validators against the real code. Both changed the shape of the
work, and one caught a mistake in my model of the defect.

**The corruption was narrower than I wrote, and the leak wider.** I claimed
parallel calls poison each other's `dimensions`, `userId` and `error`. Only
`dimensions` comes from the request context on a tool row. `setRequestUser` and
`setRequestError` never reached a tool row at all — they corrupt the **enclosing
HTTP row**. Root-cause narrative and acceptance criteria both corrected.

**The stdio question was the decision, not a consequence.** I had filed "a stdio
call gains a context" as a side effect to note. It is the fork/no-fork switch.
Validator evidence decided it: forking a root makes the audit hook take its
`childSpan` branch and stamp every stdio / CLI row with a `parentSpanId` pointing
at a span no row emits, and a `--wait` CLI command would mint an unrelated trace
per poll tick. Chose fork-only-where-a-parent-exists. As a bonus the
`tool-logger` JSDoc ("`traceId` absent when nothing established a context")
stays true, which the wider choice would have falsified.

**"Sequential calls behave exactly as before" was false.** Dimensions
*accumulated* through the shared store, so a second row carried the first call's
keys. It only looked unchanged because my own reproduction stamped the same key
twice. Restated and pinned.

**`trace` must be copied verbatim** — minting a child at fork time is the
natural thing to write and would break `parentSpanId` silently.

**The fork must wrap `afterToolCall`.** A fork around the handler alone still
reproduces the bug, because that is where the row is built.

## Validator notes — the implementation

**A fabricated figure, in a permanent record.** I wrote that the defect "lived
eight months", in ADR 0045 and in the test header. The repository is 2 months 17
days old and both files date from the first commit. The number was invented for
rhetorical weight and would have been cited later as fact. Replaced with "since
the first commit", which is checkable.

**Two ADRs contradicting each other.** ADR 0045 claimed per-call correlation of
`beforeToolCall` → `afterToolCall` was "previously impossible"; ADR 0042
documents the `ToolCallContext` object as exactly that handle, and the code
builds it fresh per call. Rewritten.

**The forked context is a mixture, and that was undocumented.** It names the call
but carries the request's `trace` and `startedAt`. The guide tells readers to
stamp span ids from `getRequestContext()?.trace` — followed inside a tool, that
emits a row reusing the request's `spanId`. Caveat added to the ADR and the
CHANGELOG.

**The CHANGELOG omitted two breaks, both recommended patterns.**
`setRequestError` from `onToolError` stops naming the HTTP row *and* stops
suppressing the framework's own error recording there; `setRequestUser` from a
tool `lifecycle.beforeHandle` now reaches no row at all. Added.

Also fixed: the `dimensions` recipe in the guide (the very paragraph the
CHANGELOG calls "the documented recipe") had not been amended; ADR 0029, whose
contract ADR 0045 claims to uphold, had no annotation; the native-tool leak list
named two of four; dead defaults in the private signature.

## Что сделано

**Ядро** — `packages/core/src/tools/execute.ts`: `executeToolMethod` forks the
ambient context per call and delegates to `runToolMethod`; `trace` verbatim,
fresh `dimensions`, `error` reset, call-describing `source` / `path` /
`serviceName` / `action`, and no fork at all where there is no parent.

**Тесты** — `tool-call-context-fork.test.ts`, 11 cases, all through the real
executor and a real mount: the concurrent swap; the fork covering
`afterToolCall`; trace and parent-span correlation; inheritance; the
call-describing fields; the two things the fork deliberately stops doing (no
outward write, no accumulation across sequential calls); no phantom parent
without an ambient context; **the reporter's nested topology** (request → loop →
concurrent tools, two candidate parents); error isolation; a throwing tool.
Suite 804 → 815.

**Документация** — ADR 0045 + index row; annotations on ADR 0029 and ADR 0041;
`docs/guide/observability.md` in three places; `CHANGELOG.md` 0.36.0 with a
`⚠️ Breaking changes` section.

## Не делалось

- [x] A root context for the parentless transports (stdio, CLI) — argued in ADR
      0045; its home is the transport, not the executor
- [x] Native tools (`mountWait`, `mountViewFile`, `mountUpload`,
      `mountDownload`) still write outward — they bypass `executeToolMethod`
      entirely; named in the ADR rather than left to be discovered
- [x] Tool → tool nesting still produces siblings, not children — unchanged by
      this work, and changing it means changing the fork and the audit hook
      together
- [x] **Stateful MCP identity staleness** — a session resolves its mount
      `context` once, at creation, so every later request's auth is computed and
      discarded and the tool row's `userId` describes the session's opening
      request forever. Out of reach of this fork; its own task
