---
title: "ADR 0041 — The cause of a failed tool call is observable"
type: decision
status: accepted
created: 2026-08-06
updated: 2026-08-06
---

# ADR 0041 — The cause of a failed tool call is observable

- **Status:** Accepted — closes an asymmetry between the HTTP and tool paths of
  [ADR 0007](0007-mcp-agent-tools.md) / [ADR 0014](0014-tool-http-parity.md);
  extends the raw hooks of [ADR 0012](0012-observability-module.md)
- **Date:** 2026-08-06

## Context

An agent on a consuming project reported that when a tool handler fails, nothing
in their logs says why. Their audit rows carried the failure, the caller got the
envelope, and the log line for the request was blank on the reason.

Verified before answering, and the report was accurate — though not for the
reason given. It was framed as "`ToolLifecycle` has only `beforeHandle` /
`afterHandle`, so there is nothing to hook". `ToolCallHooks.afterToolCall` does
fire for every failure and does carry the `ToolResult`, so a thrown `AppError`
is fully legible today: `code` and `details` are there, and the request context
is live inside `executeToolMethod`, so `setRequestError` from that hook reaches
the log line. Those cases were never broken.

The hole is the **unexpected** throw — a dropped connection, a `TypeError` — the
case you actually consult logs for. `normalizeError` handles it like this
(`internal/errors.ts`):

```ts
console.error('[stitchkit] unhandled error:', err);
return new AppError('INTERNAL_SERVER_ERROR', 'Internal server error', 500);
```

The scrubbing is correct: a raw `Error.message` can carry a connection string or
a file path, and a tool result is read by a model and often relayed to a user.
What was wrong is that the scrubbed value was the **only** thing any consumer
hook could see. The real value existed for one statement and left through a
`console.error` that cannot be routed, filtered or correlated.

The HTTP path has no such hole. `hooks.onError(ctx, error, endpoint)` receives
the value as thrown, before normalisation. The same handler, reached through two
transports, gave two different answers to "why did it fail" — which is precisely
what ADR 0014 says the tool surface must not do.

## Decision

Add **`ToolCallHooks.onToolError`** — the value as thrown, fired from the `catch`
in `executeToolMethod` before `toolResultFromError` runs.

```ts
onToolError?: (
  toolName: string,
  error: unknown,
  context: ToolCallContext,
  endpoint: MethodDef,
) => void | Promise<void>;
```

**On `ToolCallHooks`, not as an `onError` twin on `ToolLifecycle`.** This is the
part worth recording, because the request was for the opposite and it is the
question that will be asked again.

`ToolLifecycle` documents that a whole `createServer({ hooks })` object is
assignable to it — that is how a `createAuthHook` result drops in as
`beforeHandle` and gates tools with the same rules as routes. Putting `onError`
there forces a choice between two bad ends, both probed rather than assumed:

- **Reuse the HTTP signature** (`=> Response | Promise<Response> | undefined`)
  and ignore the return on the tool path. Assignability survives; a shared
  `onError` silently stops producing its envelope on one of two transports. A
  value that is accepted and quietly dropped is a trap.
- **Narrow it to `=> void | Promise<void>`.** Honest, and it **breaks** the
  assignment — confirmed with `tsc`: the void-return bivariance rule does not
  apply when the target return type is a `void | Promise<void>` union, so
  `LifecycleHooks` stops being assignable to `ToolLifecycle` and every consumer
  passing a shared hooks object fails to compile.

`ToolCallHooks` carries no such constraint. It is already the observation
surface, it is where `afterToolCall` lives, and it is the object a project
passes for audit — so the hook lands next to the one that needed it.

**It fires only where information is destroyed:** a throw from
`lifecycle.beforeHandle`, the handler, or `lifecycle.afterHandle`. Not for a
`beforeToolCall` rejection, an argument-validation failure or an output-schema
mismatch — each of those is already described in full by the `ToolResult` that
`afterToolCall` receives, and a second path to the same information only invites
double-logging.

**It observes; it does not handle.** The return value is ignored, and a throw
from the hook is reported to `console.error` and swallowed. A broken sink must
not replace the failure it was called to observe, nor cost the audit record. It
is awaited **before** `afterToolCall`, so whatever it records — a
`setRequestError`, typically — is in place when the audit hook reads the context.

**`normalizeError` keeps its `console.error`.** A project that wires
`onToolError` now sees the failure twice, in two formats. That was weighed and
accepted: the HTTP path has had exactly this property since the beginning
(`hooks.onError` and the console write both fire), and the loud default is what
makes an unwired framework debuggable. Removing it would trade a duplicate for a
silence in every project that wires nothing.

## Consequences

- The cause of a tool failure is routable — to a log line, an error tracker, an
  audit row — instead of being visible only on stderr.
- Tool and HTTP transports now answer "why did it fail" the same way, closing an
  ADR 0014 parity gap that was not previously stated.
- Purely additive: an optional field on an optional hooks object, reaching every
  mount that already accepts `hooks` (`mountMcp`, `createMcpHandler`,
  `mountAgent`, `createCli`) through the shared `createToolRunner`.
- The tool envelope stays the framework's alone. If a project ever needs to
  *shape* a tool error rather than observe it, that is a separate decision and a
  separate hook — deliberately not conflated with this one.
