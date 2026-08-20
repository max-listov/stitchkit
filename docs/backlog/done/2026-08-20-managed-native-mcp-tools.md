---
title: Managed definitions for generic wait, download and upload tools
description: Give the generic imperative tools canonical runtime-tool lifecycle, typed schemas, context, hooks, cancellation and surface introspection.
type: task
status: done
created: 2026-08-20
updated: 2026-08-20
completed: 2026-08-20 08:53 +00:00
---

# Managed definitions for generic wait, download and upload tools

## Зачем

`mountWait`, `mountDownload` and `mountUpload` are direct MCP SDK registrars.
Consumers therefore have to attach them through `rawTools`, even though that API
is explicitly an unprotected escape hatch: calls bypass Stitchkit lifecycle,
per-call application context, tool hooks, canonical schema preparation and the
runtime-tool manifest.

The mechanism is framework-owned by ADR 0019, while ADR 0055/0057 establish that
managed pathless operations are immutable `RuntimeToolDefinition` data, not a
second registrar callback. A consumer must not copy polling, guarded download,
filesystem write or upload mechanics merely to enter the canonical runner.

## Результат

- `defineWaitTool`, `defineDownloadTool` and `defineUploadTool` return ordinary
  `RuntimeToolDefinition` values for `runtimeTools` and Agent surfaces.
- Managed and direct MCP forms are thin adapters over the same transport-neutral
  operations; polling/fetch/write/upload mechanics have one implementation.
- Managed calls receive input/output validation, context, lifecycle/RBAC, hooks,
  cancellation and manifest/name-collision behavior from the existing runner.
- Existing `mount*` functions remain intentional low-level MCP adapters with
  their current text-envelope contract. They are not deprecated aliases or a
  competing managed path.

## Semantics

- Managed success returns neutral validated data. MCP/Agent adapters present it
  through their existing runtime-tool rules.
- Managed failures throw into the canonical `AppError -> ToolResult` path so
  hooks and lifecycle record a failure. They do not return a successful payload
  carrying `isError`.
- Raw mounts preserve their existing MCP text and `isError` framing by adapting
  the same operation result/error themselves. Byte-identical raw and managed
  envelopes are not promised because the managed failure contract is different
  by design.
- The active call's `AbortSignal` must stop wait sleeps/polls and guarded
  downloads. Upload implementations receive it with their typed call context.

## План

- [x] Extract typed neutral wait/download/upload operations. Extend the shared
      polling engine with abort-aware sleep without duplicating its schedule.
- [x] Implement three Zod-first managed definition factories with stable
      operation identity, explicit transport exposure and typed callbacks.
- [x] Rebuild `mountWait`, `mountDownload` and `mountUpload` as raw presentation
      adapters over those operations, preserving their public behavior.
- [x] Export the factories/config/result types and include them in public-surface
      and packed-consumer checks.
- [x] Add MCP, Agent, lifecycle/hook, manifest, cancellation, failure and raw
      compatibility regressions.
- [x] Record the ADR 0019/0055/0057 extension in a new immutable ADR, then
      update the guide, architecture note, API reference and changelog.

## Acceptance

- [x] Managed success/failure traverses standard hooks with correct operation
      identity; lifecycle can reject an effectful call before its operation runs.
- [x] Managed wait/download/upload inputs and outputs are Zod-validated; their
      names/input schemas and exposure are visible in `buildToolManifest`,
      `listToolNames` and transport summaries.
- [x] An aborted wait performs no later poll, and an aborted download forwards
      the call signal into the guarded fetch boundary.
- [x] MCP and Agent execute the same neutral definition without consumer-owned
      polling/fetch/write/upload wrappers.
- [x] Existing raw mounts retain their tested text-envelope behavior while
      sharing the neutral operations.
- [x] Packed public consumer and `bun run verify` are green.

## Конвейер 0/0

- [x] Plan validators: intentionally none by owner request.
- [x] Implementation and authorized gates completed by the primary agent.
- [x] Implementation validators: intentionally none by owner request.

## Границы

- `mountViewFile` remains its existing separate raw/media boundary.
- No consumer-project edits, release, commit, tag or publish in this task.

## Что сделано

- [x] Added `defineWaitTool`, `defineDownloadTool` and `defineUploadTool` as
      ordinary `RuntimeToolDefinition` factories with Zod schemas, stable
      operation identity and MCP/Agent exposure.
- [x] Extracted shared neutral wait/download/upload operations; wait sleep is
      abort-aware with the check/listen race closed, guarded download receives
      the active signal, and upload callbacks receive typed call context.
- [x] Raw `mountWait`, `mountDownload` and `mountUpload` now adapt those shared
      operations while preserving their text/`isError` contract.
- [x] ADR 0081, MCP architecture/guide, API reference, changelog, exact public
      surface and packed consumer fixture are synchronized.
- [x] Регрессия: packages/core/tests/managed-native-tools.test.ts::wait shares one definition across MCP, Agent, lifecycle, hooks and introspection; packages/core/tests/managed-native-tools.test.ts::lifecycle rejects an effectful managed call before its operation runs; packages/core/tests/managed-native-tools.test.ts::wait cancellation interrupts the current sleep and performs no later poll; packages/core/tests/managed-native-tools.test.ts::download validates neutral output and forwards cancellation to guarded fetch; packages/core/tests/managed-native-tools.test.ts::upload is a typed managed operation on MCP and Agent; packages/core/tests/native-tools.test.ts::an HTTP failure keeps the raw mount error prefix exactly once.
- [x] `bun run consumer-lane` and the complete `bun run verify` completed with
      exit 0 on 2026-08-20; no release, commit, tag or push was performed.
