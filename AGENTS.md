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
> [`docs/decisions/`](./docs/decisions/).

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
  enforces this mechanically — it is a review rule over a small, countable set,
  not a gate: 47 `AsExpression` nodes in `packages/core/src` on 2026-09-06,
  counted by the TypeScript AST with `as const` excluded (a text search over-
  counts comments and strings). A rising count is a review question. → ADR 0003
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
- **NEVER** publish a runtime internal because it looks useful. A primitive
  leaves `agent-runtime` for an application that drives the model itself only
  when it needs no store, needs no run protocol, and already exists inside
  proven by tests — and it must be typed against what the caller already holds,
  because a symbol can be public while the thing it does is still behind the
  store (`selectAgentHistory` was exported for months and unreachable in
  practice). A rule that cannot refuse is not a rule: the two named refusals are
  a context-pressure ratio and a model → context-window catalog, both of which
  consuming applications hand-write and neither of which we will own. → ADR 0142
- Transport and hooks use `RuntimeContext` (loose); handlers use
  `HandlerContext` (typed). Do not cast between them. → ADR 0003
- A new architectural decision → a new ADR in `docs/decisions/` **and a row in
  `docs/decisions/README.md`** (keep the index in sync). See `docs/README.md`.
- A new idea or a bug → an issue. This repository tracks decisions, not tasks,
  so an ADR is the **only** durable record of why the code looks the way it
  does — and the bar for writing one is therefore lower than "architecture".
  **An ADR may record a practice or an incident**, not just a design: ADR 0011
  describes a release arrangement that has since been replaced and is kept as
  history, and the release protocol in this file is mostly scar tissue from runs
  that went wrong. If a change teaches something a future reader would otherwise
  relearn the expensive way, that lesson has nowhere else to live — write the
  ADR. What does *not* earn one is unchanged: a bug fix or a small addition is a
  changelog line.
- **ALWAYS** make a declared option load-bearing, and prove it. A typed option
  that is accepted and then not honoured on some path is this repository's most
  repeated defect — six shipped instances, four of them in three releases:
  `transports: ['websocket']` did not refuse polling, a route group's `onError`
  was never dispatched, `managedServerResource` never started the server it was
  handed a thunk for, `bindProcessSignals` substituted schema defaults over the
  application's declared budget. Every one of them typechecked, because a type
  proves an option can be **passed** and says nothing about whether passing it
  changes anything. `packages/core/tests/option-effects.test.ts` enumerates the
  members of the covered configuration types through the TypeScript checker and
  refuses one with no registered test; the registry names a real test, so it
  cannot drift into a list of claims. It proves a named test *claims* the
  option, not that the test is good — the same contract `reference-coverage`
  has. Covered surfaces are chosen by failure mode: a wrong `port` fails loudly
  on the first request, an unenforced allowlist looks exactly like success.
