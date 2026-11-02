---
title: "ADR 0278: A Telegram 429 holds the chat that got it"
description: One chat's refusal pauses that chat, several chats at once pause the token, and a queued call can bound its wait.
type: decision
status: accepted
created: 2026-11-03
updated: 2026-11-03
---

# ADR 0278 — A Telegram 429 holds the chat that got it

Amends [ADR 0274](0274-a-telegram-token-has-one-outbound-budget.md) and
[ADR 0277](0277-a-telegram-budget-serves-replies-first.md). Serves **I9**, **I13**.

## Context

A 429 does not name its scope: a group's limit of about 20 messages a minute, one chat's pace and the
bot's own limit arrive as the same answer, and only the addressee differs. The budget paused the whole token
on any of them. A consuming project measured 313 refusals over 30 days of production logs, every one from
one notification group, with `retry_after` up to 41 s. On a loopback model of that limit a person's reply
waited 24 135 ms instead of 1 ms, and bulk did not move at all; the model's scale is arbitrary, the group's
real limit was not measured. That project worked around it with a second budget under a derived key, and every
bot with a notification group would have to do the same.

## Decision

A 429 on a send pauses the `chat_id` of that send. The chats of a token keep sharing one rate, and a call for
a paused chat stands aside in the queue without holding the calls behind it.

The token pauses when refusals come from `tokenPauseChats` different chats inside `tokenPauseWindowMs`
(3 and 5000 ms by default), and on a 429 with no chat to blame. Under the bot's own limit every send is refused,
so several chats are refused within moments; a group's limit stays with that group. The wrong guess costs
little either way: a false token pause is the old behaviour for one `retry_after`, and a missed one costs a few
more refusals before the threshold.

`maxWaitMs` bounds a queued call, which ends with `TelegramNotDispatchedError`, stage `queue`. A chat on
pause no longer limits the queue by itself: without a bound a burst to it accumulates for as long as the burst
lasts.

## Alternatives

- Keep the token pause and let applications run a budget per chat: rejected, that is the workaround this
  replaces, and it splits the one rate ADR 0274 exists to keep.
- Ask the caller to declare the scope of each send: rejected, the caller knows no more than the budget does.
- A permanent option for the old behaviour: rejected by I8; `pauseAfter(error)` without a chat stays for a
  caller who decides a refusal stops everything.

## Consequences

A bot under its own limit sends a few more refused messages before the token stops. A call that used to wait
behind a chat's pause now runs, which is the point, and code that relied on one chat's 429 stopping the others
calls `pauseAfter(error)`. Proven in `packages/core/tests/telegram-outbound-chat-pause.test.ts`, including
a real socket through grammY.
