---
title: Consumer fixture IDE resolution
description: Keep checked-in consumer templates type-clean in editors without weakening packed-tarball verification.
type: task
status: done
created: 2026-08-07
updated: 2026-08-07
related: docs/backlog/done/2026-08-07-release-0.37.0-hardening.md
completed: 2026-08-07 07:19 +00:00
---

# Consumer fixture IDE resolution

## Plan

1. Give each checked-in fixture an editor-only path to the local stitchkit
   source so TypeScript can resolve public imports before a tarball exists.
2. Strip that path from the copied temporary tsconfig before installing and
   checking the packed package.
3. Typecheck all checked-in templates locally, then run the packed consumer
   lane to prove its isolation remains intact.

## Acceptance

- [x] All three checked-in fixture sources are clean in TypeScript
- [x] Packed fixtures resolve stitchkit exclusively from the generated tarball
- [x] Removed-API `@ts-expect-error` assertions remain active
- [x] The consumer lane is green

## Что сделано

- [x] **Editor resolution:** every fixture tsconfig maps `stitchkit` and its
      subpaths to `packages/core/src` only in the checked-in authoring copy.
- [x] **Tarball isolation:** `packages/core/scripts/consumer-lane/run.mjs`
      deletes `compilerOptions.paths` from each temporary copy before install
      and typecheck, so local source cannot satisfy the consumer gate.
- [x] **Validation:** minimal, full and Node fixture projects typecheck locally;
      lint and repository typecheck are green; all three packed consumers pass.
- [x] **Negative API tests:** both removed 0.37 API calls still consume their
      `@ts-expect-error` directives, proving the aliases did not weaken them.
