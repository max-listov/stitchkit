---
title: Published composable headless harness for externally supervised agent sessions
description: Package reusable agent-runtime composition and optional coding tools without taking over host supervision, application policy or inference transport.
type: task
status: done
created: 2026-08-30
updated: 2026-08-30
priority: P1
completed: 2026-08-30 01:52 +0000
---

## Problem

`packages/core/examples/headless-agent-harness.ts` already composes `createAgentRuntime` with
resource loading, prompt budgets and provenance. A host supervisor needs to run this kind of
provider-neutral agent as a real session without copying an example or rebuilding queue,
compaction, tool lifecycle, persistence and cancellation in each consumer.

## Scope

Build on the published AgentRuntime, SQLite adapters, tools and managed application kernel.
Inventory existing exports first; do not add a parallel loop, store, queue or process supervisor.
The harness belongs to an optional server-only Stitchkit surface in this repository. Select and
document the exact public entrypoint; a new repository, brand, daemon, fleet identity or obligatory
dependency of the contract core is not required.

Stitchkit owns reusable process-local execution. Host composition owns executable lifecycle,
workspace/configuration and secret resolution. Applications supply instructions, skill resources,
tool allowlists and model catalogs. No private project names, host paths, model IDs, credentials or
fleet transport knowledge enter core.

## Result

- Supported public composition facade with typed model resolver, resource/skill/tool inputs,
  applied capability/provenance evidence, SQLite integration and bounded lifecycle.
- An executable reference runner demonstrates structured control/events and correct shutdown;
  consumers can package it without importing example internals. It is not a fleet daemon or TUI.
- Optional reusable coding-tool primitives for shell and filesystem read/write/edit, or explicit
  composition over existing primitives if already available. Require host-owned permission policy,
  cancellation, bounded output and concrete working directory. Cwd is not claimed to be a sandbox.
- Native direct tool identities; deferred discovery reuses the existing deferred tool surface.
- Inference comes from caller-provided adapters. Different models/providers do not require new
  harness implementations; credentials and endpoints remain host-owned.

## Plan

- [x] Inventory public runtime/harness exports; document the smallest missing composition seam.
- [x] Publish optional facade and runnable structured example, retaining the existing runtime store.
- [x] Provide or compose optional project tools without business prompts or implicit full access.
- [x] Specify capabilities, request/response/interrupt semantics, ordered event/snapshot recovery,
  durable terminal reasons and ownership of external side-effect idempotency.
- [x] Verify one model switch between caller-supplied adapters, tools, cancellation and store reopen.
- [x] Update guide/API/agent-facing docs and packed Bun/Node consumer evidence; prepare the additive
  release record. Publication is intentionally deferred to the separately requested release command.

## Acceptance

- [x] A packed consumer runs a real tool-using session from the public package, no source/example imports.
- [x] Two model adapters share the same runtime/tool profile while preserving actual model identity.
- [x] A stopped/reopened process retains its conversation and does not blindly replay side effects.
- [x] Context overflow, interrupted calls, missing tools and provider failures have explicit outcomes.
- [x] No process placement/restart policy, application model catalog or transport-specific control
  plane is absorbed into core. Optional tools/harness do not load for contract-only consumers.
- [x] The release-ready changelog and reference report exact public exports, verified consumer
  recipes and remaining host responsibilities. Actual release/rollout is excluded from this task
  by explicit instruction and awaits a separate command.

## Что сделано

- Добавлены evolving server-only entrypoints `stitchkit/agent-runtime/harness` и
  `stitchkit/agent-runtime/coding-tools`. Первый композиционно использует единственный
  `createAgentRuntime`; второй отдаёт прямые bounded file/shell runtime tools с обязательной host
  authorization. ADR 0130 фиксирует границы supervision, inference, workspace и persistence.
- Structured runner показывает typed `submit` / `interrupt` / `snapshot` / bounded `close` без
  собственного daemon, transport или process policy. Public docs, maturity inventory, surface
  snapshot, Node smoke, optional-peer matrix и generated agent docs синхронизированы.
- Проверка модели и профиля: `packages/core/tests/agent-harness-public.test.ts` —
  `switches caller-provided models without changing direct tool or resource identity`.
- Проверка durable reopen без replay: `packages/core/tests/agent-harness-public.test.ts` —
  `store reopen retains completed tool history and recover does not replay it`.
- Проверка coding tools: `packages/core/tests/agent-coding-tools.test.ts` —
  `preserves direct identities across bounded read, write, edit and shell calls`,
  `fails closed on denied operations, path escapes and symlink escapes`,
  `bounds shell output, timeout and cancellation`.
- Проверка control loop: `packages/core/tests/headless-agent-runner.test.ts` —
  `admits, interrupts, snapshots and closes through typed controls`.
- Канонические explicit outcomes сохранены тестами
  `packages/core/tests/agent-runtime-prompt-models.test.ts` —
  `reservation overflow is irreducible even with empty history`,
  `packages/core/tests/agent-runtime-terminal.test.ts` —
  `commits a provider failure when prompt construction fails before streaming`, и
  `packages/core/tests/agent-runtime-deferred-tools.test.ts` —
  `repairs a known inactive direct call through SEARCH_REQUIRED but leaves unknown calls failed`.
- `bun run verify` зелёный на tree `2c3b5a70a4fc`: lint, typecheck, 1,955 core tests, 26
  scaffolder tests, 153 root-script tests, 95 template tests, 7 PostgreSQL tests, build, Next SSR,
  Node smoke, packed Bun/Node consumers, обе starter lanes и supervised PM2 lane.
