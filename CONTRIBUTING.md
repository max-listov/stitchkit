# Contributing to stitchkit

Thanks for your interest in stitchkit. It is an early (pre-1.0) project — issues,
ideas and pull requests are all welcome.

## Prerequisites

- [Bun](https://bun.sh) `>= 1.2` — stitchkit is Bun-only (uses `Bun.serve`,
  `bun:test`); there is no Node/Deno compatibility layer.

## Setup

```bash
git clone https://github.com/maxlistov/stitchkit.git
cd stitchkit
bun install
```

## Workflow

The framework lives in `packages/core`; `packages/starter` is a runnable
example. Every command runs from the repo root:

```bash
bun run dev       # watch-rebuild packages/core/dist
bun run lint      # Biome — strict, warnings fail
bun run check     # tsc — typecheck src + tests
bun run test      # 143 tests
bun run build     # build dist/ (bun build + tsc declarations)
bun run verify    # lint + check + test + build, in CI order — the single gate
bun run lint:fix  # auto-fix formatting / safe lint
```

`bun run verify` must be green before a change is opened as a PR — CI runs the
same suite, and the `pre-push` hook runs `verify` automatically.

### Git hooks

`bun install` wires two hooks (`.githooks/`, via `core.hooksPath` set by the
root `prepare` script):

- **`pre-commit`** — auto-formats staged files with Biome, then blocks the
  commit on any remaining finding, **warnings included** (`--error-on-warnings`).
  The repo stays warning-free at every commit.
- **`pre-push`** — runs the full CI suite locally (lint, typecheck, tests,
  build), so a broken push never reaches the remote or turns CI red.

Wire them manually with `git config core.hooksPath .githooks`. Bypass once with
`git commit --no-verify` / `git push --no-verify`.

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
- **Bun-only** — no Node/Deno compatibility shims.
- Public API additions need a short note in `CHANGELOG.md` under `[Unreleased]`.
- The repo-root `README.md` is canonical; `packages/core/README.md` (the npm
  landing page) is a synced copy. Edit the root file, then run
  `bun run sync:readme` — `bun run release` does this automatically.
- User-facing docs live in `docs/guide/` and `docs/api/`; design rationale in
  `docs/DECISIONS.md` (ADRs). See [`docs/README.md`](./docs/README.md).

## Pull requests

- Keep PRs focused — one concern per PR.
- Describe the *why*, not just the *what*.
- New behaviour needs a test in `packages/core/tests`.

## License

By contributing you agree that your contributions are licensed under the
project's [MIT License](./LICENSE).
