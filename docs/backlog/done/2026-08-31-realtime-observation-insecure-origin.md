---
title: Realtime request diagnostics must not require a secure browser context
description: Enabling request phase observation must not make working acknowledged requests fail on an HTTP origin.
type: task
status: done
created: 2026-08-31
updated: 2026-08-31
completed: 2026-08-31 04:18 +00:00
---

## Problem

packages/core/src/browser/socket-io.ts creates the request trace in emitWithAck using crypto.randomUUID() whenever onRequestPhase or per-request onPhase is present. In a browser on a non-localhost HTTP origin, randomUUID is unavailable; diagnostics therefore throw before sending an otherwise valid request. The same request works with observation disabled.

Confirmed in published 0.70.2–0.70.3. This identifier correlates diagnostics; it is not a security credential.

## Result

- Optional observation must not change acknowledged request semantics or require HTTPS.
- Generate a suitable diagnostic identity through an environment-compatible mechanism.
- Regression with crypto.randomUUID unavailable covers both observer entry points, success, timeout and disconnect; no dangling request traces.
- Document the supported environments and publish a patch.

## Validated scope and plan

The direct `crypto.randomUUID()` call is also present in `0.70.3`. Request identity is an opaque
diagnostic string, not a UUID contract, a credential or a wire field. Reuse the existing
`crypto.getRandomValues` random-hex generator through a browser-safe internal leaf; do not import
the server observability barrel, add a second ID algorithm or change security-sensitive IDs.
Generate only on the observed path; correlation, terminal cleanup and observer isolation stay
with the existing request trace lifecycle. No public API or capability requirement changes.

- [x] Reproduce observed request failure with `randomUUID` absent and an unobserved control:
      control acknowledged successfully; observation threw `crypto.randomUUID is not a function`.
- [x] Share the existing browser-compatible random-hex generator without changing trace IDs.
- [x] Cover client-wide/request-local observers, simultaneous clients/requests, success, timeout,
      disconnect, late acknowledgement and subsequent requests with no dangling phase identities.
- [x] Verify the real browser path on a non-trustworthy HTTP origin (not localhost), including
      both observer entry points and terminal behavior.
- [x] Document environment/opaque-ID semantics and include packed regression in the `0.70.4` core
      train. Final registry acceptance remains with `release-train.json`, not waived by task closure.

## Что сделано

- [x] `packages/core/src/internal/random-hex.ts` holds the existing random-byte algorithm;
      `packages/core/src/observability/trace.ts` and `packages/core/src/browser/socket-io.ts` share it.
      The request observer allocates a 16-byte opaque identity only when observation is enabled.
      W3C trace/span shapes and security-sensitive identifiers remain unchanged.
- [x] `packages/core/tests/realtime-observation-crypto.test.ts`:
      `request observation succeeds without randomUUID after an unobserved control` proves the
      regression; `<scope> observation without randomUUID preserves terminal identity across
      timeout, disconnect and reconnect` covers client/request observers, concurrent replies,
      late ACK suppression, disconnected calls and an explicit disconnect/connect cycle.
- [x] `packages/core/scripts/consumer-lane/fixtures/socket/observation.mjs` is a shared real-peer
      scenario, and `observation-runtime.mjs` runs it against the packed public API with
      `randomUUID` absent on Bun and Node. Two simultaneous clients retain 12 distinct request IDs
      and exactly one terminal phase per invocation. The existing packed Socket.IO fixture runs it.
- [x] `packages/core/scripts/consumer-lane/fixtures/socket/browser-peer.mjs` serves the same browser
      scenario. Chromium on a non-loopback HTTP origin reported `isSecureContext: false`,
      `typeof crypto.randomUUID: undefined`, `typeof crypto.getRandomValues: function` without
      overriding the browser crypto API. Each observer mode passed 6 requests / 14 phases; all 12
      IDs differed. The only initial console error was an unrelated favicon request in the test
      page; the peer now supplies an inline icon.
- [x] Core typecheck/build, related Socket.IO/handshake/trace tests and the focused packed proof
      passed. `docs/guide/realtime.md`, schema comments and `CHANGELOG.md` document environment and
      identity semantics. No HTTPS requirement, public shape change or consumer workaround.

## Release acceptance

Core `0.70.4` must pass the final release gate and exact-SHA CI. Publish the CI tarball unchanged,
compare the registry archive and integrity, and rerun the packed Bun/Node and actual HTTP-browser
scenario from the registry install before claiming completion. The browser peer is disposable and
must be stopped after acceptance; no consumer deployment is part of this task.