- **ALWAYS** run `bun scripts/verify.ts --release` before a **release commit**, and let the
  `pre-push` hook reuse that exact-tree result — see *What runs where* below. `verify` is the
  whole portable local gate and it runs **every portable gate CI runs**: the frozen-lockfile
  install every runner performs first, lint, typecheck, tests, the Postgres agent-store lane,
  build, the Next-SSR and Node smokes, the packed consumer lane, the packed starter lanes and
  the supervised PM2 lane. Its
  prerequisites are listed in `CONTRIBUTING.md` and all of them arrive with
  `bun install` except a reachable PostgreSQL and the Playwright browsers.

  The only CI-only qualifier is work another kernel cannot execute: real macOS arm64/x64 builds
  and packed Bun/Node contained-files probes (ADR 0135). Two portable gaps used to be: the
  agent-store lane, until it turned a release run red, and the
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
bun run verify         # lockfile · lint · check · test · agent-store lane · build · smokes · consumer lane · starter lanes
bun run verify:fast    # lockfile · lint · check · test — what an ordinary push runs
bun scripts/verify.ts --release # release-train targets; heavy lanes run at most two at once, fewer when the host cannot hold them
bun run build          # build dist/ + generate llms.txt
bun run lint:fix       # auto-fix formatting / safe lint
bun run update:starter # move the template's framework range + lockfile together
bun packages/core/src/upgrade-cli.ts upgrade --from X.Y.Z  # the plan a consumer gets, from this tree
```

The full annotated command list, setup and git hooks are in
[`CONTRIBUTING.md`](./CONTRIBUTING.md).

### What runs where

CI plans evidence from changed paths or `release-train.json`. Portable core,
TUI, starter, supervised and real-Darwin lanes start independently after the
small planner; only publication assembly waits for selected evidence and native
binaries. A starter release runs published-target compatibility, a core release
runs packed HEAD, and scheduled/manual CI retains the complete target × HEAD
matrix. Darwin packs the public package but executes only the platform-specific
contained-files proof. → ADR 0136.

So the local gate **complements** CI instead of copying it, and `pre-push`
picks by what a red run would cost on the commit being pushed:

| Push | Local gate | Why |
| --- | --- | --- |
| ordinary branch push | `lockfile`, `lint`, `check`, `test` (~40s) | a red CI run costs one follow-up push |
| push carrying the `release(...)` commit | metadata, then `verify --release` for the selected train (heavy concurrency measured from available memory, `VERIFY_HEAVY_CONCURRENCY` overrides) | a red run here cannot be repaired in place |
| tag only | release metadata; for a **scaffolder** tag also the lockfile check | the commit already has a green exact-SHA run |

The release row is the whole argument. `assert-subject` requires a tag to sit
on a `release(<scope>): … in X.Y.Z` commit and `assert-head` requires that
commit to be the branch head, so a red run on an already-pushed release commit
is repaired only by making a **new** release commit. Everywhere else, red is
two and a half minutes and a fix.

**The publication-privacy scan runs on both pushes and is never memoised.** It
reads the index, and the memo's key is a working-tree hash that counts untracked
files — so a new file is inside the key and outside the scan at the same time,
and `git add` moves neither. A push therefore skipped it once and published a
real machine path; CI went red afterwards, which for a public repository is a
report rather than a refusal. It costs 367 ms. → ADR 0164

**Metadata before machinery, on both pushes.** A release commit's changelog is
read — version against the manifest, `### ⚠️ Breaking changes` against its
`**Who must act:**` line, the breaking section against the version calibre, the
promoted migration section — *before* `verify` starts, out of the commit being
pushed rather than the working tree. It is one file and a regular expression;
the gate behind it is eight minutes. Until 0.67.0 this ran for pushed **tags**
only, so a release commit went through the whole gate and a CI run before the
tag was refused — at which point the commit is public and the fix needs a second
release commit, a second gate and a second CI run. 0.67.0 paid that. The order
now lives in one observed function (`prePushMetadataGate`) rather than in the
sequence of statements around it.

