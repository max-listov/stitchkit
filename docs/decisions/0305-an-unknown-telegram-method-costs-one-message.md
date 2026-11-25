---
title: "ADR 0305: An unknown Telegram method costs one message"
description: "The outbound Telegram budget fails closed: only methods explicitly classified as free cost zero, while any unknown Bot API method costs one message and pauses its chat on 429."
type: decision
status: accepted
amends: ["0274"]
created: 2026-11-23
updated: 2026-11-23
---

# ADR 0305 — An unknown Telegram method costs one message

Serves **I10**, **I13**. Amends [ADR 0274](./0274-a-telegram-token-has-one-outbound-budget.md) (replaces its default that any method outside the send list costs nothing).

## Context

ADR 0274 classified known message-producing Bot API methods in a send list and treated every other method as costing nothing. Telegram adds new send methods between library releases (for example `sendRichMessageDraft`, `sendChatJoinRequestWebApp`, `sendWidget`, `sendSharedWidget`, `editMessageWidgetData`). Under fail-open costing, a bot calling a newly introduced send method bypassed the token budget completely and walked straight into 429 flood waits, and a 429 on that call paused nothing.

## Decision

`telegramOutboundBudget` fails closed on method classification:

- Every method in `FREE_METHODS` (reads, edits of an already-sent message, deletions, administration, `sendChatAction`, `answerWidgetQuery`, `editSharedWidgetData`, plus deprecated Bot API aliases of free methods such as `kickChatMember` and `getChatMembersCount`) costs zero.
- Every weighted send method (`sendMediaGroup`, `sendPaidMedia`, `copyMessages`, `forwardMessages`) costs its item count (at least 1).
- Every other method — including any method unknown to the budget — costs **one** message and, on a 429, pauses its `chat_id` (or the whole token when the payload carries no `chat_id`).
- A completeness test against `@grammyjs/types`'s `ApiMethods` (including property aliases) fails the suite whenever a grammY upgrade introduces an unclassified method.

## Consequences

- A Bot API send method added after a Stitchkit release is paced immediately instead of bypassing the shared budget.
- A newly added read-only Bot API method is paced as 1 message until added to `FREE_METHODS`; callers experience at most one slot delay rather than unbudgeted flood waits.
- Every grammY upgrade that adds methods prompts an explicit classification decision in `packages/core/src/telegram/outbound-cost.ts`.
