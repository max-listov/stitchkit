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
- **NEVER** write `as` casts in business logic. A cast that ships is a
  **boundary**: the loose↔typed bridges in `internal/typed.ts`, adapters over
  untyped external emitters (Socket.IO, the event bus, the cache bridge), and
  the generic bridges in `browser/client.ts` where a scoped client surface is
  rebuilt from a wider one. Each must carry a comment saying why. A new cast
  anywhere else means the types are broken upstream; fix them there. Nothing
  enforces this mechanically — it is a review rule over a small, countable set
  (thirteen in `packages/core/src`), not a gate. → ADR 0003
- **ALWAYS** keep the core Web Fetch-clean — `createHandler` takes
  `HandlerConfig` (no Bun types). Bun APIs live only in `createServer` and
  `stitchkit/server`. → ADR 0013
- **ALWAYS** Zod-first — a schema is the source of truth, types come from
  `z.infer`. Never hand-write a duplicate type.
- **NEVER** make the project declaration a condition — of a build, a test, a
  start path or a check. A project with no `project.json` is a complete
  project; `stitchkit/declaration` is a leaf nothing else in the core imports,
  and `packages/core/tests/project-declaration.test.ts` keeps it one. A
  repository only one tool can bring up is a fork, not a dependency. → ADR 0104
- **ALWAYS** keep the core generic — no domain model. Scopes are free strings,
  there is no billing, `source` is transport-only. → ADR 0002
- Transport and hooks use `RuntimeContext` (loose); handlers use
  `HandlerContext` (typed). Do not cast between them. → ADR 0003
- A new architectural decision → a new ADR in `docs/decisions/` **and a row in
  `docs/decisions/README.md`** (keep the index in sync). A new idea → a file in
  `docs/backlog/inbox/`. See `docs/README.md`.
- A completed backlog item may claim test coverage only by naming the exact
  test file and test case in its `Что сделано` section.
- **ALWAYS** run `bun run verify` before a **release commit**, and let the
  `pre-push` hook decide the rest — see *What runs where* below. `verify` is the
  whole local gate and it runs **everything CI runs**: lint, typecheck, tests,
  the Postgres agent-store lane, build, the Next-SSR and Node smokes, the packed
  consumer lane, the packed starter lanes and the supervised PM2 lane. Its
  prerequisites are listed in `CONTRIBUTING.md` and all of them arrive with
  `bun install` except a reachable PostgreSQL and the Playwright browsers.

  There is deliberately **no** gate that runs on CI and not here. Two used to
  be: the agent-store lane, until it turned a release run red, and the
  supervised lane, until the supervisor became a pinned devDependency instead of
  a global install. Both gaps fell on the release commit — the one commit whose
  red run cannot be repaired in place (see *Order inside a release*) — and
  `scripts/gate-parity.test.ts` now holds the equivalence mechanically rather
  than by review.

## Stack

- **Bun** — primary runtime, HTTP server, test runner. **Node ≥ 22** supported
  via `stitchkit/node` (→ ADR 0013).
- **Zod** — validation. **`ky`** — HTTP client (the only runtime dependency).
- Optional peers: `@modelcontextprotocol/server`, `@modelcontextprotocol/ext-apps`,
  `ai`, `@openrouter/ai-sdk-provider`, `srvx`, `socket.io` /
  `socket.io-client` / `@socket.io/bun-engine`, `@tanstack/react-query`,
  `react-query-kit`, `grammy`, `@opentelemetry/api`.

## Commands

```bash
bun run dev            # watch-rebuild packages/core/dist
bun run verify         # lint · check · test · agent-store lane · build · smokes · consumer lane · starter lanes
bun run verify:fast    # lint · check · test — what an ordinary push runs
bun run build          # build dist/ + generate llms.txt
bun run lint:fix       # auto-fix formatting / safe lint
bun run update:starter # move the template's framework range + lockfile together
```

The full annotated command list, setup and git hooks are in
[`CONTRIBUTING.md`](./CONTRIBUTING.md).

### What runs where

CI runs the **same** work as `verify`, arranged differently: the
lint/check/test/agent-store/build/smokes/consumer lane in one job, the supervised
lane in its own, and the starter work sharded across eight (two modes x two
scaffold variants x two browsers, of which `verify` runs the four target-mode
ones and the release path adds the rest). It answers in about two and a half minutes because
those lanes are parallel by nature. One machine walks them in single file and
takes two to three times longer to reach the same answer.

So the local gate **complements** CI instead of copying it, and `pre-push`
picks by what a red run would cost on the commit being pushed:

