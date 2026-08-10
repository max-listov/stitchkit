# stitchkit — agent guide

Contract-first backend framework for Bun and Node. One `defineContract()` → an
HTTP API, MCP tools, AI-agent tools and a typed client.

## Two roads — pick yours

> **📦 Building an app _with_ stitchkit?** This file is **not** for you — it is
> about changing the framework. Start at the [README](./README.md) quick start and
> the [user guide](./docs/guide/). In your own project your agent's entry point is
> **`node_modules/stitchkit/llms.txt`** (ships in the package); Claude Code users
> can also drop the repo's [`skills/stitchkit`](./skills/stitchkit) into
> `.claude/skills/`. They map the whole consumer surface.
>
> **🔧 Developing stitchkit itself?** You're in the right place. This file is the
> canonical, tool-agnostic guide — the **rules, architecture, breaking-change and
> release flow**. The hands-on contributor workflow (setup, commands, git hooks,
> local development against a consuming app, PRs) is in
> [`CONTRIBUTING.md`](./CONTRIBUTING.md). Design rationale per rule is an ADR in
> [`docs/decisions/`](./docs/decisions/); tasks live in
> [`docs/backlog/`](./docs/backlog/).

---

## Rules

- **NEVER** ship a competing WebSocket or hook engine — wrap Socket.IO
  (`createSocketIOClient` / `createSocketIOServer`) and `react-query-kit`
  (`createCursorQuery`). → ADR 0008
- **NEVER** write `as` casts in business logic. The only casts that ship are a
  handful at documented **boundary** sites — the loose↔typed bridges in
  `internal/typed.ts`, and adapters over untyped external emitters (Socket.IO,
  the event bus, the cache bridge) — each carrying a comment that justifies it.
  A new cast anywhere else means the types are broken upstream; fix them there.
  → ADR 0003
- **ALWAYS** keep the core Web Fetch-clean — `createHandler` takes
  `HandlerConfig` (no Bun types). Bun APIs live only in `createServer` and
  `stitchkit/server`. → ADR 0013
- **ALWAYS** Zod-first — a schema is the source of truth, types come from
  `z.infer`. Never hand-write a duplicate type.
- **ALWAYS** keep the core generic — no domain model. Scopes are free strings,
  there is no billing, `source` is transport-only. → ADR 0002
- Transport and hooks use `RuntimeContext` (loose); handlers use
  `HandlerContext` (typed). Do not cast between them. → ADR 0003
- A new architectural decision → a new ADR in `docs/decisions/` **and a row in
  `docs/decisions/README.md`** (keep the index in sync). A new idea → a file in
  `docs/backlog/inbox/`. See `docs/README.md`.
- **ALWAYS** run `bun run verify` before pushing — lint, typecheck, tests,
  build and the Node smoke test must all be green.

## Stack

- **Bun** — primary runtime, HTTP server, test runner. **Node ≥ 22** supported
  via `stitchkit/node` (→ ADR 0013).
- **Zod** — validation. **`ky`** — HTTP client (the only runtime dependency).
- Optional peers: `@modelcontextprotocol/server`, `@modelcontextprotocol/ext-apps`,
  `ai`, `srvx`, `socket.io` /
  `socket.io-client` / `@socket.io/bun-engine`, `@tanstack/react-query`,
  `react-query-kit`.

## Commands

```bash
bun run dev       # watch-rebuild packages/core/dist
bun run verify    # lint + typecheck + test + build + node smoke + consumer lane — the gate
bun run build     # build dist/ + generate llms.txt
bun run lint:fix  # auto-fix formatting / safe lint
```

The full annotated command list, setup and git hooks are in
[`CONTRIBUTING.md`](./CONTRIBUTING.md).

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

Entrypoints: `stitchkit` (browser-safe) · `/server` · `/node` · `/tools` ·
`/cli` · `/react` · `/contract` · `/observability`. The user guide is in
`docs/guide/`, the full public API in `docs/api/reference.md`. The consumer
entry points `llms.txt` / `llms-full.txt` are **generated** from those docs by
`bun run gen:llms` (runs in `build`) — edit the docs, not the generated files.

## Conventions

- A public API change → a note in `CHANGELOG.md` under `[Unreleased]` **and** a
  test in `packages/core/tests`.
- Commit messages are plain (e.g. `release: 0.4.0`, `fix: …`) — **no
  `Co-Authored-By`, AI or tool-signature footer**.
- **Never name a private/consuming project** in committed docs, ADRs, the
  CHANGELOG or backlog — write "a consuming project". The public repo carries no
  downstream names.

(The Zod-first / no-`as` / Web-Fetch-clean code conventions are the **Rules**
above; contributor-process conventions — README sync, doc locations — are in
[`CONTRIBUTING.md`](./CONTRIBUTING.md).)

## Breaking changes & migration

Breaking changes are **allowed** — pre-1.0, an evolving API is expected. The rule
is not "never break", it is "**never break silently**". One source of truth, one
format, so an agent upgrading a long-frozen consumer can recover the full diff
between versions mechanically.

When a change breaks a public API (removed/renamed export, changed signature or
return shape, changed default, stricter validation):

1. **Mark it in `CHANGELOG.md`.** Under `[Unreleased]`, lead the version with a
   **`### ⚠️ Breaking changes`** section (this exact heading — agents grep it).
   Each item states *what* broke, *why*, and a **before → after** snippet:

   ```md
   ### ⚠️ Breaking changes

   - **`createMcpHandler` no longer accepts `foo`** — it moved to `bar` because …
     `// before: createMcpHandler({ foo })` → `// after: createMcpHandler({ bar })`
   ```

   A version with **no** `### ⚠️ Breaking changes` section is purely additive —
   safe to adopt without code changes. (0.1.0–0.7.0 had none.)

2. **Bump minor** pre-1.0 (`0.7 → 0.8`) — the caret (`^0.7.0` = `< 0.8.0`) means a
   consumer never crosses a breaking minor on a plain `install`; the upgrade is an
   explicit opt-in. Post-1.0 a breaking change is a **major** bump.

3. **No deprecation shims / compat wrappers / aliases** (one clean path). Update
   the consumers this repo's owner controls in the **same pass** — that migration
   review *is* the notification channel while consumers are few.

4. The **upgrade flow** an agent follows to move a consumer across versions lives
   in [`docs/guide/upgrading.md`](docs/guide/upgrading.md) — keep it in sync if
   this convention changes.

## Releasing

Tag-driven and independent (npm via OIDC trusted publishing + GitHub Releases).
Full flow lives in the `.github/workflows/ci.yml` header:

- **stitchkit:** bump only `packages/core/package.json`, roll the root
  `CHANGELOG.md`, run `bun run verify`, then tag `vX.Y.Z`. CI checks the core
  version, publishes only `stitchkit` and reads the root changelog.
- **create-stitchkit:** update the template's single `catalog.stitchkit` target
  and lockfile, pass both `starter-lane` and `starter-head-lane`, bump only
  `packages/create-stitchkit/package.json`, roll its own `CHANGELOG.md`, then tag
  `create-stitchkit-vX.Y.Z`. CI checks the scaffolder version and publishes only
  `create-stitchkit`.

The package versions never need to match. A framework release must not silently
advance or publish the starter; a starter release must target a Stitchkit range
that already exists on npm.
