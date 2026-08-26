---
title: Clean Socket.IO shutdown must let the Bun process exit
description: Prove physical process termination after an upgraded WebSocket has existed and managed shutdown reports clean
type: task
status: done
created: 2026-08-26
updated: 2026-08-26
completed: 2026-08-26 19:26 +00:00
---

## Why

The Bun server adapter takes a special path after an upgraded WebSocket has existed:
`stopGracefully()` starts `server.stop(true)` but does not await it because Bun can leave that
Promise pending after the socket has physically closed. That creates a hypothesis the application
lifecycle could report `clean` while the process remains alive until its supervisor sends
`SIGKILL`; the externally observable process boundary needs to prove or falsify it.

The existing tests prove the lifecycle result and physical socket callbacks, but do not prove the
last externally observable contract: a child process that has accepted an upgraded Socket.IO
connection exits by itself after clean managed shutdown.

## Result

- A Bun child process that serves Socket.IO, accepts an upgraded WebSocket, receives `SIGTERM` and
  completes managed shutdown exits by itself with code `0` inside a bounded interval.
- `clean` is not reported while a framework-owned runtime resource can still keep the process alive.
- Consumers do not need `process.exit(0)`, a shortened supervisor timeout or access to private Bun
  Engine internals.

## Plan

- [x] Add a child-process fixture using the public `createSocketIOServer` + `createServer` +
      managed application/signal path.
- [x] Establish one upgraded Socket.IO connection, close it through `SIGTERM`, and assert both the
      clean lifecycle result and natural process exit.
- [x] Capture active resource types when the child misses the deadline so the regression names the
      retained owner instead of only timing out.
- [x] Fix the Bun/Socket.IO server lifecycle at the owning layer; closed without a runtime edit:
      the exact public lifecycle already exits naturally on the released implementation, so there
      is no failing mechanism to change without inventing one.
- [x] Run the full public verification conveyor; publish a patch only if the proof requires a
      package change. `bun run verify` is green, and no patch is published because the released
      runtime already satisfies the contract and the only change is repository-side regression
      coverage, which is not part of the package.

## Acceptance

- [x] The regression fails on the affected release without an external `SIGKILL` being mistaken for
      success; closed by falsification: there is no affected release in the stated scope. The
      unchanged `0.67.0` runtime passed the exact child path 20/20 times, so a manufactured runtime
      edit would not be a fix.
- [x] The fixed child exits with code `0` within `5 s` after `SIGTERM` after at least one upgraded
      connection.
- [x] No server listener, WebSocket, Engine.IO timer or unresolved framework-owned stop operation
      survives the clean result.
- [x] Existing forced-shutdown, pending-request and physical WebSocket-drain tests remain green.
- [x] The result identifies the version under proof and the exact child-process test evidence. No
      package code changed, so the version under proof remains the already-published
      `stitchkit@0.67.0`.

## What was done

### Physical process proof

- [x] `packages/core/tests/fixtures/bun-socketio-clean-shutdown.ts` runs the public
      `createSocketIOServer` → `createServer` → `managedServerResource` →
      `createApplication` → `bindProcessSignals` path, accepts a real external upgraded WebSocket,
      and reports the application result after `SIGTERM` without calling `process.exit()`.
- [x] `packages/core/tests/server-socketio-process-exit.test.ts` —
      `a clean managed Socket.IO shutdown lets the Bun process exit naturally` requires result
      `clean`, resource `http: closed`, natural exit code `0`, and a hard `5 s` upper bound. A
      deadline miss prints the child's `process.getActiveResourcesInfo()` before the parent applies
      cleanup `SIGKILL`, so that kill can never count as success.

### Falsification and gates

- [x] The new subprocess passed 20 consecutive runs on Bun `1.3.14`, with observed completion in
      138–213 ms. The task's proposed retained-runtime defect is therefore not present in the
      released source it named.
- [x] The focused server lifecycle set is green: 17 tests across
      `server-shutdown.test.ts`, `server-shutdown-signal.test.ts`,
      `server-shutdown-lifecycle.test.ts` and `server-socketio-process-exit.test.ts`.
- [x] `bun run verify` is green for tree `999ccfd9d250`: lint, typecheck, 1,840 core tests,
      PostgreSQL store lane, build, Node/Next smokes, packed consumer, both target starter variants
      and the supervised PM2 lane.

### What was not done

- [x] No `server.unref()`, forced exit, timeout shortening or other speculative runtime change was
      added: the exact physical path exits naturally before such a change, so none could be proven
      causal.
- [x] No package version was bumped and no npm release was made: tests and backlog records are not
      shipped in the `stitchkit` package, and publishing byte-equivalent runtime code would create a
      release with no consumer result.