| Push | Local gate | Why |
| --- | --- | --- |
| ordinary branch push | `lint`, `check`, `test` (~40s) | a red CI run costs one follow-up push |
| push carrying the `release(...)` commit | the whole of `verify`, then the packed HEAD lane | a red run here cannot be repaired in place |
| tag only | release metadata; for a **scaffolder** tag also the lockfile check | the commit already has a green exact-SHA run |

The release row is the whole argument. `assert-subject` requires a tag to sit
on a `release(<scope>): … in X.Y.Z` commit and `assert-head` requires that
commit to be the branch head, so a red run on an already-pushed release commit
is repaired only by making a **new** release commit. Everywhere else, red is
two and a half minutes and a fix.

All three profiles — fast, full and the packed HEAD lane — remember the last
green run **by what they actually checked** (`scripts/gate-memo.ts`): an
unchanged tree is not gated twice, any edit to any file runs it again, and a
skip always prints which run answers for it. A green full run also satisfies the
fast profile, because it ran every fast step.

The key is the working-tree hash plus the toolchain — never a commit, a branch
or a clock — and for the two profiles that run lanes it also carries what those
lanes talk to: the PostgreSQL server version and the installed browser set.
Neither is visible in a tree or a runtime version, so without them a database
upgrade would leave the memo answering for a run that happened under different
conditions. Anything that cannot be measured becomes a marker of its own, so the
failure mode is a redundant full run rather than a skip. The supervisor needs no
entry: it is a pinned devDependency, so it is already in the tree. The record
lives in the machine's cache, never in the repository, and the tree hash is
taken through a scratch `GIT_INDEX_FILE`, so the gate never writes to the
index.

CI remains the only authority for publication: `select-ci-run` demands a
successful **push** run for the exact SHA, and nothing local can substitute for
it.

(ADR 0011 describes an earlier arrangement in which every push ran the whole
gate. It is a historical record and is not edited; this section is the live
answer.)

## Layout

```
packages/core/src/
├── contract/   defineContract, errors, pagination, TypedClient
├── server/     createServer/createHandler, implement, socket-io, middleware/
├── browser/    createClient, createHttpClient, createSocketIOClient
├── react/      createCursorQuery, createCacheBridge
├── tools/      createMcpHandler/mountMcp, mountAgent, execute
├── agent-runtime/  durable runs, history, prompts, models, fencing (evolving)
├── application/    resource graph, readiness, admission, schedules (evolving)
├── realtime/   typed Socket.IO contracts and rejection reporting
├── observability/  request/tool events, sanitising, trace context
├── files/      managed file boundary, byte ranges, inspection
├── testing/    in-process client, surface manifest, conformance kits
└── internal/   error normalization, typed helpers
```

Entrypoints: `stitchkit` (browser-safe) · `/server` · `/node` · `/tools` ·
`/cli` · `/react` · `/contract` · `/observability` · `/remote` · `/files` ·
`/testing` · `/declaration` · `/agent-runtime` (+`/openrouter`) · `/application`
(+`/grammy`, `/opentelemetry`). `/declaration`, `/agent-runtime` and
`/application` are declared **evolving** (→ ADR 0103). The user guide is in
`docs/guide/`, the full public API in `docs/api/reference.md`. The consumer
entry points `llms.txt` / `llms-full.txt` are **generated** from those docs by
`bun run gen:llms` (runs in `build`) — edit the docs, not the generated files.

## Conventions

- A public API change → a note in `CHANGELOG.md` under `[Unreleased]` **and** a
  test in `packages/core/tests`.
- Commit messages are plain (e.g. `fix: …`) — **no `Co-Authored-By`, AI or
  tool-signature footer**. A **release** commit is the one shape a gate checks:
  `release(core): … in X.Y.Z` for a `vX.Y.Z` tag and `release(starter): … in
  X.Y.Z` for `create-stitchkit-vX.Y.Z` (the older `release: 0.4.0` form no
  longer passes). Bodies use real newlines — a literal `\n` is refused by the
  `commit-msg` hook.
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
   this convention changes. A generated project is a consumer too, and has its
   own channel: [`packages/create-stitchkit/UPGRADING.md`](packages/create-stitchkit/UPGRADING.md).
   That is where a scaffolder release's **operator** steps go — delete these
   supervisor processes, rename these variables — because a changelog entry
   carrying them is overwritten by the next release. Both channels are held by
   the same gate in `scripts/release-plan.ts`: a `### ⚠️ Breaking changes`
   section with no promoted `## Released migration: X.Y.Z` in that package's
   guide is refused.

## Releasing

