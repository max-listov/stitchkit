---
title: "ADR 0014 — The tool surface carries the same contract guarantees as HTTP"
type: decision
status: accepted
created: 2026-05-20
updated: 2026-05-20
---

# ADR 0014 — The tool surface carries the same contract guarantees as HTTP

- **Status:** Accepted — refines [ADR 0007](0007-mcp-agent-tools.md)
- **Date:** 2026-05-20

## Context

A contract endpoint is exposed three ways — HTTP, MCP and agent (ADR 0007). The
HTTP transport has always enforced the contract: it parses `params` and `input`
over disjoint slices of the request, validates the handler's output, runs the
`beforeHandle` / `afterHandle` lifecycle, and never lets a caller-supplied field
shadow a framework field.

An audit (the `tools-surface-integrity` task) found the tool transports did
**not** match — they parsed a single flat blob against both schemas (breaking
`.strict()`), skipped output validation, and — most seriously — ran no auth
gate, so a tool call bypassed the scope check an HTTP request would face.

ADR 0007 only promises **MCP ≡ agent** parity. It says nothing about **tool ≡
HTTP** parity. So every fix that closed an audit gap (disjoint slicing, output
validation, the `ToolLifecycle` gate, the reserved-key guard) was an invariant
with no ADR home — free to drift again at the next refactor.

## Decision

**The tool surface carries the same contract guarantees as HTTP.** A call that
enters as an MCP or agent tool is held to the same contract as the same call
over HTTP:

1. **Disjoint argument slicing.** `params` and `input` are parsed over disjoint
   sets of keys — path params vs. body/query on HTTP, the same split on a tool's
   flat argument object. A `.strict()` schema works identically on both.
2. **Output validation.** A handler's return value is validated against the
   contract `output`. A mismatch is a server fault — `INTERNAL_SERVER_ERROR`,
   not the client `VALIDATION_ERROR` an invalid argument produces.
3. **The lifecycle gate.** `ToolLifecycle` (`beforeHandle` / `afterHandle`) is
   the tool-side twin of `createServer`'s hooks. A `createAuthHook` result
   passed as `lifecycle.beforeHandle` scope-guards tools by the **same** rules
   it enforces on HTTP.
4. **The reserved-key guard.** `params`, `input` and `source` are written onto
   the context last — neither static context nor a `ToolExtend.resolve` result
   can shadow them.

**Auth resolves identity per surface, enforces scope uniformly.** HTTP resolves
identity from `ctx.req` (cookie / bearer); a tool call has no `req` — the
transport (MCP API key) authenticated the caller and `buildMcpServer`'s
`context` injected the identity. `createAuthHook` takes a `resolveFromContext`
for the tool surface. The **scope check itself runs identically** on both. If
`resolveFromContext` is omitted, a scoped tool call has no identity and **fails
closed** — the hook never silently passes (the bug this ADR's audit found).

## Intentional differences

Two things deliberately differ between the surfaces — recorded here so they are
not "fixed" into false parity:

- **Error envelope.** HTTP returns the contract `ErrorEnvelope`. A tool returns
  `{ error, details?, _hint? }` — the shape MCP / agent SDKs expect. The error
  *model* is shared (one `AppError`, one `normalizeError`); the *envelope*
  differs because the consumers differ.
- **Multipart endpoints are HTTP-only.** An endpoint with `multipart` is a file
  upload — it has no JSON-tool form, so it is never collected as an MCP / agent
  tool. `collectTools` skips it by design.

## Consequences

- The invariant the `tools-surface-integrity` fixes established now has an ADR
  home — a refactor that breaks tool ≡ HTTP parity contradicts a recorded
  decision, not just a passing test.
- A cross-surface parity test (`tests/parity.test.ts`) runs one contract's args
  through both surfaces and asserts identical accept / reject — the mechanical
  guard behind this ADR.
- `createAuthHook` is safe to pass to both `createServer` and a tool mount: it
  enforces scope on both, and fails closed on the tool surface when the project
  has not wired tool-path identity.
- ADR 0007 is refined, not replaced: MCP ≡ agent parity still holds, and tool ≡
  HTTP parity is now stated alongside it.
