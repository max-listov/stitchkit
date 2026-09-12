---
title: "ADR 0178: Instructions carry a role, and user-role instructions are durable history"
description: "Prompt sections declare system or user authority; system text stays outside history and is rebuilt per call, while user text is seeded once as an ordinary durable message that compaction and clear may touch."
type: decision
status: accepted
created: 2026-09-12
updated: 2026-09-12T16:27+07:00
---

# ADR 0178 — Instructions carry a role

## Decision

System sections are policy outside history. User sections are ordinary durable
user messages, prepended atomically once under `prompt.user-instructions`.
The receipt survives compaction and history replacement; removed instructions
are not silently resurrected on the next turn. Archive replay includes seed
transitions. SQLite schema version 3 adds receipts; custom drivers implement
`seeds.load/create` and the `seed` history mutation in their transaction.
A complete imported seed can reconstruct its receipt. A partial identity match
is refused explicitly, leaving the history unchanged for repair by the host.

The runtime calls the prompt resolver once before a provider loop, with
`event: 'session.started'` for the first recorded run and `turn.started` for
later runs. Forward this event into `composeAgentPrompt`; section `render`
receives it. Standalone composition defaults to `turn.started`. `step.started`
is refused. Recovery may resolve the same run again: resolvers must be
idempotent. System sections refresh on each run; changing a user section after
its first seed does not rewrite the conversation.

## Budget

`historyTokens` counts existing history, including any surviving seed.
The composer reserves system instructions and provider/tool/output overhead.
After the atomic seed the runtime calls `finalizeSeed(inserted)` to reserve
user text only when this invocation actually introduced it. Already-seeded or
compacted text adds no second reservation. Unknown counts stay unavailable.

## Validation

Runtime first/second-turn budget tests, once-seeding conformance for custom
stores, partial-import refusal, SQLite reopen and explicit v2→v3 migration.