Tag-driven and independent (npm via OIDC trusted publishing + GitHub Releases).
The tag flow lives in the `.github/workflows/release.yml` header; `ci.yml`
carries the branch and pull-request gate:

- **stitchkit:** bump only `packages/core/package.json`, roll the root
  `CHANGELOG.md`, run `bun run verify`, then tag `vX.Y.Z`. CI checks the core
  version, publishes only `stitchkit` and reads the root changelog.
- **create-stitchkit:** update the template's single `catalog.stitchkit` target
  and lockfile — `bun run update:starter` moves both and restores every
  `"stitchkit": "catalog:"` reference a raw `bun update` would dissolve — pass
  both `starter-lane` and `starter-head-lane`, bump only
  `packages/create-stitchkit/package.json`, roll its own `CHANGELOG.md`, promote
  every `## Unreleased migration:` heading in its own
  `packages/create-stitchkit/UPGRADING.md`, then tag `create-stitchkit-vX.Y.Z`.
  CI checks the scaffolder version and publishes only `create-stitchkit`.

The package versions never need to match. A framework release must not silently
advance or publish the starter; a starter release must target a Stitchkit range
that already exists on npm — and its **lockfile must resolve the newest
published version that range allows**, which is a gate (`scripts/starter-lockfile.ts`),
not a habit. 0.4.1 shipped a `^0.60.0` range over a lockfile pinning 0.60.0 on
the day 0.60.1 existed: every manifest read as correct and a real scaffold
installed the previous framework. The registry is an external dependency of
that gate, so an unreachable registry is a refusal, never a silent pass.

**Which number moves.** The minor is reserved as the *breaking* signal — that is
what makes a consumer's caret (`^0.56.0` = `< 0.57.0`) a real gate: crossing it
is always an explicit opt-in, never a plain `install`. Everything non-breaking
is a **patch**, new API included: it is safe to auto-adopt by construction, and
spending a minor on it would strand consumers on the fixes shipped beside it
(0.48.1 added `stitchkit/testing`; 0.49.1 added `forceTimeoutMs`). So the
question at release time is not "is there a `### Added` section" but "is there a
`### ⚠️ Breaking changes` section" — that one alone moves the minor.

**Order inside a release.** The release commit is the LAST commit of the
release: land every fix first, make the release commit, wait for a green run,
then tag it. Pushing the release commit before it is green forces the tag onto
whatever fix lands next — `git show <tag>` then points at the wrong change, and
the release commit keeps a red run forever (that is what 0.55.0 did). Two gates
hold the shape, both in the publishing workflow, so neither depends on local
hooks: `assert-head` keeps the tag on the branch head, and `assert-subject`
requires that head to be the `release(<scope>): … in X.Y.Z` commit for the tag's
own namespace and exact version. The `pre-push` hook runs the **subject** check
earlier, before the expensive gate; it deliberately does not run `assert-head`,
which needs the remote head and belongs where the remote is authoritative. So a
tag pointing at a superseded release commit passes `pre-push` and fails in the
workflow — after the tag is already pushed, and a published tag is never moved.
Tag the head.

If a release commit is already pushed and its run goes red, the fix does not
become taggable: land the fix, then make a **new** release commit for the same
version on top of it (or bump the patch), and tag that. Recovering by tagging
the fix itself is exactly the shape these gates refuse.

**Releasing both packages from one tree.** Two independent tags plus
`assert-head` means two tags need two branch heads, so the tree has to be split
into two release commits and the split has to be decided before the first push.
One rule governs it, and everything else follows:

> **Every pushed commit is a tree that was gated whole.**

Not "every commit contains only its own package's files" — that is the
plausible-sounding rule, and it is wrong. Splitting a release so the core commit
carries no starter changes gives a core commit whose *own* tests fail, because
this repository's gate reads the starter template from the same tree. The unit
being released is the package version, not the file set.

So:

1. **Make the core release commit first**, carrying everything the tree needs to
   be green — including starter-template changes, if a core test reads them.
   Push, wait for green, tag `vX.Y.Z`.
2. **Make the starter release commit second**, carrying whatever is left. Push,
   wait for green, tag `create-stitchkit-vA.B.C`.

**A file that belongs to both** — `packages/create-stitchkit/package.json`
holding a `files` fix the core commit's test needs *and* the starter version
bump — goes **whole into the earlier commit**. That is not a compromise, it is
what the gates ask for: `validateReleaseTag` requires the version to be *in the
tree at the tag*, and `assertReleaseCommitSubject` requires the tagged commit's
*subject* to name it. Neither requires the bump to be introduced by that commit.
A starter version that rises one commit early publishes nothing — the tag
publishes, not the number in the tree.
