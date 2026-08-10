---
title: Agent-first adoption guide for generated applications
description: Generate an application-local AGENTS.md and a vertical feature guide so an agent can extend the starter without reconstructing its architecture.
type: task
status: done
created: 2026-08-10
updated: 2026-08-10
completed: 2026-08-10 13:39 +07:00
---

## Зачем

The generated README inventories the shipped stack, but it does not give an agent
the canonical path for adding a feature. A first-time consumer therefore has to
reverse-engineer the example and can easily duplicate DTOs, add raw routes or skip
the runtime gates. The generated application also lacks a compact local instruction
file describing its architecture and invariants.

## Результат

Every scaffolded application explains its own extension workflow without requiring
knowledge of the Stitchkit source repository. An agent can follow one vertical
feature from schema to runtime smoke and knows which architectural shortcuts are
forbidden.

## План

- [x] Add a generated root `AGENTS.md` scoped to application development, not Stitchkit contribution.
- [x] Document package ownership, import direction, the single env boundary, schema/contract separation, service registration and mandatory gates.
- [x] Explicitly prohibit duplicate DTOs, inline contract schemas, raw routes for contract-capable operations and consumer copies of framework internals.
- [x] Add `docs/ADDING_A_FEATURE.md` with one small vertical feature covering named Zod schema, contract, service implementation, surface registration, typed client, query/mutation, realtime cache update and smoke coverage.
- [x] Make all paths and commands accurate for both blank and example scaffold modes.
- [x] Link the feature guide from the generated README and `AGENTS.md`; keep detailed explanation in one place.
- [x] Extend scaffold tests to prove both files ship and contain no framework-contributor or private-consumer instructions.

## Acceptance

- [x] A fresh generated application contains `AGENTS.md` and `docs/ADDING_A_FEATURE.md`.
- [x] The guide is executable as written against the generated tree and names exact files or stable directories.
- [x] The guide covers the complete vertical path through HTTP, MCP/AGENT/CLI exposure, browser data access, realtime and gates.
- [x] Instructions clearly distinguish application-owned policy from framework-owned transport.
- [x] Generated documentation contains no private consumer names, absolute machine paths or Stitchkit maintainer-only release rules.
- [x] Packed starter lanes validate the generated documentation in both scaffold modes.

## Что сделано

- [x] Generated rules: application-local guidance added in `packages/create-stitchkit/template/AGENTS.md`.
- [x] Feature path: complete schema-to-gates workflow documented in `packages/create-stitchkit/template/docs/ADDING_A_FEATURE.md`.
- [x] Navigation: generated README links the canonical feature guide without duplicating it.
- [x] Gates: scaffold and packed blank/example lanes validate both documents and public-content hygiene.
