---
title: "ADR 0307: A handler runs without Node built-ins, and a bridge carries Requests and Responses"
description: Portable createHandler lives on browser-safe stitchkit/handler with one monotonic clock, explicit request context state and a postMessage bridge carrying Request/Response frames without introducing a second contract dispatcher.
type: decision
status: accepted
created: 2026-11-23
updated: 2026-11-23
---

# ADR 0307 — A handler runs without Node built-ins, and a bridge carries Requests and Responses

Serves **I1**, **I5**, **I6**, **I8**, **I10**, **I12**. Builds on [ADR 0013](./0013-runtime-agnostic-core.md), [ADR 0028](./0028-revert-contract-dispatcher.md), [ADR 0303](./0303-a-host-beside-its-window-is-an-ordinary-server.md) and [ADR 0304](./0304-sync-is-a-client-half-a-server-half-and-the-apps-own-merge.md).

## Context

An offline-first mobile application runs its local host inside the React Native / Hermes process and serves its UI (WebView / Expo DOM component) over a string `postMessage` bridge. Although `createHandler` was Web Fetch-shaped (ADR 0013), its runtime graph could not load or answer requests in Hermes:

- `src/observability/context.ts` statically imported `AsyncLocalStorage` from `node:async_hooks`;
- five call sites used `process.hrtime.bigint()` (`RequestContext.startedAt: bigint`) alongside `performance.now()` in the same pipeline;
- ten call sites used `Response.json(...)`, which `whatwg-fetch@3.6.20` (React Native 0.88) does not provide;
- `Request.body` is `undefined` under `whatwg-fetch@3.6.20`, breaking `maxJsonBodyBytes` and audit payload reading;
- `stitchkit/server` re-exports `node:fs` and Bun/Node server modules (`browser: false`), so bundlers without tree-shaking (Metro) cannot load `createHandler` from it.

Previously, ADR 0028 reverted a custom webview↔sidecar contract dispatcher because it invented a second way to execute contract methods and forced applications to rewrite their contracts.

## Decision

1. **Portable entrypoint `stitchkit/handler` (`browser: true`, evolving):** exposes `createHandler`, `implement`, `createImplement`, `createErrorHook`, error helpers and `serveBridge` with zero Node built-ins in its transitive graph (`check-browser-clean`). `stitchkit/server` re-exports the same `createHandler` implementation (I8).
2. **One monotonic clock (`performance.now()`):** `RequestContext.startedAt` becomes `number` (breaking), removing `process.hrtime.bigint()` across the pipeline instead of keeping two time branches.
3. **Explicit pipeline context + lazy `AsyncLocalStorage`:** pipeline-owned fields (`serviceName`, `action`, `userId`, `traceId`) live on `RequestState.context`, so concurrent requests in Hermes never mix trace or user fields across `await`. On Node (≥ 22.3.0) and Bun (≥ 1.4.0), `AsyncLocalStorage` is loaded lazily via `globalThis.process?.getBuiltinModule?.('async_hooks')` to preserve ambient `getTraceId()` / `setRequestUser()`; Node/Bun without `getBuiltinModule` fails loudly.
4. **Portable Fetch & capability checks at construction:** JSON responses go through one `jsonResponse()` helper (`new Response(JSON.stringify(...))`); bounded body reading handles `req.body === undefined` via `req.text()` and UTF-8 byte counting; malformed `%` sequences in query strings become `400 BAD_REQUEST` instead of 500 `URIError`. `createHandler` fails loudly at construction if `crypto.getRandomValues` is missing, or if `ReadableStream` is missing while streaming or multipart endpoints are mounted.
5. **PostMessage bridge without a second dispatcher (why this differs from ADR 0028):** `serveBridge` (`stitchkit/handler`) and `createBridgeFetch` (`stitchkit/http`) transport Zod-validated v1 string frames (`request`, `abort`, `response`, `failure`, `hello`) carrying ordinary HTTP `Request` and `Response` into the same `createHandler` and typed client (`ClientConfig.fetch`). Applications change no contract declarations; ADR 0028 remains in force. Trust is enforced by exact origin allowlist, optional constant-time launch secret, stripping proxy/host/origin headers from frames and refusing `trustProxy` handlers on a bridge. Frame size is bounded in UTF-8 bytes before `JSON.parse`, a response body is read no further than one frame where the host has streams, an `invoke` adapter carries no cancellation to the host (the caller stops waiting; the request it handed over runs to its end), in-flight count is bounded (`maxInFlight`), and handler HTTP errors travel as `Response` frames (never rejected) so replay rules (ADR 0303) stay intact.
6. **Executable RN proof:** a `node:vm` realm gate loaded strictly with React Native 0.88 globals (`whatwg-fetch@3.6.20`, no `Buffer`/`crypto`/`process.hrtime`) runs in `bun test` alongside the `handler-hermes` consumer-lane proof.

## Consequences

- Desktop (loopback HTTP + `createLocalHostGuard`), mobile in-process (postMessage bridge over `createHandler`) and browser (direct `fetch → handler`) all serve the same contract definitions with identical replay and error semantics.
- Minimum supported runtimes rise to Node `>=22.3.0` and Bun `>=1.4.0`, and callers reading `RequestContext.startedAt` receive milliseconds (`number`) instead of nanoseconds (`bigint`).
- Binary response bodies and streaming/multipart endpoints remain unsupported over the v1 text bridge and on runtimes without `ReadableStream`, failing explicitly at construction or with `failure: unsupported`.
