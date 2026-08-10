---
title: Composable blank starter and isolated repository example
description: Make the default scaffold domain-free and compose the repository example as an optional vertical feature instead of cross-cutting template code.
type: task
status: done
created: 2026-08-10
updated: 2026-08-10
completed: 2026-08-10 13:39 +07:00
---

## Зачем

The repository example currently spans shared schemas, contracts and events,
backend domain and transport code, Prisma migrations, frontend data access and UI,
runtime smoke and Playwright. Replacing it with a real product requires a manual
cross-repository deletion pass. The UI catalogue already demonstrates the desired
property: presentation is removable as one isolated subtree while reusable
primitives remain.

## Результат

`bun create stitchkit <name>` produces a runnable, domain-free production base.
`--example repository` layers the current end-to-end example onto that same base
without maintaining two divergent full templates.

## План

- [x] Define two mutually exclusive scaffold modes: default `--blank` semantics and explicit `--example repository`.
- [x] Split the source template into one canonical base plus a repository feature overlay; do not duplicate manifests, configs, UI primitives or infrastructure.
- [x] Make the blank backend, frontend, Prisma schema, MCP route, OpenAPI document, CLI and Socket.IO lifecycle boot cleanly with no product entities.
- [x] Give the blank home page a neutral starter status surface without fake domain data.
- [x] Move every repository-owned file and migration into the example overlay or a clearly removable vertical feature boundary.
- [x] Keep the UI catalogue available in both modes and independently removable.
- [x] Make generated docs and gates mode-aware without conditional dead code in the generated application.
- [x] Add materialisation, install, check, build, runtime-smoke and browser lanes for both modes.
- [x] Document the breaking default change in the `create-stitchkit` changelog with exact before/after commands.

## Acceptance

- [x] The default generated project contains no repository schema, env key, database model, event, endpoint, component, fixture or test expectation.
- [x] `--example repository` preserves a working schema → contract → service → HTTP/MCP/CLI → realtime → frontend path.
- [x] The example can be removed as a documented vertical unit without searching unrelated infrastructure files.
- [x] Blank and example projects share one base and cannot drift through copied template trees.
- [x] Both modes pass authored checks, typecheck, tests, production build, runtime smoke and Playwright.
- [x] Unknown examples and conflicting mode flags fail before writing the destination.

## Что сделано

- [x] Scaffolder: default blank mode and explicit `--example repository` implemented in `packages/create-stitchkit/src/options.ts` and `packages/create-stitchkit/src/scaffold.ts`.
- [x] Composition: one canonical template remains in `packages/create-stitchkit/template`; repository domain is isolated in `packages/create-stitchkit/examples/repository`.
- [x] Runtime: blank and example modes boot HTTP, OpenAPI, MCP, CLI, Socket.IO, frontend and database paths.
- [x] Gates: both modes pass materialisation, install, check, test, build, runtime smoke and Chromium/WebKit E2E in `scripts/starter-lane.ts`.
- [x] Migration: the changed default and exact command are recorded in `packages/create-stitchkit/CHANGELOG.md`.
