---
title: "ADR 0329: Opt-in Codex shared multi-thread server over stdio"
description: "Amends ADR 0316 so createCodexDriver offers an opt-in openSharedServer() over stdio multiplexing up to maxThreads independent CodexSession instances with per-thread routing and thread/unsubscribe cleanup, while keeping one-process-per-session as the default and refusing Unix-socket TUI modes."
type: decision
status: accepted
amends: ["0316"]
created: 2026-11-26
updated: 2026-11-26
---

# ADR 0329: Opt-in Codex shared multi-thread server over stdio

**Relations:** Amends the single-process-per-connection clause of [ADR 0316](0316-agent-executor-drivers-and-contract.md) for Codex `stdio` sessions only. Serves **I8**, **I9**, **I10** and **I11**.

## Context

ADR 0316 specifies one engine process per connection. That remains the right default for interactive sessions and for `unix-listen` / `unix-connect` sessions shared with an external TUI. However, headless applications running many concurrent Codex threads under one profile pay a linear process, memory and cold-start cost even though `codex app-server` natively multiplexes threads over a single `stdio` JSON-RPC peer via `threadId` routing and `thread/unsubscribe`.

## Decision

1. **Opt-in only; default unchanged.** `CodexDriver.open()` continues to spawn one process per session. `CodexDriver.openSharedServer({ profile, cwd, maxThreads?, onStartupPhase?, signal? })` opens one `stdio` `codex app-server` process that multiplexes up to `maxThreads` (default `32`, hard ceiling `256`) independent `CodexSession` instances via `openThread()`.
2. **Fail-closed transport boundary.** Calling `openSharedServer()` on a driver configured with `unix-listen` or `unix-connect` rejects with `TypeError` before spawning: shared multiplexing is for headless `stdio` consumers without an attached TUI.
3. **Strict per-thread routing and isolation.** Notifications and server requests carrying a `threadId` route exclusively to that thread's active turn or bounded per-thread `externalPending` map; global profile notifications (`account/rateLimits/updated`) update the shared profile limits. A handler failure in one thread never kills sibling threads.
4. **Thread close vs server close.** Closing an individual `CodexSession` fails/drains only that thread, frees its slot and sends `thread/unsubscribe` without stopping the shared process or sibling threads. Closing the `CodexSharedServer` — or an unexpected process exit — fails and drains every active thread, clears pending requests and notifies `onDisconnect` once.
5. **Honest capabilities, no daemon.** `CodexDriver.capabilities.multiThreadPerProcess` stays `false`, while `CodexSharedServer.capabilities.multiThreadPerProcess` is `true`. Stitchkit still owns no supervisor, reconnect loop, database or daemon (I11).

## Consequences

- Headless multi-thread consumers can share one `codex app-server` per profile with bounded concurrency (`maxThreads`) and clean `thread/unsubscribe` unloading.
- Single-session callers and TUI-attached `unix-listen`/`unix-connect` callers observe zero behavioural change.
