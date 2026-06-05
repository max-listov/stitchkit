---
title: Browser-safe root entry leaked node:module → client bundlers broke
description: createRequire/node:module from the MCP-apps code was hoisted by bun build --splitting into a shared chunk that the browser-safe root entry imported, so a Next.js/Turbopack client build failed ("chunking context does not support external modules: node:module"). Split the browser vs server builds + a post-build guard.
type: task
status: done
created: 2026-06-05
updated: 2026-06-05
completed: 2026-06-05 08:55
related: docs/decisions/0013-runtime-agnostic-core.md
---

# Browser-safe root entry leaked `node:module`

**Type: DO (build fix).** Surfaced the first time a consuming project's Next.js 16
/ Turbopack **frontend** built against stitchkit (a client component imports
`ApiError` from the root `stitchkit`).

## Symptom

```
Code generation for chunk item errored
./node_modules/.../stitchkit/dist/index-37x76zdn.js
- the chunking context (unknown) does not support external modules (request: node:module)

Import traces (Client Component Browser):
  stitchkit/dist/index-37x76zdn.js → stitchkit/dist/index.js → query-client.ts → …
```

## Root cause

`tools/mcp-app.ts` used `createRequire` (`node:module`) to resolve the optional
`@modelcontextprotocol/ext-apps` bundle. `bun build` builds **all** entrypoints in
one invocation with `--splitting`; it emitted the `createRequire` helper
(`__require`) into a shared chunk and made the **browser-safe root** `index.js`
**side-effect-import** it (`import "./index-37x76zdn.js"`) even though root never
uses `__require`. So `node:module` ended up reachable from the client bundle and
Turbopack refused it. AGENTS.md declares `stitchkit` browser-safe — this violated
it. (Latent before now; only hit once a client component imported from the root.)

`import.meta.resolve` did not help — bun lowers it back to `createRequire`. The
fix had to be at the **build boundary**.

## Acceptance

- [x] The root `stitchkit` (and `/react`, `/contract`) dist graph contains **no**
      `node:` import.
- [x] Server / tools entrypoints keep using Node built-ins (unchanged).
- [x] A guard prevents regression. `bun run verify` green.

## Что сделано (2026-06-05)

- [x] **Split the build** (`packages/core/package.json`) — `build:browser`
  (`index` / `react` / `contract`) and `build:server` (`server` / `node` / `tools`
  / `cli` / `observability`) are now **separate** `bun build` invocations, so a
  server-only helper can no longer be hoisted into a chunk the browser entries
  import. Verified: root + `/react` + `/contract` dist graphs have 0 `node:`.
- [x] **`check-browser-clean.mjs`** (`packages/core/scripts/`) — post-build guard:
  walks each browser entry's dist chunk graph and fails the build on any `node:`
  import. Wired into `build`.
- [x] **`smoke:node` now runs in local `verify`** (was CI-only) — the symmetric
  Node-side guard, so a Node leak is caught pre-push too.
- [x] **`mcp-app.ts`** — `createRequire` → `import.meta.resolve` + `fileURLToPath`
  (cleaner; the build split is the actual fix). ext-apps resolution still works
  server-side (smoke + build green).
- [x] CHANGELOG `### Fixed`.

## Снять у консьюмера
After bumping to the patched version, the frontend client build (importing from
`stitchkit` root in a client component) works — no Turbopack `node:module` error.

**Patch release (no API change) — 0.8.1.**
