---
title: "ADR 0274: A Telegram token has one outbound budget"
description: A bot token's sends share one strict process-local budget, weighted by the messages a call produces; a 429 pauses the token, and the primitive never retries an unknown outcome.
type: decision
status: accepted
created: 2026-10-30
updated: 2026-10-31
---

# ADR 0274 — A Telegram token has one outbound budget

## Context

Telegram counts a bot's bulk messages per token. A bot sends through several
paths: a marketing campaign, a reply in a handler, an operator note, a retry
after a rate limit. Each path can be paced below the limit on its own and the
sum can still be over it, so the limit has to be counted once for the token.

Two ways of counting existed in consuming applications. One kept a token bucket
per token with a full initial bucket and a refill: it released a saved burst at
start and again after a 429 pause, which is exactly when the next message is
most expensive. The other paced one broadcast run at a fixed rate and left every
other sender alone. Neither expressed the unit that Telegram counts — an album
of N media is N messages, a `copyMessages` of N ids is N messages, and the call
to action after an album is one more.

The primitive is provider-specific: the budget belongs to a Telegram token, the
cost belongs to Bot API methods, and the pause comes from Telegram's
`parameters.retry_after`. It is not a durable job queue and not a cross-process
lock. This ADR replaces only the token-wide part of ADR 0201's position that a
429 on a bot's own replies stays the application's; the application still owns
the retry policy and the wording a person reads.

## Decision

**`stitchkit/telegram` owns one outbound budget per bot token.** A
`telegramOutboundBudget({ token, messagesPerSecond })` returns one object for
that token in the process. A second call for the same token returns the same
object; a call with different options is refused, because two policies for one
credential is the defect this exists to prevent. Another token is another
budget. The registry keeps a 128-bit identity of the token from the existing
`argumentsDigest`, never the credential; `stats()` and every refusal are
token-free.

**The schedule is strict, not a bucket with a burst.** The first call after idle
is immediate; after that each call occupies `cost / messagesPerSecond` of the
timeline. The budget keeps one `nextGrantAt` and one `pausedUntil`:

```text
at = max(now, nextGrantAt, pausedUntil)
grant head at at
nextGrantAt = at + cost * 1000 / messagesPerSecond
```

A classic bucket with capacity 24 would release 24 saved messages at start and
again on resume. That is the stampede a shared budget exists to prevent, so the
burst is one and the sustained rate is the declared rate. An album is weighted,
not one: `sendMediaGroup` and `sendPaidMedia` cost their media length,
`copyMessages` and `forwardMessages` cost their ids, and every other
message-producing method costs one. A non-message method (`getMe`, `getFile`,
an edit, a delete) costs nothing.

**A 429 pauses every sender of the token.** The pause is
`max(pausedUntil, now + retry_after)`; a second, shorter instruction never
shortens it. Telegram's number is used when present; when it is absent the
caller's declared `retryAfterFallbackMs` is a local policy, not a provider fact.
After the pause the next grant is at the deadline and the following one is one
interval later — the queue is not released as a batch. `waitUntilResumed` lets
an edit or delete retry share the pause without taking a message slot.

**The primitive paces; it does not retry.** `budget.run(method, payload, signal,
send)` is the narrow adapter a client transformer calls around its existing
send. It waits for the weighted slot, checks the signal, calls `send` once, and
rethrows. A 429 pauses and is rethrown. A network failure or a 5xx is rethrown
unchanged and does not pause the token: repeating a send whose external outcome
is unknown is the caller's decision, and a primitive that retried it would turn
one unknown message into two. A cancelled waiter leaves the queue without
spending a slot and without calling the provider. A granted call whose send is
then aborted owns its slot; the outcome is unknown, not a definite failure.

**The budget is process-local.** It does not coordinate two processes or two
machines that hold the same token. That is the application's deployment
boundary, and pretending otherwise would be a second distributed lock. The
primitive also owns no job state: a resumable broadcast keeps its own journal
and per-run pacing; the operator channel keeps its per-chat pacing. Those are
caps of their own jobs, not a second token quota. A product that uses one of
those senders wraps its `send` with the same `budget.run`, and removes its old
limiter rather than running both.

## Alternatives

