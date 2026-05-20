# stitchkit starter

A small, runnable app built on [stitchkit](../../README.md) — a notes CRUD with
a typed contract, a typed client, `react-query-kit` hooks and a Socket.IO
live-reload.

It is the reference example: every core piece of stitchkit, wired the way a real
app wires it.

## What it shows

- **One contract, two sides.** `src/shared/contracts.ts` defines the `notes` API
  once. The server implements it; the client calls it — both fully typed.
- **HTTP server** — `createServer()` on `Bun.serve()`, the service mounted under
  an `/api` route group, a raw `/api/health` route.
- **Typed client** — `createClient()` over `createHttpClient()`, wrapped in
  `react-query-kit` hooks (`src/client/hooks/useNotes.ts`).
- **Realtime** — `createSocketIOServer()` watches the data directory and emits
  `data:updated`; the client subscribes with `createSocketIOClient()` and
  refetches.
- **Plain Vite SPA** — the frontend is a standard Vite + React build. The
  backend serves only the API; it never serves static files.

## Layout

```
src/
├── shared/contracts.ts   the notes contract — the single source of truth
├── server/               createServer, implement, Socket.IO, JSON-file storage
└── client/               Vite + React SPA — api client, hooks, pages, UI
```

## Prerequisites

[Bun](https://bun.sh) `>= 1.2`.

## Run

From this directory:

```bash
bun install
bun run dev
```

`bun run dev` starts two processes:

- the **backend** on `http://localhost:3461`,
- the **Vite dev server** on `http://localhost:3460` — open this one.

Vite proxies `/api` and the WebSocket connection to the backend, so the browser
talks to a single origin.

## Other commands

```bash
bun run build   # production SPA build → dist/client
bun run start   # run the backend in production mode
bun run check   # typecheck
```

## Where to look first

1. `src/shared/contracts.ts` — read the contract; everything else derives from it.
2. `src/server/index.ts` — how the contract becomes an HTTP server.
3. `src/client/api.ts` + `src/client/hooks/useNotes.ts` — how it becomes typed
   React hooks.

The full framework guide is in [`docs/`](../../docs/README.md).
