---
title: Direct runnable create-stitchkit template
description: Make the canonical starter itself the only HMR development workspace and close fresh-scaffold release gaps
type: task
status: done
created: 2026-08-08
updated: 2026-08-08
completed: 2026-08-08 08:50 +00:00
---

# Direct runnable create-stitchkit template

## Goal

Develop and inspect the official starter directly from
`packages/create-stitchkit/template`, without a persistent generated preview,
file reconciler or second visible project tree. Keep generated consumers only as
ephemeral release-lane fixtures.

## Plan

- [x] Replace the split `apps/*` + `packages/*` layout with the fleet-standard
  `packages/backend`, `packages/frontend`, `packages/config`, `packages/db` and
  `packages/shared` workspace.
- [x] Make the canonical template a directly runnable neutral `stitchkit-starter`
  application; remove project-name token substitution and let consumers rename
  the copied project explicitly when desired.
- [x] Run template development directly through project-scoped PM2 processes
  with Bun/Next watchers, stable Web/API ports and external PostgreSQL.
- [x] Remove persistent preview materialisation, sync processes and their stale
  documentation/tests.
- [x] Make fresh generated-project checks self-contained by generating Prisma
  before typechecking.
- [x] Keep lint green after a Next production build and for long destination
  directory names.
- [x] Exclude runtime test artifacts from the published scaffolder tarball.
- [x] Update scaffold, lane, docs and path assertions to the single canonical
  layout and workflow.
- [x] Validate lint, typecheck, tests, builds, packed target/HEAD consumer lanes
  and direct-template HMR process startup.

## Acceptance

- [x] `packages/create-stitchkit/template` is the only persistent starter tree.
- [x] `bun run starter:dev` starts that tree directly with PM2 and normal HMR.
- [x] A real CLI-generated project has no tokens or build/runtime artifacts and
  passes its documented gates from a fresh install.
- [x] The canonical template is the only persistent development tree; release
  fixtures remain disposable.
- [x] Published package contents contain no `test-results` or generated clients.
- [x] The full repository verification suite is green.

## Что сделано

- [x] **Workspace:** канонический шаблон собран в
  `packages/create-stitchkit/template/packages/*`; отдельные backend, frontend,
  config, db и shared используют один корневой каталог и lockfile.
- [x] **Scaffolder:** `packages/create-stitchkit/src/scaffold.ts` копирует
  нейтральный `Stitchkit Starter` без токенов переименования и runtime-мусора.
- [x] **Development:** `packages/create-stitchkit/template/scripts/dev.ts` и
  `ecosystem.dev.config.cjs` поднимают прямые Bun/Next PM2-процессы на стабильных
  портах; исходники работают напрямую с HMR из канонического workspace.
- [x] **Next.js:** `packages/create-stitchkit/template/packages/frontend/next.config.ts`
  фиксирует workspace root и собирает `shiki` внутри приложения, исключая
  сломанные Turbopack externals.
- [x] **Release lane:** `scripts/starter-lane.ts` проверяет свежий packed scaffold,
  опубликованный состав, DB, HTTP, OpenAPI, Socket.IO, MCP, CLI и браузеры.
- [x] **Documentation:** обновлены `CONTRIBUTING.md`, README шаблона и scaffolder,
  changelog и ADR `docs/decisions/0066-the-starter-template-is-the-development-workspace.md`.
- [x] **Гейты:** `bun run verify` завершился успешно; 27 starter E2E прошли в
  Chromium, mobile Chromium и WebKit.
- [x] **Что не делалось:** commit, push, release и deploy не выполнялись.
