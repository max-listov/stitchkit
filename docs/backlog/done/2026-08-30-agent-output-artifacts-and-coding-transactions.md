---
title: Agent output artifacts and coding transactions
description: Preserve bounded previews of large output and add guarded search and patch transactions over host-owned storage.
type: task
status: done
created: 2026-08-30
updated: 2026-08-30
priority: P1
completed: 2026-08-30 04:01 +0000
pipeline: composable-agent-harness
order: 5
depends-on: 2026-08-30-agent-control-client-and-view.md, 2026-08-30-agent-approval-continuations.md
---

## Зачем

Killing a command at the presentation limit loses decisive diagnostics, while injecting complete
output consumes the model context. Exact-string edits are safe but do not provide a guarded,
reviewable patch operation.

## Результат

- A host-provided artifact sink reuses the managed file/reference boundary, receives bounded streamed bytes and returns opaque references;
  framework output contains a preview, measured size, truncation state and reference.
- References can be read in bounded slices without injecting the complete artifact. Artifact
  indexing/search remains a host-store capability rather than a second framework catalog.
- Bounded file-name/content search tools use the same contained walker as resource discovery and
  return exact relative paths and locations under declared roots.
- A single-file patch tool parses one canonical patch shape, validates a base digest, supports
  dry-run, authorizes the exact change and applies through same-directory atomic replacement.
- Multi-file atomicity is not claimed; it requires a future host transaction adapter.

## План

- [x] Define artifact sink/reference contracts, retention ownership and safe presentation.
- [x] Adapt shell output without making storage mandatory for small results.
- [x] Add bounded workspace search over the existing path boundary.
- [x] Implement guarded dry-run/apply single-file patch with exact base/result digest evidence.
- [x] Cover UTF-8 boundaries, argument/output/artifact caps, stale and concurrently changing files,
  symlinks and authorization of the exact transaction.

## Acceptance

- [x] Large output keeps a bounded model preview and a usable opaque reference without host paths.
- [x] A model can read referenced output through a direct typed tool and search workspace files
  through a separate direct typed tool.
- [x] Patch failure changes no target file; successful application returns the exact relative path.
- [x] Existing read/write/edit/shell tools retain their identities and small-output behavior.

## Что сделано

- Added bounded search, opaque artifact write/read, exact SHA-256 patch authorization and per-target
  compare-and-replace locking; shell caps argument count/bytes, preview, total artifact envelope and time.
- `packages/core/tests/agent-coding-tools.test.ts` — `serializes exact patch authorization and rejects a concurrent stale base`,
  `preserves large shell output behind an opaque readable artifact`, `rejects shell arguments whose aggregate encoding exceeds its byte budget`.
- Packed fixture `packages/core/scripts/consumer-lane/fixtures/node/src/headless-harness.mjs`
  executes search, approved patch, shell artifact and direct artifact read on Bun and Node.
