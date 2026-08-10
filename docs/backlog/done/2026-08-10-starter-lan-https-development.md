---
title: Optional trusted LAN HTTPS development preset
description: Provide an explicit secure-context dev mode for testing the generated frontend and API from phones and physical devices on the local network.
type: task
status: done
created: 2026-08-10
updated: 2026-08-10
completed: 2026-08-10 13:39 +07:00
---

## Зачем

Microphone, camera, PWA, WebRTC and device integrations require a trusted secure
context on a real phone; `localhost` on the development machine is insufficient.
Each device-oriented consumer otherwise rebuilds local certificate, LAN address,
Next/API TLS and installation instructions independently. This belongs in the
optional starter tooling, not the Stitchkit core runtime.

## Результат

`bun run dev:lan` starts the same generated application over trusted LAN HTTPS with
stable local certificate material and clear device onboarding, while ordinary
`bun run dev` remains unchanged.

## План

- [x] Research and select one maintained cross-platform local-CA tool rather than implementing certificate signing in application code.
- [x] Add an explicit `dev:lan` command with optional host selection; auto-select only when exactly one usable private LAN address exists and fail on ambiguity.
- [x] Store CA/private certificate state outside committed template files, persist it across runs and never expose private key material through HTTP.
- [x] Configure both Next and the Stitchkit API for the same trusted HTTPS origin model, including Socket.IO and browser client URLs.
- [x] Provide the public root certificate and concise iOS/Android trust instructions through a development-only onboarding surface.
- [x] Keep all LAN behavior disabled in normal development, production builds and generated deployments.
- [x] Add fail-first diagnostics for missing tooling, untrusted certificate, address changes, occupied ports and unsupported platforms.
- [x] Add integration coverage for URL/config generation and a browser secure-context smoke; document the physical-device trust step separately.

## Acceptance

- [x] A phone on the same LAN can open the generated app via HTTPS and use secure-context browser APIs; the physical trust step is documented for manual execution because this server has no paired mobile device.
- [x] Frontend HTTP, MCP and Socket.IO calls stay same-origin or use an exact generated allowlist; no wildcard CORS is introduced.
- [x] Re-running the command preserves the local CA and renews leaf certificates when the selected address changes.
- [x] Private keys, generated certificates and machine-specific addresses cannot enter the scaffold package or git output.
- [x] `bun run dev` and production behavior remain byte-for-byte independent of the optional preset.
- [x] The feature lives in `create-stitchkit`; Stitchkit core gains no LAN or certificate policy.

## Что сделано

- [x] Tooling: `packages/create-stitchkit/template/scripts/dev-lan.ts` implements explicit mkcert-based LAN HTTPS with deterministic host selection and fail-first diagnostics.
- [x] Security: certificate state is gitignored, private keys are never served, and CORS uses an exact generated origin.
- [x] Onboarding: the development-only backend route and `packages/create-stitchkit/template/docs/LAN_HTTPS.md` explain root-CA trust for iOS and Android.
- [x] Tests: `packages/create-stitchkit/template/scripts/dev-lan.test.ts` covers host/config/port behavior; packed lanes cover normal-mode isolation.
- [x] Manual boundary: no physical phone was attached to this server; device trust remains the documented one-time user step.
