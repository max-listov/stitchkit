---
title: "ADR 0214: A store contract ships with its check, and secrets are masked by shape"
description: "A contract an application implements over its own database ships with a framework-free check of its rules that the shipped implementations pass too; the webhook update store gains a Postgres implementation over one query function; redact masks secrets by shape and keeps an error's own fields; one Telegram user type for every source."
type: decision
status: accepted
created: 2026-09-29
updated: 2026-09-29
---

# ADR 0214 — A store contract ships with its check, and secrets are masked by shape

## Context

The first consuming bot moved onto the primitives of ADR 0213 and reported
where it still had to build, switch off or work around them:

- **The update store was written again, over Prisma**, about 150 lines with a
  raw `UPDATE … RETURNING` for the claim. `TelegramUpdateStore` is five
  conditional statements, and each is easy to write almost right: a claim read
  and then written in two statements passes every test with one process and
  runs one update twice in production. The interface said what the rules were;
  nothing let an implementation outside this repository show it kept them.
- **A retry policy saw grammY's wrapper.** `bot.handleUpdate` throws a
  `BotError` around what the middleware threw, so a policy asking "is this my
  terminal error?" never matched and retried it.
- **The dedupe window was reachable only through the channel**, switched off
  with parameters around it by a bot that sends alerts itself.
- **The journal leaked by shape.** Measured on `createJsonLogger`: a bot token
  in a request URL, a password in a database address and a `?token=` were
  written as they were — no key name marks a URL — and an error's own fields,
  a `TelegramBotApiError`'s `error_code` and `retry_after`, were dropped. The
  bot masked tokens itself by rebuilding the exported pattern as global. The
  report asked for a pino-compatible mode; the line already is pino's shape,
  and the bot's readers match only `msg` and fields, so a second line format
  would have answered the wrong question.
- **A user arrived in two conventions**: camelCase from initData, snake_case
  from `ctx.from`, and one `ensureAccount` needed a translator.

## Decision

**A contract an application implements ships with its check.**
`checkTelegramUpdateStore(make)` runs every rule on a fresh store, races eight
claims against each other, and resolves with the violations. It depends on no
test framework, so an application calls it from its own tests; the memory,
SQLite and Postgres stores pass the same check in this repository, and a
deliberately careless store is shown to fail it. `postgresTelegramUpdateStore`
takes one `query(text, parameters)` returning rows — Bun, Prisma and `pg` each
give it in one line — every statement conditional and returning rows, with
explicit casts, because drivers disagree on how a number is sent and how a
`bigint` comes back. It runs against a real server in the `test:postgres-stores`
lane, beside the agent store.

**The intake hands the handler's own error on.** A `BotError`, recognised by
shape without importing grammY, is unwrapped before `retry`, `onFailure` and
the stored error see it.

**A piece a primitive is built from is exported when a consumer needs it
alone.** `createTelegramOperatorDedupe` is the window the channel uses, not a
copy of it.

**Secrets are masked by shape in `redact`, for every sink.** The secret half of
a bot token — the bot's id stays, it is public and tells two bots apart — the
password of an address, and a query parameter named as a secret. An error keeps
its own fields, masked by the same rules; a class instance held by one (grammY's
`BotError.ctx`) is named, not written, so an error cannot push its line past the
bound and lose its stack. `TELEGRAM_BOT_TOKEN_PATTERN` now matches the secret
half, so any masking done with it keeps the id too.

**One user type.** `TelegramUser` is what initData returns and what
`parseTelegramUser` makes of a Bot API user.

## Consequences

- A store written over another ORM is checked by the same rules as the shipped
  ones; a new rule in the contract reaches every implementation's tests.
- A value that merely looks like a secret by shape is masked — `?key=` in a URL
  that was a lookup key — a loss judged smaller than a leaked credential.
- `TelegramInitDataUser` is renamed and the token pattern narrowed: a minor
  release with migration notes.

## Not done

- A second journal line format. The line is pino's; a consumer's own format is
  its readers' concern.
- A Prisma model shipped with the store. The table is plain SQL any migration
  tool takes; `postgresTelegramUpdateStoreSchema` gives it.
