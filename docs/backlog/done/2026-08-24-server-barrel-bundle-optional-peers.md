---
title: Keep the bundled server barrel free of unused optional Socket.IO peers
description: Make bindProcessSignals bundleable from stitchkit/server when Socket.IO peers are not installed, and pin the published-package regression.
type: task
status: done
created: 2026-08-24
updated: 2026-08-24
completed: 2026-08-24 01:26 +00:00
related:
  - docs/decisions/0008-thin-wrappers.md
  - docs/backlog/done/2026-08-06-the-published-package-is-tested-as-a-consumer-uses-it.md
  - docs/backlog/done/2026-08-17-process-signal-shutdown-binding.md
---

# Keep the bundled server barrel free of unused optional Socket.IO peers

## Зачем

The published `stitchkit/server` barrel exposes both peer-free process lifecycle primitives and the
optional Socket.IO adapter. Its runtime imports are lazy, but literal dynamic import specifiers are
still resolved by consumer bundlers. A bundled application that imports only `bindProcessSignals`
therefore fails unless it installs unused `socket.io` and `@socket.io/bun-engine` peers.

## Результат

- `bindProcessSignals` can be bundled from the published `stitchkit/server` entrypoint with only the
  minimal documented dependencies installed.
- Opting into `createSocketIOServer` still loads the peers at runtime and preserves the actionable
  missing-peer error.
- The packed minimal consumer lane catches any future literal optional-peer import in this path.

## План

- [x] Reproduce the failure by bundling a minimal packed consumer that imports
      `bindProcessSignals` from `stitchkit/server`.
- [x] Keep Socket.IO loading runtime-lazy and opaque to bundlers without changing the public API.
- [x] Inspect the bundle metafile and execute the resulting bundle without optional peers.
- [x] Document the patch in the changelog and run the complete release gates.

## Acceptance

- [x] The packed minimal fixture has no installed Socket.IO packages.
- [x] Its server-signal bundle succeeds with `--packages=bundle`, contains no Socket.IO package
      inputs and executes successfully.
- [x] Existing Socket.IO tests and missing-peer diagnostics remain green.
- [x] `bun run verify` is green before the patch release.

## Что сделано

### Runtime boundary

- [x] `packages/core/src/server/socket-io.ts` keeps both optional peer specifiers behind
      non-literal runtime imports, while retaining erased type-only module annotations and the
      existing actionable `importPeer` diagnostic.

### Published-package regression

- [x] `packages/core/scripts/consumer-lane/fixtures/minimal/src/server-signal-bundle.ts` imports only
      `bindProcessSignals` from `stitchkit/server`, closes the idle binding and executes from the
      bundled packed package without Socket.IO installed.
- [x] `packages/core/scripts/consumer-lane/fixtures/minimal/src/missing-socket-peer.mjs` proves that
      explicit adapter use still identifies `createSocketIOServer` and the missing `socket.io` peer.
- [x] `packages/core/scripts/consumer-lane/run.mjs` rejects accidentally installed peers, bundles
      with `--packages=bundle`, inspects the metafile for Socket.IO inputs and runs both positive and
      negative public paths.

### Gates and release notes

- [x] `CHANGELOG.md` records the additive patch under `[Unreleased]`; there is no public API change.
- [x] `bun test packages/core/tests/process-signals.test.ts packages/core/tests/socket-io.test.ts
      packages/core/tests/socket-io-handshake.test.ts` passed 71 tests with zero failures.
- [x] `bun run verify` passed: lint, typecheck, 1,532 core tests, PostgreSQL store proof, build, Node
      and Next smoke, packed consumer lane, and both complete starter browser matrices.
