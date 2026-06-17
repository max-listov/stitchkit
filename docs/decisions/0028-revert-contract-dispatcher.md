---
title: "ADR 0028 — Revert createContractDispatcher (no adopting consumer)"
type: decision
status: accepted
created: 2026-06-17
updated: 2026-06-17
---

# ADR 0028 — Revert `createContractDispatcher` (no adopting consumer)

- **Status:** Accepted — supersedes the `createContractDispatcher` portion of
  [ADR 0027](0027-transport-neutral-contract-execution.md). The rest of ADR 0027
  (`idempotent`, `createRetainedTopics`, the open `TransportSource` union) stays
  Accepted.
- **Date:** 2026-06-17

## Context

[ADR 0027](0027-transport-neutral-contract-execution.md) shipped
`createContractDispatcher` in 0.9.0 — a contract-shaped wrapper over the internal
`executeToolMethod`, so a bring-your-own transport (a raw-WebSocket lane, an IPC
channel, a queue worker) could run a `defineContract` method without a hand-rolled
method registry. It was built for one requesting consumer (a desktop app's
webview ↔ local-sidecar raw-WebSocket lane).

On real integration that consumer **did not adopt it**, and reported why:

- Their boundary already had a ~39-line executor (parse-in → run → parse-out) with
  distributed method registration — the registry the dispatcher removes was tiny.
- The one benefit they wanted — the typed `{ ok, code, … }` envelope — they got
  directly by threading `code` through their own WebSocket envelope (~10 lines).
- Migrating *to* the dispatcher meant rewriting their flat runtime schema map into
  a `defineContract` (each endpoint needs `method` / `path` / `desc`), a net **+90
  to +110 lines** — more code, for "one mental model" they did not need.

So for the **only** consumer it was built for — and exactly the case it was
designed for (raw-WS webview ↔ sidecar) — the dispatcher was net-negative. No
other consumer uses it. Its evidence base is now zero.

## Decision

Remove `createContractDispatcher` (and the `ContractDispatcher` /
`ContractDispatcherConfig` types) from `stitchkit/tools`. The execution core
(`executeToolMethod`) stays internal, exactly where it was before 0.9.0 — the MCP
and agent mounts still use it; only the public BYO-transport wrapper is withdrawn.

This upholds the project's own bar (ROADMAP / [ADR 0027](0027-transport-neutral-contract-execution.md)
itself): public surface comes from **real usage, not speculation**. Carrying an
export that the sole requesting consumer rejected — "just in case" — is the
speculation the pre-1.0 process exists to avoid. The capability is trivially
re-exposable from `executeToolMethod` if a genuine second consumer (an IPC channel
or queue worker — *not* the webview↔sidecar case, which was tried) proves the need
on evidence.

**Kept from 0.9.0 / ADR 0027** — these are in use or harmless and unchanged:

- **`idempotent`** on an endpoint — a transport-neutral hint, in use.
- **`createRetainedTopics`** — sticky events, in production use.
- **`MultipartFile` / `FileDescriptor`** — React Native upload, in production use.
- **`TransportSource` open union** (`| (string & {})`) — a one-line type widening
  with no runtime; a consumer running its own transport via `rawRoutes` still
  legitimately tags `ctx.source`. Reverting it would be churn with no benefit.

## Alternatives considered

- **Keep it "just in case."** Rejected — it is known-unused public API on the road
  to 1.0, where "every export is proven" is the goal. Keeping a dead export is
  worse for 1.0 credibility than a documented, one-time breaking removal; pre-1.0
  breaking changes are allowed when not silent, and the caret range protects every
  consumer except the one who never used it.
- **Also revert `TransportSource` open / `idempotent`.** Rejected — both are
  harmless, additive, and independently reasonable for any BYO transport (not only
  the dispatcher). Only the dispatcher had no adopter.

## Consequences

- **Breaking change** (removed public export) — led in the CHANGELOG with a
  `### ⚠️ Breaking changes` section, shipped under a minor bump (0.10.0). A
  consumer that adopted `createContractDispatcher` runs the contract method
  itself: validate the frame against the contract's Zod schemas and call the
  handler (the ~40-line executor the requesting consumer already had).
- **Leaner core toward 1.0.** No unused transport surface to keep stable, tested
  and documented.
- **Reversible on evidence.** `executeToolMethod` is unchanged; a future ADR can
  re-expose a BYO executor when a real, different consumer needs it.
