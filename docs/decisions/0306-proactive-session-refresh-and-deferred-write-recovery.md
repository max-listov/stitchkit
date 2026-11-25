---
title: "ADR 0306: Proactive session refresh, refresh-endpoint classification and deferred write recovery"
description: Extends createSessionCredentials with opt-in proactive refresh, startup restore discrimination, refresh-endpoint failure classification and post-rotation write retry without introducing a second session coordinator.
type: decision
status: accepted
amends: ["0207"]
created: 2026-11-23
updated: 2026-11-23
---

# ADR 0306 — Proactive session refresh, refresh-endpoint classification and deferred write recovery

Serves **I8**, **I10**, **I12**, **I13**. Amends [ADR 0207](./0207-session-lifetimes-fence-client-work.md).

## Context

Clients using `createSessionCredentials` needed to refresh expiring access tokens before expiry, restore a stored session at startup without wiping a locked keychain, classify failures of the refresh endpoint itself, and avoid repeating a server-side token rotation when local persistence failed or timed out after the server already issued the next token pair. Under ADR 0207, storage errors rejected `refresh()` and no proactive timer or refresh-endpoint classifier existed, pushing offline-first clients to build a parallel session state machine outside the coordinator.

## Decision

`createSessionCredentials` remains the single session coordinator (I8) and gains opt-in proactive refresh and storage recovery:

- **Proactive refresh (`refreshAhead`):** the host supplies `expiresAt(credentials): number | null`, `leadMs` (default 60 s, capped at half the token lifetime) and monotonic `cooldownMs` (default 30 s, capped at half the token lifetime so a token shorter than twice the cooldown is refreshed before it expires; a token with less than a second of half-life keeps the full cooldown, which is what stops a server issuing expired tokens from being asked again at once). Timers step by at most `MAX_TIMER_MS`, cancel on `operation.signal`, re-arm only while `scope.owns(operation)`, and share the generation's single refresh flight with manual `refresh()` and wakeup `refreshIfDue(operation)`. A token with `expiresAt === null` never refreshes proactively or on wakeup.
- **Startup `restore()` and required `storage.read()`:** `storage.read()` is required (`null` → `absent`, thrown error → `unreadable`). On `unreadable`, `restore()` returns the error and never calls `storage.clear()` or `scope.clear()`.
- **Refresh-endpoint failure classification:** `classifyRefreshFailure` defaults to `defaultClassifyRefreshFailure` — numeric `status` `401` or `403` on the **refresh endpoint** is `'rejected'`, everything else is `'unavailable'`; `SessionExpiredError` is never classified. The host may override the classifier. Application-command auth classification and one-shot retries remain with the host, unchanged from ADR 0207.
- **No automatic sign-out on `'rejected'`:** on `'rejected'`, the coordinator stops proactive refresh for that generation, emits `'refresh-rejected'` via `onEvent` and rejects callers with `SessionRefreshRejectedError` (carrying the original `cause`), leaving `scope` and `storage` intact so the host decides between sign-out and offline retention.
- **Post-rotation write recovery:** once `config.refresh` succeeds on the server, memory takes the newly issued credentials immediately. If `storage.write` fails or times out, `refresh()` still resolves with the new credentials, emits `'storage-failed'`, retries persistence every `storageRetryMs` (default 5 s), and refuses to call `config.refresh` again until the unstored rotation flushes. `login()` and `logout()` still reject on storage errors because no server rotation has occurred.
- **Bounded retries and boundaries:** `'unavailable'` refresh retries use `createBackoff(retry)` on monotonic time. Cross-tab and cross-process locking remains the storage contract. Wire/socket-specific credential messages and UI-facing sign-out reasons stay outside the core.

## Consequences

- Offline-first clients delete local refresh schedulers, flight deduplicators and secret-write retry wrappers in favour of `createSessionCredentials`.
- Rotating refresh token families are not revoked by a retry triggered after a local storage write failure.
- Callers of `createSessionCredentials` migrate once to provide `storage.read()` and observe `'storage-failed'` via `onEvent` instead of expecting `refresh()` to reject on post-rotation storage timeouts.
