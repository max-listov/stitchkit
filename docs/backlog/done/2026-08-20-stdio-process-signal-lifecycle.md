---
title: Explicit process-signal lifecycle for stdio MCP servers
description: Remove the idempotency, error and escalation state machine that every createStdioMcpServer consumer otherwise rewrites around close().
type: task
status: done
created: 2026-08-20
updated: 2026-08-20
completed: 2026-08-20 09:50 +00:00
related: 2026-08-17-process-signal-shutdown-binding.md
---

# Process signals for `McpStdioHandle`

## Зачем

`createStdioMcpServer` returns a framework-owned `{ close() }` lifecycle handle,
but `bindProcessSignals` accepts only an HTTP-style `{ shutdown(options) }`
target. A local MCP executable must therefore recreate process plumbing around
the Stitchkit handle: register `SIGINT`/`SIGTERM`, guard duplicate close calls,
report close failures, choose repeated-signal behavior, avoid an unhandled
rejection and decide when listeners are removed.

That state machine is transport/lifecycle infrastructure, not application
business logic. Hand-written versions commonly call `process.exit()` directly,
which can truncate diagnostics or claim success before a rejected close has
been handled.

## Результат

- Stitchkit provides one explicit, idempotent signal-binding path for an
  `McpStdioHandle` (or a documented generic closeable target) without installing
  global listeners automatically.
- First signal starts exactly one close chain; repeated signals have defined
  escalation semantics; close rejection is observable and never becomes an
  unhandled rejection.
- The returned binding exposes a promise and listener cleanup so tests and
  executable owners retain control of exit codes and process policy.
- The framework never calls `process.exit()` and never reports a physical
  force-close capability that the official stdio transport does not provide.
- Node-facing declarations remain consumable without leaking unrelated Bun or
  HTTP server types.

## Границы

- Do not bolt a fake grace-period/forced result onto a close-only transport.
  Reuse `bindProcessSignals` only if its contract can stay truthful for both
  shutdown-capable and close-only targets; otherwise expose a smaller sibling
  abstraction with shared internals.
- Application cleanup such as database flushes, worker shutdown and exit-code
  policy stays in callbacks owned by the executable.
- Signal registration remains opt-in, consistent with the managed HTTP server
  lifecycle.

## Перед планированием

- Research the official MCP stdio server's close completion and failure
  semantics, including a peer that disappears during shutdown.
- Decide the exact second/third signal behavior when there is no force method:
  default-signal redelivery may be more honest than pretending to abort close.
- Add a real subprocess acceptance path that proves stdout remains reserved for
  JSON-RPC and stderr/exit behavior is not truncated.

## План

- [x] Factor the shared listener/guard/escalation mechanics without weakening
      the existing managed-server `bindProcessSignals` state machine.
- [x] Add an explicit close-only stdio binding whose first signal runs exactly
      one `close()` and whose later signal restores default disposition.
- [x] Expose callback, promise, cleanup and injected-signal-source types without
      fake force/grace semantics or automatic listeners.
- [x] Add unit state-machine and real stdio subprocess signal coverage, including
      clean close, repeated signal, callback failure and stdout integrity.
- [x] Update the tools API/guide, deployment guide, ADR/index and changelog.

## Acceptance

- [x] One signal closes one stdio handle exactly once and the returned promise
      settles only after the official handle's `close()` completes.
- [x] A later signal during close escalates via default-signal redelivery rather
      than pretending that close is abortable.
- [x] Close and callback failures are observed without unhandled rejections;
      closing an idle binding removes listeners and resolves `undefined`.
- [x] A real stdio subprocess exits cleanly with JSON-RPC stdout unpolluted.
- [x] `bun run verify` is green.

## Конвейер 0/0

- [x] Plan validators: intentionally none by owner request.
- [x] Implementation and authorized gates completed by the primary agent.
- [x] Implementation validators: intentionally none by owner request.

## Что сделано

- [x] Extracted the real signal source, callback guards and phased error
      reporting shared with managed HTTP shutdown without changing that machine.
- [x] Added `bindStdioProcessSignals` with one close chain, same-turn duplicate
      suppression, idle listener cleanup and honest default-disposition
      escalation on a later signal.
- [x] The framework observes close rejection, reports prepare/close/complete
      separately, installs no listener implicitly and never calls
      `process.exit()`.
- [x] ADR 0084, MCP/deployment guides, API reference, changelog, exact public
      surface and packed consumer fixture are synchronized.
- [x] Регрессия: packages/core/tests/process-signals.test.ts::one signal closes exactly once and the promise waits for physical close completion; packages/core/tests/process-signals.test.ts::a later signal escalates instead of pretending close is forceable; packages/core/tests/process-signals.test.ts::reports prepare/close/complete failures without an unhandled rejection; packages/core/tests/process-signals.test.ts::idle close is idempotent, releases the handle and settles the promise; packages/core/tests/mcp-stdio-signals.test.ts::a real SIGTERM closes stdio, preserves stdout and exits naturally.
- [x] `bun run verify` completed with exit 0 on 2026-08-20; no release, commit,
      tag or push was performed.
