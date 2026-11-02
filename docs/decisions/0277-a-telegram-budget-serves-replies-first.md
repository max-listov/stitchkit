---
title: "ADR 0277: A Telegram budget serves replies first and pauses on sends"
description: One token's rate has an interactive lane granted before bulk, and only a 429 on a method that spends the budget pauses the token.
type: decision
status: accepted
created: 2026-11-02
updated: 2026-11-02
---

# ADR 0277 — A Telegram budget serves replies first and pauses on sends

Amends [ADR 0274](0274-a-telegram-token-has-one-outbound-budget.md). Serves **I9**, **I13**.

## Context

A consuming project moved every send of a bot onto one budget and read two properties that hurt a live
bot beside a campaign. The queue is first in, first out, so a reply to a person waits behind recipients:
at 24 messages a second, about 0.8 s behind 20 texts and about 8 s behind albums of 10 (calculated, not
measured). And `run` paused the whole token on any 429, including one on `editMessageText` of a single
progress card, so a limit on editing one message stopped the campaign.

## Decision

The budget has two lanes over one rate. A call is `interactive` unless it says `bulk`. A waiting
interactive call is granted before any waiting bulk call; order inside a lane stays first in, first out.
The grants share one schedule, so the sum never exceeds `messagesPerSecond`, and a grant already made is
not revoked: a reply can still wait out the interval of the album before it.

A 429 pauses the token only when the method spends the budget. An edit or a read that sees one returns it
unchanged and pauses nothing. `pauseAfter` stays public for a caller who decides otherwise.

## Alternatives

- Fair sharing between lanes: rejected because the point is that a person never waits on a campaign. A
  campaign has no deadline a reply can break, and a steady stream of replies is the bot working.
- A lane per subsystem: rejected. Two names answer the question that was asked, and more would be a
  scheduler nobody asked for.

## Consequences

Sustained interactive traffic can starve bulk; that is the priority working, and `stats().queuedBulk` shows
it. A caller that relied on an edit's 429 to stop sends now calls `pauseAfter`. Proven in
`packages/core/tests/telegram-outbound-budget.test.ts`.
