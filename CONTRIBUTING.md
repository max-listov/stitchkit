# Contributing to stitchkit

Thanks for your interest in stitchkit. It is an early (pre-1.0) project — issues,
ideas and pull requests are all welcome.

This is the hands-on workflow for **developing the framework**. The rules,
architecture, breaking-change and release flow live in
[`AGENTS.md`](./AGENTS.md). Building an app **with** stitchkit instead? See the
[README](./README.md) and the [user guide](./docs/guide/).

## Prerequisites

- [Bun](https://bun.sh) `>= 1.2` — development and tests use `Bun.serve` and
  `bun:test`. Node ≥ 22 is supported at runtime via `stitchkit/node`.

## Setup

```bash
git clone https://github.com/max-listov/stitchkit.git
cd stitchkit
bun install
```

## Workflow

The framework lives in `packages/core`; the published application scaffolder
and its canonical template live in `packages/create-stitchkit`. Every command
runs from the repo root:

```bash
bun run dev       # watch-rebuild packages/core/dist
bun run lint      # Biome — root and template configs, warnings fail
bun run check     # tsc — framework, scaffolder and canonical template
bun run test      # the test suite
bun run build     # build dist/ (bun build + tsc declarations)
bun run consumer-lane  # install the packed tarball into a fixture app and use it
bun run starter-lane       # both scaffold variants against the published Stitchkit target
bun run starter-head-lane  # both scaffold variants against packed framework HEAD
bun run starter:dev   # run the canonical starter directly under PM2 with HMR
bun run verify    # all framework and packed-consumer gates
bun run lint:fix  # auto-fix formatting / safe lint
```

`bun run verify` must be green before a change is opened as a PR — CI runs the
same suite, and the `pre-push` hook runs `verify` automatically.

### The consumer lane

The suite imports from `src`, in one process, with everything in scope. A
consumer gets a tarball, an `exports` map and the emitted declarations — and the
gap between those two views is where defects live: a bundler-folded environment
read, a type named in a public signature but exported nowhere, a value delivered
to a hook nobody can reach. All three shipped, and all three were reported from
outside.

`bun run consumer-lane` packs the built package, installs it into throwaway
fixture apps and uses it through the published entrypoints only — annotating
types on purpose, so a missing export is a compile error, and asserting on
behaviour that only the **built** artifact can show. Two fixtures, split by what
a consumer had to install: `minimal` (stitchkit + zod, no optional peer) and
`full` (the peers the tool surface needs). About 8 seconds.

`bun run starter-lane` packs `create-stitchkit`, executes its binary and verifies
both generated app variants against the published Stitchkit range and lockfile
declared by the template. `bun run starter-head-lane` runs the same external-consumer path
after replacing only the generated catalog target with the packed local core;
it is a compatibility probe, not the starter's release target. Both modes run
the authored-source guard, typecheck, lint, unit tests, production builds and
runtime/browser E2E. The canonical template is also the live development workspace.

GitHub CI runs the four mode/variant combinations independently so none waits
for another generated application. The core package checks and packed Node
consumer start in parallel with them; a final fail-closed aggregate requires
every result. See [`docs/architecture/ci-release.md`](docs/architecture/ci-release.md)
for the graph, exact-SHA publication boundary and performance budget.

The canonical template is an autonomous nested Bun workspace. Root `bun install`
installs its frozen lockfile and generates its ignored Prisma client so source is
clean in editors, but it is not linked to framework HEAD. Advancing the starter
means changing the one `catalog.stitchkit` range, refreshing the template lock,
passing both lanes and releasing `create-stitchkit` separately.

`bun run starter:dev` runs `packages/create-stitchkit/template` itself. The command
creates the ignored local `.env` from `_env` on first use, applies migrations to
the configured external PostgreSQL database, and launches the backend and frontend
as direct PM2 processes.
Bun watch mode and Next.js provide normal hot reload from the authored files; there
is no generated preview tree or reconciliation process. Stable development ports
are Web `3210` and API `3211`; `DATABASE_URL` owns the database location.

The template is intentionally a neutral application named `stitchkit-starter`.
Scaffolding writes one validated `app.config.json` and structurally updates only
the root package manifest; runtime-visible identity derives from that config.
The disposable `starter-lane` remains the authoritative test of the exact
post-scaffold product and allocates isolated ports and a uniquely named database
before deleting its temporary workspace.

When it fails it keeps its work directory and prints the path — reproduce by
hand there. Adding a public API? Name its types in a fixture; that is what keeps
the export honest.

### Independent releases

- `vX.Y.Z` must match `packages/core/package.json`; it publishes only
  `stitchkit` and reads release notes from the root `CHANGELOG.md`.
- `create-stitchkit-vX.Y.Z` must match
  `packages/create-stitchkit/package.json`; it publishes only the scaffolder and
  reads `packages/create-stitchkit/CHANGELOG.md`.
- The two versions never need to match. A scaffolder release advances its
  Stitchkit target only after the target version already exists on npm and both
  starter lanes are green.

Prepare versions and changelogs in an ordinary commit and wait for the exact-SHA
branch CI to pass. Then run `bun run release:core` or
`bun run release:starter`. The runner proves a clean current `master`/`main`,
validates the package version and changelog, and pushes only the matching tag.
The tag workflow downloads the already-validated tarball; it does not rebuild or
rerun the expensive gates.

### Git hooks

`bun install` wires two hooks (`.githooks/`, via `core.hooksPath` set by the
root `prepare` script):

- **`pre-commit`** — checks exactly the staged paths, including names containing
  spaces, without rewriting files or changing the index.
- **`pre-push`** — runs `verify` once for a code/branch push. A tag-only release
  runs only the release metadata preflight; deletion-only pushes run no build.

Wire them manually with `git config core.hooksPath .githooks`. Bypass once with
Git's own `--no-verify` only for exceptional local diagnosis; it is not part of
the release path.

## Architecture decision format

New ADRs follow the canonical shape demonstrated by
[`0065`](docs/decisions/0065-flat-collisions-preserve-every-known-kind.md):
`# ADR NNNN — …`, status/date bullets, then `Context`, `Decision`, rejected
alternatives and `Consequences`. Historical ADRs keep their original formatting;
substantive omissions are corrected without mass-reformatting the archive.

## Local development against a consuming app

To make an app that depends on stitchkit pick up local changes, the app
consumes the **local** working copy in dev and the **published** package in
production.

### Setup — a `file:` dependency

In the consuming app, point the dependency at the local checkout:

```jsonc
"stitchkit": "file:../path/to/stitchkit/packages/core"
```

Production and CI use the npm range (`"stitchkit": "^0.1.0"`); the `file:` form
is the local-dev override.

### The cycle

stitchkit is consumed as built output (`dist/`), not raw `src/`. So after
editing stitchkit:

```bash
cd stitchkit/packages/core && bun run build   # or `bun run dev` to watch
cd path/to/app && bun install                 # refresh the file: copy
```

Bun *copies* a `file:` dependency into its store — the copy is stale until the
next `bun install` (use `bun install --force` if a plain install will not
refresh it).

### Dead ends — do not retry

Two "live link" shortcuts look cleaner but break; recorded here so they are
not re-attempted:

- **`bun link`** — in a monorepo it resolves to the workspace root, not the
  package ([oven-sh/bun#2990](https://github.com/oven-sh/bun/issues/2990)), and
  its default `--save` rewrites `package.json`.
- **Symlinking the package outside the consumer's project root** — a Next.js /
  Turbopack consumer cannot resolve it (`Module not found: Can't resolve
  'stitchkit'`).

A plain `file:` dependency — a copy inside the consumer's `node_modules` — is
the working setup. The rebuild + reinstall step is the price of consuming
built output.

## Conventions

- **Zod-first** — schemas define the shape, types come from `z.infer`.
- **No `as` casts** in framework code, except a documented adapter boundary over
  an untyped external library (e.g. the Socket.IO emitter).
- **Core is Web Fetch-clean** — `createHandler` has no Bun globals. Bun APIs
  live only in `createServer` and `stitchkit/server`.
- Public API additions need a short note in `CHANGELOG.md` under `[Unreleased]`.
- The repo-root `README.md` is canonical; `packages/core/README.md` (the npm
  landing page) is a synced copy. Edit the root file, then run
  `bun run sync:readme` before the release gate.
- User-facing docs live in `docs/guide/` and `docs/api/`; design rationale in
  `docs/decisions/` (ADRs). See [`docs/README.md`](./docs/README.md).

## Pull requests

- Keep PRs focused — one concern per PR.
- Describe the *why*, not just the *what*.
- New behaviour needs a test in `packages/core/tests`.

## License

By contributing you agree that your contributions are licensed under the
project's [MIT License](./LICENSE).
