# stitchkit — agent guide

Contract-first backend framework for Bun and Node. One `defineContract()` → an HTTP API, MCP tools,
AI-agent tools, a CLI and a typed client. What it is and is not: [`docs/PRINCIPLES.md`](./docs/PRINCIPLES.md).

> **📦 Building an app _with_ stitchkit?** Not this file: see the [README](./README.md), the [guide](./docs/guide/),
> and in your project **`node_modules/stitchkit/llms.txt`** (it names the `llms/<entrypoint>.txt` slice to load
> per import) or [`skills/stitchkit`](./skills/stitchkit) copied into `.claude/skills/`.
>
> **🔧 Developing stitchkit?** One rule per line, each linked to where its reasoning lives: ADRs in
> [`docs/decisions/`](./docs/decisions/), the rest in [`docs/architecture/`](./docs/architecture/).
> Setup, commands, hooks, local development against an app, PRs: [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Before you change code

- Name the invariant (I1–I15) your change serves; nothing under "Not in stitchkit" ships. → [PRINCIPLES](./docs/PRINCIPLES.md)
- **NEVER** ship a competing WebSocket or hook engine — wrap Socket.IO (`createSocketIOClient` /
  `createSocketIOServer`) and `react-query-kit` (`createCursorQuery`). → ADR 0008
- **ALWAYS** Zod-first: the schema is the source of truth, types come from `z.infer`; never hand-write
  a duplicate type. → PRINCIPLES I3
- **NEVER** write `as` in business logic. Casts live only at named boundaries — `internal/typed.ts`,
  `executableAgentRuntimeTools` in `tools/runtime-tool.ts`, adapters over untyped emitters (Socket.IO,
  event bus, cache bridge), the generic bridges in `browser/client.ts` — each with a comment saying why;
  elsewhere fix the types upstream. → ADR 0003, [engineering-rules](./docs/architecture/engineering-rules.md#casts-are-a-boundary-and-a-count)
- Transport and hooks use `RuntimeContext` (loose), handlers `HandlerContext` (typed); never cast between them. → ADR 0003
- **ALWAYS** keep the core Web Fetch-clean: `createHandler` takes `HandlerConfig` (no Bun types); Bun
  APIs live only in `createServer` and `stitchkit/server`. → ADR 0013
- **ALWAYS** keep the core generic — no domain model; scopes are free strings, no billing, `source` is
  transport-only. → ADR 0002
- **NEVER** make the project declaration a condition of a build, test, start path or check;
  `stitchkit/declaration` stays a leaf (`packages/core/tests/project-declaration.test.ts`). → ADR 0104
- **ALWAYS** make a declared option load-bearing and register the test that proves it in
  `packages/core/tests/option-effects.test.ts`. → I9, [engineering-rules](./docs/architecture/engineering-rules.md#a-declared-option-is-load-bearing-and-proven)
- **ALWAYS** extend the owner that already exists: one implementation per job, one owner per public
  name, no alias, shim or parallel path. → ADR 0199, I8
- **NEVER** import `agent-runtime/` from the core; the runtime may import the core, shared machinery goes
  to a neutral part (`src/durability/`). Every direction between parts of `src/` is declared in
  `packages/core/tests/import-graph.test.ts` — declare a new one there. → ADR 0197
- **NEVER** publish a runtime internal because it looks useful: it leaves `agent-runtime` only when it
  needs no store and no run protocol, already exists proven by tests, and is typed against what the
  caller holds. → ADR 0142
- Keep functions ≤200 and files ≤500 lines (`packages/core/tests/code-size.test.ts`); an exception is a
  reasoned entry in `packages/core/tests/fixtures/code-size-exceptions.json`, and the list only shrinks. → ADR 0199
- Put an endpoint's tool options in the one `tool` group (`tool: { name, view, ui, annotations, mcp }`);
  `expose` stays outside it. → ADR 0196

## When you change the public API

- Add a line to `CHANGELOG.md` under `[Unreleased]` **and** a test in `packages/core/tests`.
- Give a new public name one owning entrypoint; a name shared on purpose or a higher ceiling is a
  reviewed edit, with a reason, to `packages/core/tests/fixtures/public-surface-budget.json`. → ADR 0199
- Start a new entrypoint **evolving**; promotion to stable needs two independent consumers and an ADR.
  The maturity table in `docs/guide/getting-started.md` is the one place a level is declared. → ADR 0103, ADR 0198

## Breaking changes

- Lead the version with `### ⚠️ Breaking changes` (exact heading); start each item with the
  **backticked entrypoint(s)** it breaks, then what, why and a before → after snippet.
  → [release-process](./docs/architecture/release-process.md#breaking-changes-and-migration)
- Cite an ADR in an item breaking a **stable** entrypoint; at most one stable-breaking minor per rolling
  seven days, so batch the breaks (`release:check` refuses, from 0.94.0). → ADR 0198
- Pre-1.0 a break bumps the **minor**; everything non-breaking, new API included, is a **patch**.
  → [release-process](./docs/architecture/release-process.md#which-number-moves)
- **NEVER** add deprecation shims, compat wrappers or aliases — one clean path. → PRINCIPLES I8
- Write the migration in `docs/guide/upgrading.md` with a `**Who must act:**` line; a scaffolder's
  operator steps go to `packages/create-stitchkit/UPGRADING.md`. `scripts/release-plan.ts` refuses a
  breaking section without its promoted `## Released migration: X.Y.Z`. → [release-process](./docs/architecture/release-process.md#breaking-changes-and-migration)
- Migrate the consumers this repository's owner controls in the **release wave**, after publication, by
  `upgrading.md` — never inside an unreleased batch. → [release-process](./docs/architecture/release-process.md#breaking-changes-and-migration)

## When you write docs and records

- A new architectural decision → a new ADR in `docs/decisions/` **and** a row in its `README.md` naming
  the invariant (or `P`, or superseded; `scripts/decisions-index.test.ts`). Never edit an existing ADR.
  → [docs/README](./docs/README.md)
- Write an ADR for any lesson a future reader would otherwise relearn the expensive way, a practice or
  incident included; a bug fix or small addition is a changelog line. → [engineering-rules](./docs/architecture/engineering-rules.md#the-bar-for-an-adr-is-lower-than-architecture)
- A new idea or a bug → an issue; this repository tracks decisions, not tasks. → [docs/README](./docs/README.md)
- **NEVER** name a private or consuming project in committed docs, ADRs or the CHANGELOG — write "a
  consuming project". → ADR 0164
- Edit `docs/guide/` and `docs/api/`, never the generated `llms.txt`, `llms-full.txt` or the slices in
  `packages/core/llms/` — `scripts/gen-llms.ts` (`bun run gen:llms`, run by `build`) writes them.
- Edit the root `README.md`, then `bun run sync:readme`. → [CONTRIBUTING](./CONTRIBUTING.md#conventions)

## Before you commit and push

- Write plain commit messages (`fix: …`) — **no `Co-Authored-By`, AI or tool-signature footer**; real
  newlines in bodies (`commit-msg` refuses a literal `\n`). → [CONTRIBUTING](./CONTRIBUTING.md#git-hooks)
- A release commit is `release(<scope>): … in X.Y.Z`, scope `train`, `core`, `starter` or `tui`; the old
  `release: 0.4.0` form no longer passes. → [release-process](./docs/architecture/release-process.md#order-inside-a-release)
- Before a **release commit** run `bun scripts/verify.ts --release`; `pre-push` reuses that exact-tree
  result. → [gates](./docs/architecture/gates.md)

### What runs where

- An ordinary push runs the fast half (`lockfile`, `lint`, `check`, `test`); a `release(...)` commit
  earns metadata plus the gate a red run there would justify; a tag, metadata only. → [gates](./docs/architecture/gates.md#what-runs-where), ADR 0136
- Keep `verify` running every portable gate CI runs — only real-Darwin work is CI-only
  (`scripts/gate-parity.test.ts`). → [gates](./docs/architecture/gates.md#verify-is-every-portable-gate-ci-runs), ADR 0135
- Never memoise the publication-privacy scan; it runs on every push. → ADR 0164
- Check release metadata before any machinery. → [gates](./docs/architecture/gates.md#metadata-before-machinery)
- Key the green memo (`scripts/gate-memo.ts`) on what was checked — tree, toolchain, lane environment —
  never a commit, branch or clock. → [gates](./docs/architecture/gates.md#the-green-memo)
- Only a green exact-SHA **push** run of `ci.yml` authorises publication. → [ci-release](./docs/architecture/ci-release.md)

## Releasing

- Bump only the released package's `package.json`, roll its `CHANGELOG.md`, list every target in
  `release-train.json`. → ADR 0136, [release-process](./docs/architecture/release-process.md#two-packages-one-train)
- Run `bun run release:check` before any gate. → [release-process](./docs/architecture/release-process.md#order-inside-a-release)
- Rolling the core changelog moves the maturity-table cadence sentences: update the table and
  `scripts/surface-cadence.test.ts` in the same commit. → [release-process](./docs/architecture/release-process.md#two-packages-one-train)
- Make the `release(train)` commit LAST: push it to `release/X.Y.Z`, wait for its exact-SHA push run,
  fast-forward master, `bun run release:train`. Tag the head. → [release-process](./docs/architecture/release-process.md#order-inside-a-release)
- Never repair a red, pushed release commit by tagging the fix — make a **new** release commit.
  → [release-process](./docs/architecture/release-process.md#order-inside-a-release)
- Query CI with the **full** SHA, and run any wait query once on a known answer before polling it.
  → [release-process](./docs/architecture/release-process.md#waiting-for-the-green-run--the-query-has-to-be-able-to-answer)
- Ship the starter in a LATER train than the framework it tracks; its lockfile resolves the newest
  published version its range allows (`bun run update:starter`, `scripts/starter-lockfile.ts`).
  → [release-process](./docs/architecture/release-process.md#two-packages-one-train)

## Stack

**Bun** — runtime, HTTP server, test runner; **Node ≥ 22** via `stitchkit/node` (ADR 0013). **Zod** —
validation; **`ky`** — HTTP client, the only runtime dependency. Optional peers: `@modelcontextprotocol/server`,
`@modelcontextprotocol/ext-apps`, `ai`, `@openrouter/ai-sdk-provider`, `srvx`, `socket.io` / `socket.io-client`
/ `@socket.io/bun-engine`, `@tanstack/react-query`, `react-query-kit`, `grammy`, `@opentelemetry/api`.

## Commands

`bun run verify:fast` (ordinary push) · `bun run verify` (every portable CI gate) · `bun run release:check`
· `bun packages/core/src/entrypoints/bin/upgrade-cli.ts upgrade --from X.Y.Z` — annotated list: [`CONTRIBUTING.md`](./CONTRIBUTING.md#workflow).

## Layout

```
packages/core/src/                       parts only — no files at the root
├── entrypoints/                         public subpaths as imported (`tools/contract.ts`); re-exports only
├── contract/ json-schema/ primitives/   the declaration, its schemas, generic values
├── server/ (middleware/, oauth/)        createServer/createHandler, implement, Socket.IO server
├── browser/ react/ realtime/ live/      clients, React data layer, typed Socket.IO, watched reads
├── tools/ (mcp/ cli/ operations/ transfer/ schema/ connections/ internal/)  tool mounts and runner
├── durability/                          neutral durability engine shared by tools and the runtime
├── agent-runtime/ application/          the two separately bounded products (evolving)
├── observability/ files/ tracking/ release/ geo/ telegram/ oauth/ google/ declaration/ testing/
└── internal/                            leaf helpers — imports no other part
```

Entries: [`getting-started.md`](./docs/guide/getting-started.md) · rules: `tests/import-graph.test.ts` · API: `docs/api/reference.md`.
