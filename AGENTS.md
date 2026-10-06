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
- **ALWAYS** register every process a test starts with `packages/core/tests/support/process-reaper.ts` before it can
  exist; `bun run test` fails the run, naming the survivor, when one is left. → ADR 0249
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
- Cite an ADR in an item breaking a **stable** entrypoint; release cadence is reported without a
  calendar limit. → ADR 0198, ADR 0204
- Pre-1.0 a break bumps the **minor**; everything non-breaking, new API included, is a **patch**.
  → [release-process](./docs/architecture/release-process.md#which-number-moves)
- **NEVER** add deprecation shims, compat wrappers or aliases — one clean path. → PRINCIPLES I8
- Before 1.0 do **not** keep an unclear call site to spare consumers a migration: when a change removes a
  concrete defect (an unreadable positional list or boolean pair, two names for one concept, a type that
  does not infer, a refusal only readable as text), make the clean break with a mechanical migration.
  Read the call site aloud; shape rules in [api-shape](./docs/architecture/api-shape.md). → ADR 0238
- End every breaking item with one `**Affects:**` line: backticked entrypoint(s), then the exports it
  changes (`name(qualifier)`), `behaviour` or `*`; targets separated by `; `. `release:check` refuses an
  item without it, and `stitchkit upgrade` matches it against a project's imports.
  → [upgrading](./docs/guide/upgrading.md#does-an-item-touch-your-project)
- Write the migration in `docs/guide/upgrading.md` with a `**Who must act:**` line; a scaffolder's
  operator steps go to `packages/create-stitchkit/UPGRADING.md`. `scripts/release-plan.ts` refuses a
  breaking section without its promoted `## Released migration: X.Y.Z`. → [release-process](./docs/architecture/release-process.md#breaking-changes-and-migration)
- Migrate the consumers this repository's owner controls in the **release wave**, after publication, by
  `upgrading.md` — never inside an unreleased batch. → [release-process](./docs/architecture/release-process.md#breaking-changes-and-migration)

## When you write docs and records

- A new architectural decision → a new ADR in `docs/decisions/` **and** a row in its `README.md` naming
  the invariant (or `P`, or superseded; `scripts/decisions-index.test.ts`). Never change an existing ADR's decision — supersede or
  amend it; fixing its language, metadata or links, or pointing to its successor, is allowed.
  → [docs/README](./docs/README.md)
- Write an ADR for any lesson a future reader would otherwise relearn the expensive way, a practice or
  incident included; a bug fix or small addition is a changelog line. → [engineering-rules](./docs/architecture/engineering-rules.md#the-bar-for-an-adr-is-lower-than-architecture)
- Write public docs in English, without agent metadata (`participants`, `harness`, `model`).
  → `scripts/publication-privacy.ts`
- A new idea or a bug → an issue; this repository tracks decisions, not tasks. → [docs/README](./docs/README.md)
- **NEVER** name a private or consuming project in committed docs, ADRs or the CHANGELOG — write "a
  consuming project". → ADR 0164
- Edit `docs/guide/` and `docs/api/`, never the generated `llms.txt`, `llms-full.txt` or the slices in
  `packages/core/llms/` — `scripts/gen-llms.ts` (`bun run gen:llms`, run by `build`) writes them.
- Edit the root `README.md`, then `bun run sync:readme`. → [CONTRIBUTING](./CONTRIBUTING.md#conventions)

## Before you commit and push

- Write plain commit messages (`fix: …`) — **no `Co-Authored-By`, AI or tool-signature footer**; real
  newlines in bodies (`commit-msg` refuses a literal `\n`). → [CONTRIBUTING](./CONTRIBUTING.md#git-hooks)
- Commit a release's work as one commit (`feat(scope): …` or `fix(scope): …`) with a body; the
  `release(train): <summary> in X.Y.Z` commit that follows holds release metadata only and is never
  empty. → [release-process](./docs/architecture/release-process.md#order-inside-a-release), ADR 0237
- Push a release candidate to `release/X.Y.Z`: `pre-push` runs the structural candidate gate plus the tests that read
  release metadata (`test:release-metadata`); the full selected CI must pass for its exact SHA before
  master/tag. A direct unproven master release requires `bun scripts/verify.ts --release`.
  → [gates](./docs/architecture/gates.md), ADR 0247

### What runs where

- An ordinary push runs the fast half (`lockfile`, `lint`, `check`, `test`); a `release(...)` commit
  earns metadata plus the gate a red run there would justify; a tag, metadata only. → [gates](./docs/architecture/gates.md#what-runs-where), ADR 0136
- Keep `verify` running every portable gate CI runs — only real-Darwin work is CI-only
  (`scripts/gate-parity.test.ts`). → [gates](./docs/architecture/gates.md#verify-is-every-portable-gate-ci-runs), ADR 0135
- Never memoise the publication-privacy scan; it runs on every push. → ADR 0164
- Check release metadata before any machinery. → [gates](./docs/architecture/gates.md#metadata-before-machinery)
- Key the green memo (`scripts/gate-memo.ts`) on what was checked — tree and toolchain, the fast subset only —
  never a commit, branch or clock. → [gates](./docs/architecture/gates.md#the-green-memo)
- Only a green exact-SHA **push** run of `ci.yml` authorises publication. → [ci-release](./docs/architecture/ci-release.md)

## Releasing

- Bump only the released package's `package.json`, roll its `CHANGELOG.md`, list every target in
  `release-train.json`. → ADR 0136, [release-process](./docs/architecture/release-process.md#two-packages-one-train)
- Run `bun run release:check` before any gate. → [release-process](./docs/architecture/release-process.md#order-inside-a-release)
- Rolling the core changelog moves the maturity-table cadence sentences: update the table and
  `scripts/surface-cadence.test.ts` in the same commit. → [release-process](./docs/architecture/release-process.md#two-packages-one-train)
- Make the metadata-only `release(train)` commit LAST: push it to `release/X.Y.Z`, wait for its exact-SHA
  push run, fast-forward master, `bun run release:train`. The five steps: [how a release happens](./docs/architecture/release-process.md#how-a-release-happens).
- Repair a red release commit with a commit of its own type on top; the tagged head still needs its own
  green push run. `release:check` refuses a package identical to its previous release and a breaking
  note in a patch. → [release-process](./docs/architecture/release-process.md#order-inside-a-release)
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
├── process/                             bounded POSIX commands and process-group cleanup
├── voice/                               speech client, streaming audio and playback contracts
├── agent-runtime/ application/          the two separately bounded products (evolving)
├── observability/ files/ tracking/ release/ geo/ telegram/ oauth/ google/ declaration/ testing/
└── internal/                            leaf helpers — imports no other part
```

Entries: [`getting-started.md`](./docs/guide/getting-started.md) · rules: `tests/import-graph.test.ts` · API: `docs/api/reference.md`.
