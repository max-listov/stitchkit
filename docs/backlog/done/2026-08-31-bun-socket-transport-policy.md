---
title: Enforce the declared Socket.IO transport policy on Bun
description: Enforce the declared transport allowlist through the Bun engine request-policy boundary.
type: task
status: done
created: 2026-08-31
updated: 2026-08-31
completed: 2026-08-31 04:18 +00:00
---

## Problem

In the published 0.70.2–0.70.3 adapter, createSocketIOServer computes transports and passes it to Socket.IO, but the Bun engine does not enforce that list. Socket.IO does not create that engine, so a websocket-only configuration still admits Engine.IO polling.

Evidence: packages/core/src/server/socket-io.ts, transports declaration, io options and the separate engineOpts object. Other Engine.IO options are forwarded there explicitly.

## Result

- Honor transports on Bun and Node consistently.
- Real HTTP polling handshake is refused when transports is ['websocket']; real websocket connection and acknowledged requests still succeed.
- Both transports work when both are explicitly enabled.
- Cover the packed public adapter, document the behavior and publish a patch.

## Validated scope and plan

The omission is present in `0.70.3` too. The proposed direct option forwarding is not supported:
`@socket.io/bun-engine@0.1.1` exposes no `transports` option and verifies against a hardcoded list.
Its public `allowRequest` extension runs before both new handshakes and existing-session requests,
including upgrades. Enforce the wrapper's allowlist there, before consumer authorization, without
patching the dependency, changing runtime defaults or adding a competing transport engine.
Node retains its native Engine.IO transport enforcement. Unknown transports remain engine errors;
CORS preflight remains separate from transport admission. Bun's native upgrade hints are not a
policy guarantee: denied candidates must not establish a connection.

- [x] Reproduce websocket-only polling admission before changing implementation: real handshake
      returned HTTP 200 where the regression expected refusal.
- [x] Enforce the same configured allowlist at the actual Bun request boundary, before consumer policy.
- [x] Verify websocket-only, polling-only and mixed transport success/refusal through real peers,
      including denied upgrades and consumer-policy composition.
- [x] Exercise the public packed adapter on Bun and Node through packed consumer coverage.
- [x] Document defaults and admission semantics; prepare core `0.70.4` in `release-train.json`.
      Final publication acceptance is transferred to that train, not claimed by implementation closure.

## Что сделано

- [x] `packages/core/src/server/socket-io.ts`: enforce the configured transport in the engine's
      request-policy extension. `packages/core/src/server/socket-io-config.ts` and
      `docs/guide/realtime.md` state the exact admission semantics and unchanged runtime defaults.
- [x] `packages/core/tests/socket-io-transport-policy.test.ts`:
      `Bun websocket-only policy rejects a real polling handshake before consumer authorization`
      covers the fail-first reproduction, no allocated session, CORS and preserved preflight;
      `Bun admits only <transports> while retaining acknowledgements and consumer policy` covers
      all three policies and both actual Socket.IO client transports;
      `Bun polling-only policy denies an existing-session websocket upgrade and keeps polling usable`
      proves an existing SID cannot bypass admission.
- [x] `packages/core/scripts/consumer-lane/fixtures/socket/transport-policy.mjs`: packed public
      adapters start real Bun/Node servers, reject disabled transports and preserve acknowledgements
      and consumer authorization. It runs in the existing self-contained Socket.IO consumer
      fixture, sharing its installation rather than adding another heavy release lane.
- [x] Core typecheck/build, focused tests and the packed Socket.IO proof passed. No dependency fork,
      private consumer change, alternate engine, new option or compatibility alias was introduced.

## Release acceptance

The local packed `0.70.4` archive is a candidate, not evidence of publication. The coordinated core
train must pass `verify --release`, green exact-SHA push CI and immutable tag publication; compare
the registry tarball to that CI artifact, then repeat `transport-policy.mjs` on Bun and Node before
reporting the release complete. Version, SHA and integrity belong to that verified release result.
