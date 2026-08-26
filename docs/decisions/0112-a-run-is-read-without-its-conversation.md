---
title: "ADR 0112: A run is read without its conversation, and history stays whole"
description: "loadRun and listActiveRuns answer by intent over records the driver already had; paged history is refused for now because it would change what a snapshot is."
type: decision
status: accepted
created: 2026-08-26
updated: 2026-08-26
---

# ADR 0112 — A run is read without its conversation

## Context

`loadSnapshot(conversationId)` was the only read on `AgentRuntimeStore`. It
returns **every** message and **every** run, and the driver member behind it —
`history.load(tx, conversationId)` — takes no cursor and no limit.

The irony was already in the codebase. `scanRecoverable`'s own doc says
*"recovery must not depend on loading every recoverable conversation into memory
to start"* (→ ADR 0101), and nobody applied that reasoning to the conversation
itself.

Then we counted the callers, and the count is the whole argument. Of the eight
`loadSnapshot` calls in the runtime, **seven never touched a message**:

| caller | what it wanted |
| --- | --- |
| `executeRun` entry | the queued run's revision |
| `assertCurrent` — **before every tool call** | owner, fencing token, state |
| `executeRun` catch path | whether a durable interrupt landed |
| `commitAgentRunTerminal` conflict path | the run and its retained answer |
| `runtime.resume` | one recovered run |
| `runtime.interrupt` | one run's revision |
| `runtime.recover` | whether anything else is in flight |

`assertCurrent` is the sharpest of them: twenty tool calls in a
five-thousand-message conversation read a hundred thousand messages to compare
two numbers. Nothing in the design asked for that. There was simply no call that
said "this run", so every caller said "this conversation" and threw the rest
away.

There was also no per-run read at all. `submit().admission` hands back a
`runId`, and the only supported way to resolve it was to load the whole
conversation and search it.

## Decision

**Two reads, added to the store, answering by intent.**

- `loadRun({ conversationId, runId })` → the run, the conversation version it
  was read at, and — once the run is terminal — the answer it produced.
- `listActiveRuns(conversationId)` → the runs that have not ended.

Both are used everywhere the seven callers above used to load a conversation.

**Neither needs a driver member.** `AgentRuntimeStoreDriver` already had
`runs.load`, `runs.listActive` and `head.load`; nothing had ever asked them.
That is the part worth recording: the growth this surface needed was not new
extension points, it was a caller that says what it wants. A driver written for
0.65 satisfies both new members with no change at all.

`listActiveRuns` orders by `createdAt` then `id`, which is **weaker** than
`AgentSnapshot.runs`. The snapshot breaks a `createdAt` tie by where a run sits
in the conversation's history, and reading the history is the cost this call
exists to avoid. The weaker order is stated in the contract rather than left for
a reader to discover.

**History stays whole, and that limit is written down.** `loadSnapshot` and
every mutation still read every message. Paging that is not a bigger version of
this change; it is a different one, because the snapshot is what the store's
reducer validates against — run positions within history, compaction range
contiguity, reserved-identity collisions, which runs the messages reference. A
window would make every one of those invariants an assertion over a window, and
the mutation result the runtime builds its next prompt from would no longer be
the conversation. That is a redesign, and it is not one to make in the same pass
as the read that removes seven eighths of the pressure for it.

So the guide states the limit plainly and names compaction as the mitigation,
which is what the framework actually offers today.

## Consequences

The fencing check before every tool call is now O(1) in the length of the
conversation. So is resolving a `runId`, interrupting a run, resuming one, and
the terminal path's conflict retry.

`AgentTerminalCommitResolution` carries `snapshotVersion` instead of a whole
`AgentSnapshot`, because one field of it was ever read. `run-execution` keeps
`snapshot` for what it is actually for — the history the prompt was built from —
and tracks the version separately, so a read with no history in it can update
the version without pretending to update the history.

The conformance kit covers both members, including that a live run reports no
terminal answer and that `listActiveRuns` drops a run once it ends. A driver
that answers one and not the other fails the kit.

What this does **not** do: it does not make a long conversation cheap. A run
still reads its whole conversation once, to build a prompt. An application with
conversations that grow without bound configures compaction, and that is the
supported answer until the snapshot question above is decided.

This also settles part of the promotion question in ADR 0111. The store grew
additively — a member added, no driver change, no consumer break — which is
evidence the shape can grow. The half that could not is now named here rather
than discovered later.