All profiles — fast, full, packed HEAD and each exact release target set — remember the last
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
├── live/       event declarations and the watched-read client (evolving)
├── realtime/   typed Socket.IO contracts and rejection reporting
├── observability/  request/tool events, sanitising, trace context
├── files/      managed file boundary, byte ranges, inspection
├── tracking/   visitor-tracking client, outbox, beacon; server/ decisions (evolving)
├── release/    build marker, release watcher, socket channel (evolving)
├── geo/        server-only GeoIP resolver over an optional MaxMind peer (evolving)
├── testing/    in-process client, surface manifest, conformance kits
└── internal/   error normalization, typed helpers
```

Entrypoints: `stitchkit` (browser-safe) · `/live` · `/server` · `/node` · `/tools` ·
`/cli` · `/react` · `/contract` · `/observability` · `/remote` · `/files` ·
`/testing` · `/declaration` · `/tracking` (+`/server`) · `/release` · `/geo` · `/agent-runtime` (+`/openrouter`) · `/application`
(+`/grammy`, `/opentelemetry`, `/schemas`, `/diagnostic-journal`). `/declaration`, `/live`, `/tracking`, `/release`, `/geo`, `/agent-runtime` and
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
  CHANGELOG — write "a consuming project". The public repo carries no
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

Tag-driven and independently published (npm via OIDC trusted publishing + GitHub Releases),
but coordinated by one exact-tree release train.
The tag flow lives in the `.github/workflows/release.yml` header; `ci.yml`
carries the branch and pull-request gate:

- **stitchkit:** bump only `packages/core/package.json`, roll the root
  `CHANGELOG.md`, add the target to `release-train.json`, then tag `vX.Y.Z`. CI checks the core
  version, publishes only `stitchkit` and reads the root changelog. Rolling the changelog adds
  a minor to the count in the maturity table (`docs/guide/getting-started.md`), which
  `scripts/surface-cadence.test.ts` derives from the changelog and holds by exact sentence —
  recompute both sentences with the test's own term lists and update the table and the test
  in the same commit, or the first `verify` after the roll is red.
- **create-stitchkit:** update the template's single `catalog.stitchkit` target
  and lockfile — `bun run update:starter` moves both and restores every
  `"stitchkit": "catalog:"` reference a raw `bun update` would dissolve — pass
  the planner-selected compatibility lane, bump only
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

**Order inside a release.** `release-train.json` lists every package/version to publish. The
`release(train): …` commit is the LAST commit of the release: land every fix first, run the
package-aware local gate once, make the release commit, wait for one green exact-SHA run, then
push all selected tags with `bun run release:train`. Pushing the release commit before it is green forces the tag onto
whatever fix lands next — `git show <tag>` then points at the wrong change, and
the release commit keeps a red run forever (that is what 0.55.0 did). Two gates
hold the shape, both in the publishing workflow, so neither depends on local
hooks: `assert-head` keeps the tag on the branch head, and `assert-subject`
requires that head to be a `release(train): …` commit whose manifest selects the tag's
own package and exact version. The `pre-push` hook runs the **subject** check
earlier, before the expensive gate; it deliberately does not run `assert-head`,
which needs the remote head and belongs where the remote is authoritative. So a
tag pointing at a superseded release commit passes `pre-push` and fails in the
workflow — after the tag is already pushed, and a published tag is never moved.
Tag the head.

If a release commit is already pushed and its run goes red, the fix does not
become taggable: land the fix, then make a **new** release commit for the same
version on top of it (or bump the patch), and tag that. Recovering by tagging
the fix itself is exactly the shape these gates refuse.

**Waiting for the green run — the query has to be able to answer.** Between
pushing the release commit and tagging it there is exactly one thing to wait
for: the **push** run of `ci.yml` for that **exact SHA**. Ask for it the way the
publishing workflow itself does, and give it the full forty-character SHA:

```bash
SHA="$(git rev-parse HEAD)"
gh api "repos/<owner>/<repo>/actions/workflows/ci.yml/runs?head_sha=$SHA&status=completed" \
  --jq '.workflow_runs' | bun scripts/release-plan.ts select-ci-run "$SHA"
```

`gh run list --commit "$SHA" --json status,conclusion` and `gh run list --branch
master --json headSha,status,conclusion` (filtered on `headSha`) answer the same
question. All three need the **full** SHA.

**`gh run list --commit` with a short SHA returns `[]`.** No error, no warning —
the same empty list a commit with no runs yet would give. A poll loop built on
it therefore waits forever while the run it is waiting for is already green, and
reports "still running" the whole time. That is not a `gh` quirk to remember so
much as an instance of a rule worth applying to every wait: **run the query once
against a case whose answer you already know before you start waiting on it.**
An empty result from a filter you have never seen return a row is not evidence
that the event has not happened.

**Releasing several packages from one tree.** Put every target in
`release-train.json`; one `release(train)` commit carries the complete green
tree and every selected tag points at it. `assert-head` and manifest membership
refuse a tag on another commit or a package/version absent from the train.
Publication remains independent per package, but validation is paid once per
tree rather than once per tag. → ADR 0136.
