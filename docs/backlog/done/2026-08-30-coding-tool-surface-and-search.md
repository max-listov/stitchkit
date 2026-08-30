---
title: Coding tool surface and bounded search
description: Give coding agents concise direct tool identities and make workspace search tolerate ordinary dependency trees without escaping its bounds.
type: task
status: done
created: 2026-08-30
updated: 2026-08-30
pipeline: agent-tui-productization
order: 1
depends-on: —
completed: 2026-08-30
---

# Coding tool surface and bounded search

## Зачем

The coding leaf exposes implementation-prefixed names even though each mounted tool already has a
canonical service/action identity. Its search walker also treats an ordinary symlink anywhere in a
workspace as a fatal traversal error, which makes dependency directories turn a bounded search
into an opaque internal tool failure.

## Результат

- Direct model-visible names are concise operation names: `read_file`, `write_file`,
  `apply_patch`, `search_files`, `run_command`, `read_output` and `read_resource`.
- Canonical lifecycle identity remains `coding` plus the exact action; collision validation stays
  in the existing surface collector.
- `read_file` returns the digest required by `apply_patch`; the weaker unguarded edit operation is
  removed rather than kept as a competing write path.
- `run_command` exposes only configured executable aliases in its schema and is omitted when none
  exist.
- Workspace search has explicit exclude rules, skips non-selected symlinks safely, reports scan
  diagnostics and never walks outside the canonical root.
- Expected coding failures use a stable public error contract while the original cause remains
  available to internal observation.

## План

- [x] Define one exported name set and update all coding-tool definitions and approval policies.
- [x] Separate resource traversal strictness from workspace-search traversal policy.
- [x] Add bounded default excludes for dependency, VCS, build and runtime-state directories with a
  host override.
- [x] Preserve path, byte, file-count, depth, cancellation and output limits.
- [x] Return useful bounded results with `truncated` and scanned/skipped counts when a search budget
  is reached.
- [x] Update public docs, fixtures and migration notes for the breaking rename.

## Acceptance

- [x] A Bun workspace containing dependency symlinks can search paths and content successfully.
- [x] A symlink target outside the root is never read or returned.
- [x] Exact tests cover all public names, collision failure, excludes, limits and normalized errors.
- [x] The command input schema enumerates declared aliases and rejects an undeclared command before
  execution.
- [x] Existing direct lifecycle and durable tool-call identity tests remain green.

## Что сделано

The coding leaf now exposes direct operation names, one digest-guarded patch path, declared command
aliases and bounded search that excludes dependency, VCS, build and runtime state while refusing
root and symlink escapes. Public references and the breaking migration note use the same surface.

## Регрессия

- `packages/core/tests/agent-coding-tools.test.ts` — `searches an installed workspace without
  following dependency symlinks or runtime state`.
- `packages/core/tests/agent-coding-tools.test.ts` — `preserves direct identities across bounded
  read, write, patch and command calls`.
- `packages/core/tests/agent-coding-tools.test.ts` — `fails closed on denied operations, path
  escapes and symlink escapes`.
