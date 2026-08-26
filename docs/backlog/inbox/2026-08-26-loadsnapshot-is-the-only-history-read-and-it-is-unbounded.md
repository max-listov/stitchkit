---
title: loadSnapshot is the only history read, and it is unbounded
description: The single way to read a conversation returns every message and every run, so paged history cannot be added without breaking the store contract.
type: task
status: inbox
created: 2026-08-26
updated: 2026-08-26
---

## Зачем

`AgentRuntimeStore.loadSnapshot(conversationId)` returns **all** messages and
**all** runs, and the driver member behind it — `history.load(tx, conversationId)`
— takes no cursor and no limit. It is called on every run, and again in the
executor's catch path.

The irony is written into the codebase already. `scanRecoverable`'s own doc says
*"recovery must not depend on loading every recoverable conversation into memory
to start"*, and that reasoning was never applied to the conversation itself. A
long-running assistant conversation is exactly the thing that grows without
bound, and compaction reduces it only when an application has configured
compaction.

**Why this matters now rather than later:** the next obvious capabilities —
paged history, "the last N turns", a read of one run by id — cannot be added
without either changing `loadSnapshot`'s contract or adding a required driver
member. Both are breaking, and the driver is where ADR 0111 just moved the
stability promise. A surface that cannot grow additively in the direction it
obviously must grow is not ready to be declared stable.

Related and smaller, from the same read: there is **no per-run read at all**.
`submit().admission` hands back a `runId`, and the only way to resolve it is to
load the whole conversation and search.

## Результат

- A conversation can be read in bounded pieces, and a run can be read by id,
  without a future breaking change to do it.

## План

- [ ] Decide the read shape before anything else: a cursor on `history.load`, a
      separate paged member, or a projection the runtime asks for by intent
      ("what I need to build a prompt") rather than by range.
- [ ] Decide whether the driver gains an optional member — the driver has **no
      optional members today**, so "additive growth" has no mechanism there and
      that is its own decision.
- [ ] Add a per-run read, or state why `loadSnapshot` is the only supported way
      to resolve a `runId` and make the guide say it.
- [ ] Whatever is decided must be reflected in the conformance kit, or adapters
      will implement it three different ways.

## Acceptance

- [ ] A conversation of ten thousand messages can be run against without loading
      all of them, or the guide states the limit and the mitigation plainly.
- [ ] A `runId` resolves through a supported call.
- [ ] The conformance kit covers whatever member is added.
