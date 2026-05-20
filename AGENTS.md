# stitchkit — agent guide

Contract-first backend framework for Bun. One `defineContract()` → an HTTP API,
MCP tools, AI-agent tools and a typed client.

This is the canonical agent guide (the tool-agnostic `AGENTS.md` standard). The
reasoning behind each rule is an ADR in `docs/DECISIONS.md`.

## Rules

- **NEVER** ship a competing WebSocket or hook engine — wrap Socket.IO
  (`createSocketIOClient` / `createSocketIOServer`) and `react-query-kit`
  (`createCursorQuery`). → ADR 0008
- **NEVER** write `as` casts. The one allowed exception is the documented
  Socket.IO emitter adapter. → ADR 0003
- **ALWAYS** Bun-only — `Bun.serve`, `bun:test`, Bun APIs. No Node or Deno
  compatibility shims. → ADR 0011
- **ALWAYS** Zod-first — a schema is the source of truth, types come from
  `z.infer`. Never hand-write a duplicate type.
- **ALWAYS** keep the core generic — no domain model. Scopes are free strings,
  there is no billing, `source` is transport-only. → ADR 0002
- Transport and hooks use `RuntimeContext` (loose); handlers use
  `HandlerContext` (typed). Do not cast between them. → ADR 0003
- A new architectural decision → a new ADR in `docs/DECISIONS.md`. A new idea →
  a file in `docs/backlog/inbox/`. See `docs/README.md`.
- **ALWAYS** run `bun run verify` before pushing — lint, typecheck, tests and
  build must all be green.

## Stack

- **Bun** — runtime, HTTP server, test runner.
- **Zod** — validation. **`ky`** — HTTP client (the only runtime dependency).
- Optional peers: `@modelcontextprotocol/sdk`, `ai`, `socket.io` /
  `socket.io-client` / `@socket.io/bun-engine`, `@tanstack/react-query`,
  `react-query-kit`.

## Commands

```bash
bun run dev       # watch-rebuild packages/core/dist
bun run verify    # lint + typecheck + test + build — the gate
bun run build     # build dist/
bun run lint:fix  # auto-fix formatting / safe lint
```

## Layout

```
packages/core/src/
├── contract/   defineContract, errors, pagination, TypedClient
├── server/     createServer/createHandler, implement, socket-io, middleware/
├── browser/    createClient, createHttpClient, createSocketIOClient
├── react/      createCursorQuery, createCacheBridge
├── tools/      createMcpHandler/mountMcp, mountAgent, execute
└── internal/   error normalization, typed helpers
```

Entrypoints: `stitchkit` (browser-safe) · `/server` · `/tools` · `/react` ·
`/contract`. The user guide is in `docs/guide/`, the full public API in
`docs/api/reference.md`.

## Conventions

- A public API change → a note in `CHANGELOG.md` and a test in
  `packages/core/tests`.
- Two git hooks enforce quality: `pre-commit` (auto-format, blocks on any
  warning) and `pre-push` (`bun run verify`). See `CONTRIBUTING.md`.
