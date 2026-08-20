---
title: "ADR 0084: Stdio process signals are close-only"
description: Stdio MCP handles get an explicit signal binding that owns one close chain and truthful escalation without pretending to support managed force shutdown.
type: decision
status: accepted
created: 2026-08-20
updated: 2026-08-20
---

# ADR 0084 — Stdio process signals are close-only

## Context

ADR 0076 centralised the process-signal machine for managed HTTP servers, whose
`shutdown(options)` accepts one total grace budget and an abort signal that a
later OS signal can use to force the same chain. `createStdioMcpServer` instead
returns the official MCP transport's close-only handle. It has no deadline,
force primitive or physical-close report.

Reusing the HTTP result shape would claim guarantees stdio does not have, while
leaving the process wiring to every executable repeats listener cleanup,
duplicate-close, error observation and escalation bugs.

## Decision

`bindStdioProcessSignals` is an explicit sibling of `bindProcessSignals` over a
generic `{ close() }` target:

- the first signal runs optional preparation and exactly one `close()` chain;
- same-turn duplicate signals are ignored so a supervisor's paired signals do
  not kill a close that just started;
- a later signal cannot force an unabortable close, so the binding removes its
  listeners and re-raises the signal with the default disposition;
- preparation, close and completion errors are reported by phase; only close
  failure rejects the returned promise, and that promise is internally observed;
- `close()` removes an idle binding and resolves its promise with `undefined`.

Signal-source and callback guard mechanics are shared internally with the HTTP
binding, but their public state machines remain truthful and separate. The
framework installs no listeners until the application calls the binder, never
calls `process.exit()` and never chooses an exit code.

This extends ADR 0076; it does not replace or weaken managed HTTP force
semantics.

## Consequences

- Stdio executables get deterministic idempotency, cleanup and error reporting
  without hand-written global process plumbing.
- The returned promise settles after the official handle's `close()` completes,
  not after receipt of the signal.
- A stuck stdio close has no imaginary grace result. Operator/supervisor
  escalation uses the OS default disposition, subject to the same competing
  listener limitation documented by ADR 0076.
- Application resources and exit-code policy remain owned by the executable;
  stdout remains exclusively the JSON-RPC channel.
