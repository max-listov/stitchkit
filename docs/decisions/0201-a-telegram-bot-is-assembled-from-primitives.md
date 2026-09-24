---
title: "ADR 0201: A Telegram bot is assembled from primitives"
description: "Updates are admitted by batch at getUpdates; the bot journal is a pino-shaped JSON line through the bounded logger; the operator channel is apart from it; a broadcast is a resumable function that records intent before each send; the telegram leaf still imports only internal."
type: decision
status: accepted
created: 2026-09-24
updated: 2026-09-24
---

# ADR 0201 — A Telegram bot is assembled from primitives

## Context

Three consuming bots were meant to be one pattern and were three: each
assembled its command menu and polling by hand under its own names, only one
held updates back while it was not ready, each had its own journal (a
hand-written ndjson writer that cut the stack, `console.log` strings, pino),
two kept a 250-line operator logger mixed into that journal, two carried a
byte-identical broadcast subsystem with its own refusal phrases, and two read
files from a local Bot API server under two different safety models — one of
them a path join a `file_path` could leave.

The costs had already been paid: updates confirmed to Telegram while the
application refused them, lost on every restart; a production startup failure
journaled as `"error":{}`; three reactions to one dead poller.

## Decision

**Updates are admitted by batch, at the call that moves the offset.** grammY
confirms a batch by asking for the next one. `grammyPollingResource` installs
one transformer on `getUpdates`: it waits for admission before a long poll,
returns a non-empty batch only while holding one admission lease for it, and
releases that lease at the next `getUpdates`, which grammY sends only after
handling the batch sequentially. No middleware, so no dependence on where in
the chain it was registered. Shutdown finishes the batch in hand before
`bot.stop()` confirms the offset. For this the resource context carries the
application's admission (`context.admission`, with `acquireWhenAccepting`): a
resource that fetches work should not fetch, and reaching the handle through a
closure over a later-assigned variable is the shape it replaces.

**A poller that ended is reported, not handled.** grammY's poller does not
recover in-process and the framework does not exit processes (0074). `onEnded`
is called once, a macrotask after the kernel recorded the end as `completion`;
the bot template turns it into the same bounded shutdown a signal starts and a
non-zero exit.

**The bot journal is `createJsonLogger`** in `stitchkit/observability`: pino's
line — numeric `level`, epoch `time`, `msg` — so existing readers keep
working, written through `createBoundedLogger`, so an `Error` under any key
keeps name, message, stack and cause, and secrets are masked. Recommending pino
itself was rejected: its error serialisation depends on the key name, which is
the defect that happened. The error contract is `level >= 50`.

**The operator channel is not the journal.** Opposite guarantees: the journal
must not lose a line, the chat must not slow the bot. `post` never blocks or
throws; the queue is bounded and drops the oldest, reporting every drop.

**A broadcast is a function with an end, resumable by name.** The audience is
written once; progress is an append-only journal with a line before each send
and one after — the rule of 0200, specialised rather than reused. `effect`
settles an intent by asking the recipient; Telegram offers no such question, so
every unsettled intent would be `uncertain` anyway, and a broadcast's unit is a
recipient in a list of thousands, not a named step of one run. A recipient
found `sending` is recorded `uncertain` and never sent again. A refusal of the
message itself halts the run without charging the recipient.

**The `telegram` leaf still imports only `internal`.** The operator channel
exposes `drain(signal)` and `close()` and the local-files helper `check()`;
an application wraps them in a resource in three lines. Returning
`ManagedResource` from the leaf would make a Mini App backend that only
verifies `initData` depend on the kernel — the reason 0143 kept the leaf apart.

**429 on a bot's own replies stays the application's**, with grammY's retry
plugin; polling, the broadcast and the operator channel wait Telegram's
`retry_after` themselves.

## Consequences

- One template (`--template telegram-bot`) is the pattern the bots become
  instances of; their `index.ts` and `application.ts` differ only in product
  resources.
- `ManagedResourceContext.admission` is required: a context built by hand in
  a test adds it (a breaking change to an evolving entrypoint).
- A local Bot API server with `--local` answers `getFile` with an absolute
  path; it resolves when it lies inside the bot's directory and is refused
  otherwise, judged on real paths.
