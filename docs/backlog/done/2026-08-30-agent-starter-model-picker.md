---
title: Agent starter model picker
description: Select a live tool-capable OpenRouter model inside the terminal before the durable Agent harness starts.
type: task
status: done
created: 2026-08-30
updated: 2026-08-30
completed: 2026-08-30 05:10 +0000
---

# Agent starter model picker

## Why

The Agent starter can run a real coding loop, but asking a developer to copy a model id and its
context window into environment variables makes the first launch configuration-heavy and lets
catalog metadata drift. The provider catalog already owns both facts.

## Result

- The terminal opens with a bounded model picker sourced from the live OpenRouter catalog.
- Only tool-capable text models can be selected, and the chosen catalog context window configures
  the harness budget.
- A local ignored credential is enough for the repository preview to start with one command.

## Acceptance

- [x] Startup requires only `OPENROUTER_API_KEY`; `OPENROUTER_MODEL` is an optional preferred row.
- [x] Catalog loading has a timeout, validates the provider response and fails closed.
- [x] The model picker supports keyboard navigation and shows exact model identity and context.
- [x] Selecting a model starts the same durable harness without adding a second execution loop.
- [x] Config, catalog and runtime regression tests are green.
- [x] Starter documentation and declaration describe the one-command preview.

## What was done

- [x] [`src/models.ts`](../../../packages/create-stitchkit/templates/agent/src/models.ts) owns the
  bounded validated live-catalog projection, filtering missing context metadata and non-tool rows.
- [x] [`src/App.tsx`](../../../packages/create-stitchkit/templates/agent/src/App.tsx) renders the
  keyboard model picker and submits the exact input value delivered by OpenTUI.
- [x] [`src/index.tsx`](../../../packages/create-stitchkit/templates/agent/src/index.tsx) starts the
  canonical harness only after a catalog model is selected.
- [x] The ignored local `.env` contains a reused owned credential with mode `600`; a live PTY
  selected `openai/gpt-5.6-luna` and completed a real model turn.
- [x] Regression coverage:
  - `packages/create-stitchkit/templates/agent/tests/config.test.ts` —
    `requires only an OpenRouter credential and accepts an optional preferred model`.
  - `packages/create-stitchkit/templates/agent/tests/models.test.ts` —
    `keeps a bounded tool-capable projection with provider-owned context windows` and
    `fails closed on provider errors and an unusable catalog`.
  - `packages/create-stitchkit/templates/agent/tests/runtime.test.ts` —
    `runs one model turn and reopens its durable transcript`.
  - `packages/create-stitchkit/tests/scaffold.test.ts` —
    `materialises the Agent template with the canonical catalog and no app identity module`.