- **Keep pacing in each product.** Rejected: the limit is per token, so each
  product either duplicates the arithmetic or gets the sum wrong. A product that
  shares its token with a campaign is the ordinary case, not an edge.
- **A generic rate limiter in the core.** Rejected: the unit is a Telegram
  message, the pause field is `retry_after`, and the weighted methods are the
  Bot API's. A provider-neutral limiter would push the only interesting part
  back into every caller.
- **A cross-process budget in Redis or a database.** Rejected for this
  primitive: it is a second distributed coordination mechanism, and the
  deployment that needs it already owns a durable queue. The SDK states the
  process-local boundary instead.
- **A full token bucket with capacity 24.** Rejected: it produces the initial
  burst and the post-429 stampede the shared budget is meant to remove. A
  caller that wants a small burst can build it above this primitive, where the
  policy is visible.

## Consequences

- A product's one Bot API client installs one transformer; the old limiter and
  its retry are deleted in the same cutover. The standard senders remain
  per-run/per-chat paced; wrapping their `send` is the documented way to share
  the token budget.
- `telegramOutboundBudget` is an evolving `stitchkit/telegram` export. The
  five consuming products migrate in their own release waves after the SDK
  publication; this repository does not claim their cutover.
- `USER_BOT_TO_BOT_DISABLED` becomes `bot-to-bot-disabled`: permanent for the
  send, not recipient-unreachable, because Telegram reports it when either bot
  has not enabled Bot to Bot messaging. The new union member is a breaking
  change for exhaustive consumer tables and carries the usual migration.
- `stats()` reports granted calls, weighted messages, queue depth and the
  remaining pause. It is diagnostic, not a billing or delivery receipt.
- Cross-process budgets, durable campaign state and the retry policy stay
  outside this primitive.

Serves **I8** (one owner for the token's outbound budget), **I9** (every
declared option is load-bearing), **I10** (finite waits and a bounded queue at
the provider boundary), **I13** (only observed facts: no invented wait, no
unknown outcome retried as a definite failure) and **I14** (the new reason is a
marked, migrated break).

## Amendment (0.114.1): a refusal arrives as a response, and grammY's wiring is one transformer

The first release read a 429 only from the exception `send()` threw. A grammY
client transformer never sees one: `callApi` receives the Bot API's
`{ ok: false, error_code: 429, parameters: { retry_after } }` as the **value**
the transformer chain returns and builds the `GrammyError` after the chain has
finished. The documented wiring therefore paced and never paused, and the
tests, which threw an error from `send`, could not tell. A consuming project
measured it: the first send got a 429 with `retry_after: 2` and the next send,
to another chat, left 40 ms later.

- **`run` reads both shapes.** A `send` that resolves with a record whose `ok` is
  `false` is classified exactly as a thrown refusal is: a rate limit pauses the
  token for the stated `retry_after` or the declared fallback, any other answer
  does nothing, and the response is returned unchanged. The mechanism is fixed in
  the one owner, so every client already wired through `run` is repaired without
  a change of its own.
- **The grammY wiring is one function, in its own entrypoint.**
  `stitchkit/telegram/grammy` exports `telegramBudgetTransformer(budget)`. The
  type that grammY gives a transformer (`Transformer`) names its response per
  method, which a structural type cannot express without a cast at the call
  site; naming it in `stitchkit/telegram` would make that peer-free entrypoint
  depend on `grammy`. The new entrypoint follows `stitchkit/telegram/screens`:
  grammY in the declarations, never imported at run time.
- **A cancelled wait is a request that never left.** grammY types the signal it
  passes a transformer as the `abort-controller` polyfill's, so a hand-written
  closure passed `undefined` and a send cancelled in the queue waited for its
  slot and failed as `unknown`. The transformer bridges the signal and throws
  `TelegramNotDispatchedError` when the cancellation arrives before the request
  was handed to the client — in the queue, or in the instant after the grant,
  when the slot is spent and nothing was sent. A cancellation after the request
  was handed on stays the client's own error and the outcome stays unknown.
  `run` itself still rejects with `signal.reason`: that contract is unchanged.

The test that pins this uses grammY's own `Api` over a `fetch` that answers 429
the way Telegram does. A test that throws from `send` proved only the path
nobody takes.
