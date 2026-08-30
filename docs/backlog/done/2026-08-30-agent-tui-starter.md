---
title: Agent TUI starter
description: Scaffold a runnable OpenRouter coding agent with a polished terminal interface over the canonical headless harness.
type: task
status: done
created: 2026-08-30
updated: 2026-08-30
completed: 2026-08-30
---

# Agent TUI starter

## Problem

The published headless harness provides the durable runtime, resources, direct tools,
approvals and control protocol, but a developer still has to assemble a terminal host before
they can type a request and see the complete interaction. The general application starter is
the wrong place to impose that product shell, and a copied example would drift from the
scaffolder lifecycle.

## Desired result

- `create-stitchkit` exposes an explicit Agent template without changing the default application
  template or its examples.
- A generated Agent project starts with one documented command, supports source-watch restarts,
  and connects to OpenRouter through environment-owned credentials and an explicit model id.
- The TUI presents a bounded transcript, run/tool state, durable approval decisions and useful
  empty/error states without implementing another model or tool loop.
- The generated workspace composes the canonical headless harness, Bun SQLite store, file
  resources, direct coding tools and `mountAgent` lifecycle.
- The source template is runnable against this repository while generated projects receive the
  starter's single canonical Stitchkit catalog target.
- Parser, scaffolding, rendering and a real non-interactive harness smoke have regression
  coverage.
- Public guides, package contents and changelogs document the new opt-in road.

## Non-goals

- Making TUI dependencies part of `stitchkit` core.
- Replacing application-owned model, permission, sandbox or supervision policy.
- A generic remote tool gateway, provider-specific hosted MCP surface or background PTY manager.
- Changing the existing application template or repository example into an Agent application.

## Acceptance

- [x] `bun create stitchkit <directory> --template agent` produces the intended project and rejects
  incompatible option combinations.
- [x] `bun run dev` opens the interactive terminal host with hot source reload.
- [x] OpenRouter, SQLite recovery, resources, skills, direct coding tools and approvals are wired
  through published Stitchkit entrypoints.
- [x] The UI remains readable at narrow terminal sizes and bounds growing history.
- [x] Generated dependency metadata has one Stitchkit target shared with the application starter.
- [x] Exact regression tests and package/build gates are green.
- [x] Documentation and changelogs describe setup, boundaries and extension points.

## What was done

- Added the explicit `--template agent` scaffolder profile while preserving the application
  default and its single canonical Stitchkit catalog target.
- Added a source-watch OpenTUI host over `createHeadlessAgentHarness` with OpenRouter, durable Bun
  SQLite history, bounded transcript rendering, file resources, skills, direct coding tools and
  signed approval continuations.
- Kept runtime state, secrets, dependencies, locks and build output out of both generated projects
  and the published scaffolder archive.
- Visually exercised the setup and ready states in a real narrow PTY and ran the generated-project
  scaffold probe.
- Regression coverage:
  - `packages/create-stitchkit/tests/options.test.ts` —
    `parses the agent template and rejects application-only overlays`.
  - `packages/create-stitchkit/tests/scaffold.test.ts` —
    `materialises the Agent template with the canonical catalog and no app identity module` and
    `excludes runtime artifacts from scaffold and package inputs`.
  - `packages/create-stitchkit/templates/agent/tests/config.test.ts` —
    `requires explicit OpenRouter credentials, model and context window`.
  - `packages/create-stitchkit/templates/agent/tests/view.test.ts` —
    `bounds durable messages and retains direct tool identity`.
  - `packages/create-stitchkit/templates/agent/tests/runtime.test.ts` —
    `runs one model turn and reopens its durable transcript`.
