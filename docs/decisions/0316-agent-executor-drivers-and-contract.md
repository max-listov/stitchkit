---
title: "ADR 0316: The agent executor is drivers and a contract, not a daemon"
description: "Adds stitchkit/agent-executor: Stitchkit owns engine drivers over stitchkit/process, the Zod schemas of the executor ↔ server contract and its pure reducers; the application owns the executor process, its reconnects, restarts, autostart, keychain and login. Deltas extend the neutral agent-parts blocks; leases are on threads with a fence; an unknown outcome is never resent."
type: decision
status: accepted
amendedBy: ["0329", "0334"]
created: 2026-11-24
updated: 2026-11-26
---

# ADR 0316: The agent executor is drivers and a contract, not a daemon

Serves **I7**, **I8**, **I11** and **I15**. Relates to [ADR 0130](0130-headless-harness-composes-the-agent-runtime.md).

## Context

Applications drive coding agents — Claude Code, Codex, ACP agents — as external harnesses with their own loop, and each kept its own drivers: a session manager on the developer's machine, a desktop runtime on a member's Mac. The drivers share hard-won rules: a native session id pinned per thread, a send whose outcome is unknown is not repeated, a profile per account, three-valued plan limits. None of them could be taken as a library. ADR 0130 says the runtime's harness "owns no executable process, restart policy, control transport … credential resolution"; I11 says one process composes, and supervision never becomes a condition.

## Decision

1. **Stitchkit owns the drivers, the contract and the reducers — not the executor process.** `stitchkit/agent-executor` holds the delta vocabulary, the contract's Zod schemas and operations, and pure reducers; vendor drivers are leaves (`…/claude`, `…/claude-sdk`, `…/codex`, `…/acp`) the base entrypoint does not know (I7). The Agent SDK leaf takes the SDK's `query` from the application and imports only the SDK's types, so the SDK stays an optional peer and the leaf loads without it; the CLI and SDK leaves read records through one classifier. An engine process lives for one connection (amended by ADR 0329: Codex also offers an opt-in `openSharedServer()` over `stdio` multiplexing bounded threads with `thread/unsubscribe`), spawned through `stitchkit/process` with `envPolicy: 'declared-only'`, `ownerLoss: 'terminate'` and bounded stderr. Reconnecting, restarting, autostart, the keychain, signing in and the executor's own credentials for the server belong to the application; the module reads the login status and never performs a login.
2. **One vocabulary.** The blocks of a message (text, reasoning, tool call and result, approval) move to the neutral part `agent-parts`, which the runtime and the executor both import and neither owns. A delta is such a block `.extend`ed with `turnId`, `itemId` and `raw { source, type }`, plus `request`, `request-resolved`, `usage`, the context gauge `context-usage`, `turn-end`, `error { kind }` and `window { reset }`. Folding deltas into message parts is one mechanical function. The executor and the runtime never import each other (I15).
3. **Leases are on threads.** A thread's history lives in one engine profile on one machine, so a thread is pinned to `executorId + profileId`; its fence counts grants, and a second instance gets it only after release or proven death. TTLs run on the server's monotonic clock; renew every `ttl/3`. The server keeps turn receipts for each thread's last `retainedTurns` turns (default 64, at most 1024), so its state is bounded by threads, not by history. A turn carries the ordinal the server offered it under, and a thread remembers the highest ordinal it let go: a report of a turn at or below it — its first report included — is answered `not-retained`, never applied again, and a hello resuming it learns the same.
4. **A turn's phases are named, and an unknown is final.** `leased → dispatching → delivered → completed | interrupted | failed | unknown`, `unknown_after_restart`, and the server's own `cancelled`. Dispatch runs through `LocalStepDurability.effect` with the driver's `reconcile`: `client-id` engines are asked for the id the executor chose; `none` engines leave an interrupted dispatch `unknown_after_restart`. Never repeated: input after `dispatching`, a steer, an answer to a permission request, an interrupt whose outcome is unknown, a "continue" after a limit.
5. **No new transport.** The operations (`hello`, `claim`, `renew`, `release`, `report`) are a `defineContract`; offers, interrupts and replies travel the realtime contract (ADR 0220). (amended by ADR 0334: every object of the contract is strict, so a key one release adds is refused by an older reader — the server is upgraded first, and it writes an added reply key only to an executor whose `hello` declares the capability for it.)

## Failure modes

| Failure | The turn | Sent again | Never sent again |
|---|---|---|---|
| Executor dies during a turn | `unknown_after_restart`, or reconciled by client id on the next `hello` | reports after the server's `ackedSeq` | the input once `dispatching` |
| Executor stops cleanly | interrupted, lease released | — | — |
| Engine process dies | `failed { engineCrashed }`; a new process is a `window { reset: 'generation' }` | — | the input of the turn it died in |
| Network partition | the lease runs out on the server's clock; the thread waits for release or proven death | reports, idempotent by `executorSeq` | — |
| Double lease | the older fence's reports are refused `EXECUTOR_FENCE_STALE` | — | anything under the old fence |
| Clock skew | no effect: only the server's monotonic clock times leases | — | — |
| Login expired | `failed { authRequired }` | — | — |
| Plan limit reached in a turn | `failed { rateLimited }`, limits reported with `observedAt` | — | the "continue" |
| Server dies | the executor keeps its spool, bounded, and reconnects through the application | reports after `ackedSeq` | — |
| Unknown `interactionId` | the reply is refused | — | the guessed answer |

## Consequences

- A session manager, a desktop runtime and a server share one tested set of drivers and one contract, and move to it in their own repositories after the release.
- OpenCode and custom harnesses stay outside the module.
