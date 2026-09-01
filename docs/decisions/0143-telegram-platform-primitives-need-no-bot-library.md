---
title: "ADR 0143: Telegram platform primitives need no bot library"
description: Why Mini App authentication and Bot API failure classification ship as `stitchkit/telegram` rather than inside the grammY adapter or the generic server core.
type: decision
status: accepted
created: 2026-09-01
updated: 2026-09-01
---

# ADR 0143 — Telegram platform primitives need no bot library

## Context

Two things kept being written by hand across consuming applications:

- **Mini App `initData` verification.** Three copies in three backends, two of
  them clearly sharing an ancestor and since drifted. The algorithm is short and
  published, which is exactly why it is rewritten — and why *almost* right is
  the normal outcome: a comparison that returns on the first differing byte, an
  expiry checked before the signature, `initDataUnsafe` read straight into a
  session.
- **Bot API send-failure classification.** Two applications share a broadcast
  subsystem — three of its files byte-identical — and inside it one list of
  substrings deciding both whether to retry the send and whether to stop
  addressing the recipient. Those are two questions, and one list cannot answer
  both: a message Telegram refused to parse is our payload's fault and gets
  counted against the user.

Neither is a domain model (→ ADR 0002). "Telegram signed this string" is a fact
about a transport, the same kind of fact as a well-formed bearer token; "the Bot
API answered 403 with this description" is a fact about a provider.

## Decision

Both ship from a new server-only entrypoint, **`stitchkit/telegram`**, declared
**evolving**, holding `verifyTelegramInitData` and `classifyTelegramSendFailure`
and depending on no peer.

Three homes were possible and two were wrong:

- **`stitchkit/application/grammy`** — it is the existing Telegram leaf, but it
  throws at import unless the grammY peer is installed, and it returns
  `ManagedResource`. A backend that only wants to authenticate a Mini App
  request would take on a bot library and the application kernel to get an HMAC.
- **`stitchkit/server`** — where authenticating a request belongs, but the core
  stays generic (→ ADR 0002) and a platform name in it is the first exception.
- **`stitchkit/telegram`** — a *platform* leaf beside the existing *library*
  leaf. `application/grammy` adapts a library's lifecycle; this adapts the
  platform's own published protocols, which grammY does not own and which a
  caller using no bot library at all still faces.

Two constraints hold the boundary:

- **Server-only, and deliberately.** `verifyTelegramInitData` takes the bot
  token; the module is not published for the browser, so there is no import a
  frontend can reach for and no shape in which the token looks browser-safe. A
  Mini App frontend keeps reading `initDataUnsafe` from Telegram's own SDK — the
  name is the warning, and answering it is the backend's job.
- **No UI.** The copied `useTMA` hooks in consuming frontends are not in scope
  and will not be: frontend infrastructure stays outside the framework.

## Consequences

- One more published entrypoint, one more maturity row, no new dependency.
- `verifyTelegramInitData` refuses with a **reason** rather than a boolean or a
  thrown error — `missing-hash`, `signature-mismatch`, `malformed`, `expired` —
  because an application answers a stale string differently from a forged one,
  and the phrasing stays with the application (→ ADR 0141).
- `classifyTelegramSendFailure` reports `retryable` and `recipientUnreachable`
  separately, and asserts the second only for the reasons that establish it. An
  unrecognised refusal leaves a recipient reachable: dropping a working
  subscriber forever costs more than one wasted send.
- The signature check is verified against a **different** crypto implementation
  in tests (`node:crypto` against the module's Web Crypto), so the two stacks
  agreeing is the assertion rather than the module agreeing with itself.
- If Telegram adds third-party (Ed25519 `signature`) validation to the set of
  things consumers hand-write, it goes here; nothing about this decision has to
  be revisited to add it.
