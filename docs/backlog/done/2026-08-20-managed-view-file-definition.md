---
title: Managed definition for the generic view-file tool
description: Give protected multimodal media inspection the same canonical runtime-tool lifecycle as managed wait, download and upload operations.
type: task
status: done
created: 2026-08-20
updated: 2026-08-20
completed: 2026-08-20 09:50 +00:00
related: 2026-08-20-managed-native-mcp-tools.md
---

# Managed `view_file` definition

## Зачем

`mountViewFile` is still a direct MCP SDK registrar. A consumer that needs the
same media operation on protected MCP and Agent surfaces must currently build a
local `defineRuntimeTool` wrapper around `resolveMedia`: repeat the input/output
schemas, batch loop, per-item failure presentation and MCP/Agent multimodal
presenters. Its local stdio surface then either keeps a second raw registration
or duplicates that wrapper again.

The hard media mechanics already belong to Stitchkit: guarded URL fetching,
local-path containment, MIME handling, byte caps and conversion into MCP media
content. Requiring every consumer to reconstruct the managed definition leaves
one generic framework operation with two lifecycle contracts and several places
for its security and presentation semantics to drift.

## Результат

- A Zod-first managed factory (working name `defineViewFileTool`) returns an
  ordinary `RuntimeToolDefinition` for explicit MCP/Agent surfaces.
- One definition can be reused by remote MCP, local stdio MCP and Agent mounts;
  calls receive canonical input/output validation, application context,
  lifecycle/RBAC, hooks, cancellation, name collision checks and surface
  introspection.
- The factory owns the generic batch semantics and MCP/Agent multimodal
  presentation while exposing only policy inputs such as URL-only versus an
  explicit sandboxed `baseDir`.
- `mountViewFile` remains the intentional low-level raw MCP adapter and shares
  the same transport-neutral media operation rather than becoming a compat
  alias.

## Границы

- No domain-specific media model, storage provider, authorization policy or
  result naming enters core.
- Local filesystem access stays disabled unless the consumer explicitly gives
  a sandbox root; managed lifecycle does not weaken the existing SSRF, path or
  byte boundaries.
- Batch-wide byte accounting must remain one shared budget. Calling the current
  public single-item `resolveMedia` independently is not equivalent if it lets
  every item consume the full cap.
- This task does not add media rendering to the CLI transport.

## Перед планированием

- Decide whether the shared core should expose a batch-neutral operation and
  canonical media Zod schemas, or keep both private behind the raw and managed
  adapters.
- Pin the exact success/failure contract for mixed batches: one bad item should
  not hide valid media, but a partial result must still be observable honestly
  by hooks and presenters.
- Prove the real MCP and Agent presentations plus local-path and SSRF boundaries
  without relying only on a mocked SDK registrar.

## План

- [x] Extract one batch-neutral media operation with shared byte accounting and
      canonical Zod schemas for its neutral content result.
- [x] Add `defineViewFileTool` over the canonical runtime runner, with MCP and
      Agent presenters and explicit transport/security policy.
- [x] Rebuild `mountViewFile` as the raw presentation adapter over the same core.
- [x] Export the public factory/types/schemas and cover the packed public surface.
- [x] Add real MCP, Agent, lifecycle/hook, mixed-batch, cancellation and security
      regressions; update docs, ADR/index and changelog.

## Acceptance

- [x] One managed definition executes on MCP and Agent with identical neutral
      output, operation identity, lifecycle and hook behavior.
- [x] Mixed batches preserve valid media and honest per-item errors under one
      total byte budget; cancellation reaches remote fetches.
- [x] URL SSRF and local sandbox/symlink boundaries remain enforced.
- [x] The raw mount preserves its public MCP envelope while sharing the neutral
      operation.
- [x] `bun run verify` is green.

## Конвейер 0/0

- [x] Plan validators: intentionally none by owner request.
- [x] Implementation and authorized gates completed by the primary agent.
- [x] Implementation validators: intentionally none by owner request.

## Что сделано

- [x] Added Zod-first `defineViewFileTool`, canonical input/output/media schemas
      and a neutral mixed-batch result with structured per-item failures.
- [x] Managed MCP and Agent presentations, operation identity, lifecycle, hooks
      and cancellation run through the ordinary runtime-tool pipeline.
- [x] Raw `mountViewFile` preserves its content-only envelope over the same
      SSRF/path-safe batch core and one total 20 MB read/inline budget.
- [x] ADR 0082, MCP architecture/guide, API reference, changelog, exact public
      surface and packed consumer fixture are synchronized.
- [x] Регрессия: packages/core/tests/managed-view-file.test.ts::one definition preserves MCP/Agent media and honest mixed-batch errors; packages/core/tests/managed-view-file.test.ts::the raw mount keeps its content-only MCP envelope over the shared operation; packages/core/tests/managed-view-file.test.ts::a batch shares one total inline byte budget; packages/core/tests/managed-view-file.test.ts::managed cancellation reaches the guarded fetch instead of becoming an item error; packages/core/tests/security.test.ts::refuses a path escaping the sandbox; packages/core/tests/security.test.ts::refuses a symlink that points outside the sandbox; packages/core/tests/security.test.ts::local file access is disabled without a managed boundary.
- [x] `bun run verify` completed with exit 0 on 2026-08-20; no release, commit,
      tag or push was performed.
