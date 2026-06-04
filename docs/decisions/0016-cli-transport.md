---
title: "ADR 0016 — CLI as the fourth transport"
type: decision
status: accepted
created: 2026-05-29
updated: 2026-05-29
---

# ADR 0016 — CLI as the fourth transport

- **Status:** Accepted — extends [ADR 0007](0007-mcp-agent-tools.md), upholds [ADR 0014](0014-tool-http-parity.md)
- **Date:** 2026-05-29

## Context

A `defineContract` already drives three surfaces — an HTTP API, MCP tools and
agent tools (ADR 0007), all held to the same contract (ADR 0014). Three real
needs are covered by none of them:

1. **Background-friendly generation.** An MCP `wait_for_generation` call blocks
   the client; the model cannot do anything else while it polls. A CLI command
   started with `Bash(run_in_background)` frees the model and notifies on exit.
2. **Skills-friendly.** The Skills pattern (a `SKILL.md` that shells out via
   Bash) wants one `myapp generate "…" --wait`, not a JSON-RPC round-trip.
3. **Human- and script-friendly.** `myapp models list --json | jq …` from a
   terminal, no Postman, no MCP client.

The choice was a thin wrapper (CLI = typed client + an arg parser, calling the
backend over HTTP) versus a real transport (CLI = a fourth surface peering with
MCP / agent). The thin wrapper has no `source: 'cli'`, no auth gate on the CLI
side, no parity guarantee, and re-implements CLI behaviour in every consumer.

## Decision

**The CLI is a first-class transport, not a wrapper.** A command runs through
the same `executeToolMethod` pipeline as MCP and agent: the same disjoint
argument slicing, the same `lifecycle.beforeHandle` auth gate, the same output
validation and error model. ADR 0014 parity now reads **HTTP ≡ MCP ≡ agent ≡
CLI**, asserted in `tests/parity.test.ts`.

- `Transport` gains `'CLI'`; `TransportSource` gains `'cli'`.
- `createCli` mirrors `createStdioMcpServer`: identity is resolved **once** at
  startup (an env var / token file), not per call. It loops `collectTools(svc,
  'CLI')` into a command map and a shared `createToolRunner({ source: 'cli' })`.
- CLI-unique behaviour lives around the shared core: argv → typed args
  (`cli-args`), stdout / exit-code formatting (`cli-format`), and `--wait`
  polling (`cli-wait`).

**CLI exposure is opt-in.** A method surfaces as a command only when its
contract `expose` explicitly lists `'CLI'`. Unlike MCP / agent — where a method
with no `expose` is on by default — adding the CLI transport never silently
widens an existing contract's surface (an MCP API tool does not become a shell
command unless the author says so). `collectTools` special-cases `'CLI'` for
this reason.

**The core ships no binary.** stitchkit exports `createCli`; the consuming app
writes its own executable (`#!/usr/bin/env node` → `createCli({ … })`) and the
`bin` entry in its own `package.json`. The `stitchkit/cli` entrypoint pulls in
neither the MCP SDK nor `ai`, so a CLI binary needs no MCP/agent peers.

**`--wait` is a generic poller.** The core stays domain-free (ADR 0002): the
poller re-calls a consumer-named tool until a consumer predicate returns done.
It knows nothing about "generations" or "statuses".

## Intentional differences

- **stdout is reserved for output.** Success goes to stdout (raw JSON under
  `--json`, pretty otherwise); errors and progress go to stderr — so `--json`
  stays pipeable while `2>/dev/null` stays clean.
- **Exit codes carry the error class.** A `ToolResult.code` maps to a process
  exit code (`VALIDATION_ERROR → 1`, `FORBIDDEN → 3`, …) so a script can branch
  on `$?`. Overridable per app.
- **Multipart is CLI-invisible, same as MCP / agent.** A file-upload endpoint is
  not a JSON-tool form; CLI file upload (auto-upload of local paths) is a
  separate native command, out of scope for v1.

## Consequences

- One contract now yields four surfaces; the parity invariant is mechanically
  guarded for all four.
- Opt-in exposure means a fresh contract shows zero CLI commands until methods
  add `'CLI'` to `expose` — documented in `docs/guide/cli.md` so it is not
  mistaken for a bug.
- The auth gate is honoured only when the app passes a `createAuthHook` result
  as `lifecycle` and injects identity via `context`. Without a `lifecycle` a
  scoped command runs **unguarded** (fails open) — the scope check is skipped
  because nothing wires it in — exactly as on the other tool transports
  (ADR 0014, where the gate is opt-in on every tool surface). An app exposing
  scoped methods on the CLI **must** pass the same `createAuthHook` result it
  uses for the HTTP server's `beforeHandle`.
