---
title: "ADR 0301: A refusal says everything a host must do, and where"
description: A branch collects every refusal a declaration or an authorization lifts and answers them at once with their address in the source, never a value; a plan returns the same list without writing; identities are defined before any value is judged.
type: decision
status: accepted
created: 2026-11-22 07:08 +08:00
updated: 2026-11-22 07:08 +08:00
---

# ADR 0301 — A refusal says everything a host must do, and where

Serves **I9** and **I12**. Builds on [ADR 0298](0298-an-application-file-crosses-a-branch-by-declaration.md) and [ADR 0300](0300-a-record-of-the-past-is-not-a-reference.md).

## Context

ADR 0298 and ADR 0300 made a host declare its own data before a branch: the
attachments it stores and grants, the keys it uses under runtime names. A
branch refused with the first thing it could not carry and named no event.

A consuming project branches archives of hundreds of events. It learnt what
to declare one refusal per attempt, and each attempt could only be retried
after a release that told it the next one. It also must grant the destination
access to every attachment before the call (ADR 0298), so it needs the list
before it calls, not after.

Two of the refusals depended on the order of the log: a value under a
`'refuse'` key was judged against the identities defined so far, so the same
idempotency key, schedule or child refused when its definition came first and
passed when it came later.

## Decision

A refusal the host lifts is collected, not thrown: an undeclared key, a
source identity under a key, an undeclared attachment, spills without a fresh
artifact authorization, an event kind the runtime does not know. The branch
reads the whole source and refuses once, with `AgentConversationBranchRefusedError`
listing them all, bounded at 100 with the rest counted.

Every refusal carries its address — the event's sequence and kind, the
message, the tool, the key's path inside the payload — and never a value the
payload holds. An attachment refusal names the reference the host itself
stored and must declare.

A source the branch cannot read as what it claims to be — a broken schema, a
foreign reference, an inconsistent snapshot — stops it at once: no
declaration lifts it, and reading past it would judge data that is not what
it says. It is reported as one more refusal, `integrity`, with the same
address, after what was collected before it.

`planConversationBranch` runs the same planner without writing and returns
the same list, every non-spill attachment reference and the keys to declare,
bound to the source it read by digest. There is one planner with two entries,
so a plan cannot disagree with the branch it predicts; the conformance kit
checks that it does not.

Every identity a source defines — runs, messages, calls, approvals,
operations, owners, idempotency keys, schedules, children — is defined before
any value is judged, so the answer does not depend on event order.

## Consequences

- A host learns everything a branch needs in one call, and can plan grants
  and declarations before it.
- The error stays a `TypeError` whose message starts with the first refusal,
  so a caller matching the old message still matches; a hand-written store's
  own refusal still satisfies the conformance kit unless it also plans.
- Every new refusal a host can lift is written as a collected refusal with a
  code; a check that guards the integrity of the source keeps throwing.
- A value of the source's own identities refuses wherever it sits in the log.
