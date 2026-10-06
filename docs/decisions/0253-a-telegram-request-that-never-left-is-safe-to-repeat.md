---
title: "ADR 0253: A Telegram request that never left is safe to repeat"
description: "stitchkit/telegram owns a Bot API transport that connects before it writes; a failure before the first byte is TelegramNotDispatchedError, classified not-dispatched and retryable, while every later failure stays an unknown outcome."
type: decision
status: accepted
created: 2026-10-06
updated: 2026-10-06
---

# ADR 0253 — A Telegram request that never left is safe to repeat

**Invariants:** I8, I13, I14. Builds on ADR 0141, ADR 0143.

## Context

The Bot API senders of `stitchkit/telegram` call `fetch`. `fetch` folds establishing the
connection and waiting for the answer into one failure, and from that failure nobody can say
whether Telegram saw the message. So the senders treat every network failure without a status as
unknown: a broadcast records the recipient `uncertain` and halts, the operator channel drops the
message. That is the right answer for a request that may have arrived — a repeat could duplicate
it — and the wrong one for a request that never left. A consuming project measured a route on
which, about one attempt in fifteen, no connection was established at all for eight seconds; each
such attempt lost an alert that had never been sent. It wrote its own transport to tell the two
apart, and every other sender of notifications needs the same distinction.

## Decision

1. **The outcome of a send has three values, separated at the transport.** `createTelegramBotTransport`
   resolves the host, races its addresses (Happy Eyeballs, RFC 8305) and writes the request only on an
   established connection. Until the first byte is written, every failure — lookup, connection, an
   unreadable body — is `TelegramNotDispatchedError` with its `stage`: the request certainly did not
   leave. After that, a failure is an ordinary error: the request may have arrived, and its outcome is
   unknown. A received answer is Telegram's own word, as before.
2. **Classification reads the transport's word first.** `classifyTelegramSendFailure` returns the new
   reason `not-dispatched` — `retryable`, not `recipientUnreachable`, `evidence: 'transport'` — for that
   error anywhere in a cause chain. A broadcast retries it as `transient`; the operator channel sends it
   again. Everything else keeps its classification, and a failure without status or answer stays
   `unknown`, never retried.
3. **The transport is opt-in, through the existing `fetch` seam.** Every sender takes `fetch: TelegramFetch`,
   `(url, init) => Promise<Response>`; the global `fetch` stays the default, because it honours proxies
   and the transport does not. `callTelegramBotApi` passes `TelegramNotDispatchedError` through unchanged
   (its message carries no URL, so no token).
4. **Every wait is bounded.** The address lookup and the connection rounds stop at `connectBudgetMs`, the
   answer must arrive within `responseTimeoutMs` and fit `maxResponseBytes`; a caller's signal rejects
   with its reason at any stage. The read of a request body the caller streams is bounded by that
   signal alone: how long a body may take is the caller's to say.

## Rejected alternatives

- **Leave the transport with each consumer and document the boundary.** The distinction is a property
  of every sender, not of one project; the second copy would be written by the next project that loses
  an alert.
- **Infer "not sent" from `fetch` error codes** (`ECONNREFUSED`, DNS errors). The runtimes do not
  expose them consistently, and a connect timeout and a lost answer arrive as the same `TypeError`.
- **Make the transport the default.** It would silently stop honouring a proxy a deployment relies on.

## Consequences

- `TelegramSendFailureReason` gains `not-dispatched` and `TelegramSendFailure.evidence` gains
  `transport`: a breaking change for an exhaustive `switch` or `Record` over them in this evolving
  entrypoint, migrated in `docs/guide/upgrading.md`.
- `tests/telegram-transport.test.ts` drives a real local socket: a refused connection is not
  dispatched and a broadcast retries it; a connection dropped after the request was written stays
  `unknown` and `ambiguous`; a silent first address loses the race; answers past the size or time
  limit are unknown outcomes.
