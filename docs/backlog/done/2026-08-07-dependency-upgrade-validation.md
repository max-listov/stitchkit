---
title: Validate the 0.37.0 dependency upgrade
description: Complete the latest-dependency upgrade without losing TypeScript tooling, peer compatibility or optional-integration coverage.
type: task
status: done
created: 2026-08-07
updated: 2026-08-07
completed: 2026-08-07 06:31 +00:00
related: docs/backlog/planned/2026-08-07-release-0.37.0-hardening.md
---

# Validate the 0.37.0 dependency upgrade

> **Target release:** 0.37.0. The manifest and lockfile updates already exist;
> this task owns their compatibility work and final validation.

## Verified state

- Installed direct dependencies are current according to Bun's registry check.
- TypeScript moved from 6.x to 7.0.2. The TypeScript 7 CLI is available, but
  its package does not expose `createProgram`; the public-type guard currently
  imports that API and therefore needs an official side-by-side compiler API.
- `srvx` moved from 0.11.x to 0.12.5 while stitchkit still advertises the
  incompatible peer range `^0.11.0`.
- `@modelcontextprotocol/ext-apps` is an optional peer accepted by the current
  range, but its successful bundle path is not exercised by the main dev lane.
- The starter uses the nondeterministic string `latest` for `@types/bun`.

## Implementation plan

1. Keep TypeScript 7 as the project CLI and add the official
   `@typescript/typescript6` package only for the isolated semantic public-type
   guard until the TypeScript 7 programmatic API ships. Import the guard from
   that package and leave an explicit removal condition: migrate when the
   TypeScript 7 API is available.
2. Validate all tsconfigs and generated declarations with the TypeScript 7 CLI;
   fix removed or changed compiler behaviour at the source, without casts or
   suppressed diagnostics.
3. Update the `srvx` optional peer range to the actually tested `^0.12.5` line
   and exercise Node serving against that version. Do not publish a dual legacy
   range or compatibility wrapper.
4. Install `@modelcontextprotocol/ext-apps@1.7.5` as a dev dependency and add a
   positive integration test for `inlineMcpAppBundle`. Preserve a packed
   consumer fixture that proves the optional peer still fails clearly when it
   is absent.
5. Pin the starter's `@types/bun` to `^1.3.14` so generated projects are
   reproducible while still receiving compatible updates.
6. Review every manifest and lockfile delta for accidental runtime additions,
   duplicate version lines and peer mismatches; document only consumer-visible
   changes in the changelog.
7. Run the complete repository and packed-consumer gates once the full 0.37.0
   implementation is ready.

## Acceptance

- [x] TypeScript 7 remains the CLI used by lint/typecheck/build scripts
- [x] The public-type guard uses the official TypeScript 6 API package and has a clear TypeScript 7.1+ removal trigger
- [x] All declarations and Node smoke checks pass without a Bun-type leak
- [x] The published `srvx` peer range matches the tested 0.12.5 line
- [x] The MCP Apps success path and missing-optional-peer path are both tested
- [x] The starter has no floating `latest` dependency specifier
- [x] `bun outdated --recursive` reports no outdated installed direct dependency at release validation time
- [x] The final `bun run verify` and packed-package consumer lane are green

## Что сделано

- [x] **Tooling:** TypeScript 7 remains the CLI; the semantic declaration walk
  imports the official side-by-side compiler API in
  `packages/core/scripts/check-public-types.mjs`.
- [x] **Package surface:** current MCP SDK, MCP Apps and `srvx` versions plus the
  tested `srvx ^0.12.5` peer are recorded in `packages/core/package.json` and
  `bun.lock`.
- [x] **Starter:** `@types/bun` is pinned to `^1.3.14` in
  `packages/starter/package.json`.
- [x] **Tests:** installed MCP Apps inlining is covered by
  `packages/core/tests/mcp-app.test.ts`; missing-peer behaviour is exercised by
  `packages/core/scripts/consumer-lane/fixtures/full/src/app.ts`.
- [x] **Upgrade fallout:** Biome's schema URL was updated and its newly enabled
  unsafe-optional-chain finding was fixed without a cast in
  `packages/core/tests/error-context.test.ts`.
- [x] **Docs:** the current Node peer and internal compiler split are recorded
  under `CHANGELOG.md` `[Unreleased]`.
- [x] **Gates:** `bun outdated --recursive` is empty; `bun run verify` passed
  with 816 tests, build/public-type guards, Node HTTP+Socket.IO smoke and both
  packed consumer fixtures.
