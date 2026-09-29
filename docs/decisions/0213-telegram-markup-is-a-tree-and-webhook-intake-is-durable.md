---
title: "ADR 0213: Telegram markup is a tree, and webhook intake is durable"
description: "Telegram HTML is parsed into a tree that can only express what Telegram accepts, in a peer-free browser-safe subpath; a webhook is set only where it is already this process's or by naming its owner; an update is recorded before Telegram is answered and handled from a store after; the operator channel deduplicates; a journal masks the exact secrets the environment names."
type: decision
status: accepted
created: 2026-09-29
updated: 2026-09-29
---

# ADR 0213 — Telegram markup is a tree, and webhook intake is durable

## Context

A consuming bot kept five mechanisms of the same kind as `stitchkit/telegram`
already holds — facts about Telegram's protocols rather than about any product
— and offered them. Measured against the family and against the Bot API:

- **HTML parse mode was parsed four times** across two consuming projects, each
  with its own subset: one cleaner knew neither links nor custom emoji, one
  splitter cut `<b>…</b>` in half — Telegram then refuses the whole message —
  and every splitter measured the *markup* against 4096, while Telegram counts
  the text *after* parsing. The Bot API's own rules (Formatting options) are
  what none of the copies held completely: formatting may not appear inside
  `pre` or `code`, a quotation never inside a quotation, and links, code, quotes,
  custom emoji and times never contain each other.
- **`setWebhook` takes the bot from whoever held it.** A rehearsal started with
  the production token takes the production bot in one call; a start with the
  production address but another secret would have left production answering
  403 to every update, because Telegram never returns the secret to compare.
- **An update answered only after it was handled** is resent while a long
  handler still runs, and lost for good by a process that answered and died.
- **An operator chat flooded** by one failure repeated, or by a storm of
  different ones.
- **A journal masked by pattern only**: a provider key has no shape.

## Decision

**Markup is a tree.** `parseTelegramHtml` turns any markup into nodes that can
express only what Telegram accepts, and everything else is a walk over them:
`renderTelegramHtml`, `sanitizeTelegramHtml`, `splitTelegramHtml` and
`truncateTelegramHtml` cut by visible text in UTF-16 code units (the unit of
entity offsets, so within the limit however Telegram counts), reopening every
element across a cut with its attributes; `checkTelegramHtml` reports what
Telegram would refuse without repairing it. The parse is lenient because its
input is someone else's text: a tag Telegram does not know loses the tag and
keeps the words. It ships as **`stitchkit/telegram/html`**, peer-free and
browser-safe — a preview and a send must share one parser — apart from
`stitchkit/telegram`, which is server-only because it takes the bot token
(0143). `escapeTelegramHtml` moves there from screens, whose test chat now
refuses markup with the same check.

**A webhook is claimed, not set.** `claimTelegramWebhook` sets it only where it
already points to this address with this secret, or where `takeoverFrom` names
the current owner's host (`'none'` for no webhook — a polling bot is somebody's
bot). The address carries an `owner` tag, an HMAC of the secret, so "this
process" includes the secret without Telegram returning it. Refusals and checks
name hosts only. The takeover is named per start rather than configured once:
left in place it would be a standing permission.

**An update is recorded before Telegram is answered.** `receiveTelegramWebhook`
answers once `createTelegramUpdateIntake` wrote the body; handling runs after,
in chat order, with a renewed lease per attempt and a sweep that takes over
what a restart or a dead process left. Delivery is at least once, and says so.
The intake decides and the store only makes each step atomic on one record
(`TelegramUpdateStore`: add, claim, renew, settle, due, prune), so the bot's
own database can hold it; the reference stores are memory and SQLite over a
handle the application opened — `bun:sqlite` or `node:sqlite` as they are — so
the leaf still imports only `internal` (0201). The intake returns no
`ManagedResource`, for the same reason the operator channel does not.

**The operator channel deduplicates.** `dedupe` sends one message per
fingerprint per window and counts the rest onto the next one sent; a budget per
window turns a storm into one count. Held-back messages are drops like any
other, reported as `repeated` and `over-budget`. The channel still cuts a long
text by characters, which can end inside a tag; `telegramOperatorSender`, the
one place that knows the parse mode, parses HTML again and cuts it by what it
shows, so the message Telegram receives is valid.

**A journal masks exact secrets.** `sensitiveValues` on the sanitiser, the
bounded logger and the JSON journal masks exact values in every string;
`secretValuesFromEnv` collects them by variable name and from inside URLs. The
environment names the secret, so a key added there is masked from its first
line.

**Not taken: reading `forward_origin`.** grammY's `MessageOrigin` is already a
discriminated union with `hidden_user` as its own branch; what a product records
of it is the product's.

## Consequences

- A consuming bot switching to `telegramWebhookUrl` gets a different tag than
  its own former scheme, so its first start after the switch names its own host
  in `takeoverFrom`, once.
- `escapeTelegramHtml` is imported from `stitchkit/telegram/html`, not from
  `stitchkit/telegram/screens`; both were unreleased together.
- An operator channel with `parseMode: 'HTML'` sends markup cleaned by
  `sanitizeTelegramHtml`: a tag Telegram does not know is text, not a refusal.
