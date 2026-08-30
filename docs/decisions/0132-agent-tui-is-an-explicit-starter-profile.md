---
title: "ADR 0132: Agent TUI is an explicit starter profile"
description: "The official scaffolder may compose the headless harness into an OpenTUI host without moving a renderer or product policy into core."
type: decision
status: accepted
created: 2026-08-30
updated: 2026-08-30
---

# ADR 0132 — Agent TUI is an explicit starter profile

## Context

The headless Agent harness deliberately owns no process or renderer. That boundary is correct for
applications, but it leaves the first useful terminal session behind substantial integration work:
provider configuration, durable storage, resources, direct tools, approvals, recovery, event
projection and input focus all have to agree before a developer can type one request.

Adding those choices to the general application template would impose Agent and terminal
dependencies on unrelated HTTP applications. Putting a TUI in core would turn one replaceable
view technology into framework policy and risk a second execution loop around the canonical one.

## Decision

`create-stitchkit` exposes `--template agent` beside its unchanged default `application` profile.
The Agent template is a host composition, not a new runtime: OpenTUI React renders canonical
snapshots and transient events; `createHeadlessAgentHarness` remains the only model loop;
`mountAgent` mounts direct coding/resource tools with the runtime fence; the Bun SQLite leaf owns
durable storage; and the isolated OpenRouter adapter supplies one explicitly configured model.

The generated project owns model choice, context window, executable allowlist, workspace path,
approval policy and process isolation. Reads and bounded search are pre-approved in the example;
writes, edits, patches and shell calls use signed durable user approval. The UI derives pending
approval from history and never remembers a parallel decision.

The application template remains the single source of the scaffolder's Stitchkit catalog target.
The repository copy of the Agent template uses a local file dependency so it can exercise framework
HEAD; scaffolding replaces that development edge with `catalog:` and injects the canonical target.
Its development lockfile is neither copied nor packed.

## Consequences

- A developer can inspect and hot-reload a real terminal host without first designing one.
- Applications can replace OpenTUI, OpenRouter, SQLite, tools or policy independently because none
  crosses into core.
- The opt-in template carries terminal/provider peers; the default application carries none of
  them.
- A generated Agent project is a path-confined example, not an OS sandbox or background PTY
  supervisor.
- Framework and scaffolder releases remain independent; the Agent template becomes installable
  from the registry when the scaffolder's canonical target advances to the harness release.
