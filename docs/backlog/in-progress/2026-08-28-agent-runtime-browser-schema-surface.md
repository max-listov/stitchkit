---
title: Browser-safe agent runtime schemas and event cursor surface
description: Canonical run schemas imported into a client bundle pull the server runtime and node async_hooks.
type: task
status: in-progress
created: 2026-08-28
updated: 2026-08-28
priority: P1
---

## Problem

A client component / shared DTO imports only AgentRunStateSchema and
AgentTerminalReasonSchema from the published stitchkit/agent-runtime entrypoint.
Next 16.3.2 with Webpack fails to build on stitchkit 0.68.4 / Bun 1.3.14:

```text
UnhandledSchemeError: Reading from "node:async_hooks" is not handled by plugins
Import trace:
node:async_hooks
stitchkit/dist/index-51a19y3v.js
stitchkit/dist/agent-runtime.js
shared session schema
client component
```

The public package has only ./agent-runtime and ./agent-runtime/openrouter.
The root browser entrypoint does not export these schemas. The agent-runtime
barrel also exports runtime/execution facilities; the server build uses shared
chunks and pulls the Node observability context. There is no exported neutral
schema subpath. Deep dist imports and browser polyfills are not a valid fix.

## Minimal consumer

```tsx
'use client';
import { AgentRunStateSchema, AgentTerminalReasonSchema } from 'stitchkit/agent-runtime';
export default function Page() {
  return <div>{AgentRunStateSchema.parse('queued')}:{AgentTerminalReasonSchema.parse('context_overflow')}</div>;
}
```

Use a Next 16.3.2 production Webpack build with the published package.
Schema reuse must not load model providers, execution, AsyncLocalStorage or Node-only modules.

## Required result

- [x] Export a supported browser-safe subpath for canonical schemas/types and
      event cursor validation needed by UI clients.
- [x] Include run/message/usage/terminal schemas and durable/transient event
      schemas/cursor helpers without importing runtime execution or sink internals.
- [x] Preserve one source for schemas; no copied browser enum definitions.
- [x] Package-level browser bundling regression including Next/Webpack; retain
      Bun and Node runtime imports and optional-peer behavior.
- [ ] Document the boundary and publish a patch; specify the supported import path.

## Что сделано

- [x] `stitchkit/agent-runtime/browser` exports the canonical record, usage,
      terminal, delivery-event and cursor schemas/types from their existing sources;
      execution, persistence, event-sink and Node context modules stay excluded.
- [x] `packages/core/scripts/check-browser-clean.mjs` and
      `packages/core/scripts/consumer-lane/optional-peer-matrix.mjs` prove the new
      entrypoint is Node-free and installable with zero optional peers.
- [x] `packages/core/scripts/next-ssr-retry-smoke.mjs` builds a packed Next 16.3.0
      Webpack client fixture importing run state, terminal reason and cursor helpers
      from the supported browser path, then verifies its rendered output.
- [x] `packages/core/tests/reference-coverage.test.ts` —
      `reference.md coverage > every export of stitchkit/agent-runtime/browser is documented`
      and `public surface of stitchkit/agent-runtime/browser matches its exact snapshot`
      pin documentation and the exact public surface.
- [x] `README.md`, `docs/guide/agent-runtime.md`, `docs/guide/getting-started.md`,
      `docs/api/reference.md` and `CHANGELOG.md` name the supported import boundary.
- [x] Full `bun run verify` passed for tree `02992105a45e`.
