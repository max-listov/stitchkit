---
title: "ADR 0130: A headless harness composes the Agent runtime"
description: "The published facade packages resource-aware execution and optional direct coding tools without owning supervision, inference policy or a second durable loop."
type: decision
status: accepted
created: 2026-08-30
updated: 2026-08-30
---

# ADR 0130 — A headless harness composes the Agent runtime

## Context

The Agent runtime already owns durable admission, queueing, interruption, checkpoints, recovery,
tool fencing and terminal settlement. A reusable headless session also needs model resolution,
instructions/skills/resources, prompt budgets and a concrete tool profile. Leaving that composition
only in an example makes every host copy it; turning it into a daemon or another loop would split
the canonical state machine and absorb deployment policy into the framework.

Coding sessions additionally repeat file and process tools. A generic command gateway would erase
the direct operation identities and an implicit workspace or environment would grant authority the
framework cannot infer.

## Decision

Publish `stitchkit/agent-runtime/harness` as an evolving server-only facade over exactly one
`createAgentRuntime`. The caller supplies the store, protocol, per-run model resolver, resource
loader, direct tools and prompt-budget policy. Resources are typed and bounded before the provider
step. An observation-only applied-profile event records the actual model descriptor, resource
provenance and direct tool names without content or credentials. SQLite integration is composition
through the existing Bun and Node store leaves, not a harness-owned database.

Publish `stitchkit/agent-runtime/coding-tools` as a separate evolving server-only leaf. It produces
ordinary named runtime tools for bounded UTF-8 file read/write/edit and shell execution. Every
effect requires a host authorization decision. Paths are relative to an absolute root and checked
after realpath resolution; write/edit reject symlink targets. Shell receives an executable alias
from a finite host map and an argument array, inherits no environment implicitly, and has explicit
argument, output and timeout bounds. This root is not claimed to be an OS sandbox.

The framework owns no executable process, restart policy, control transport, workspace discovery,
credential resolution or application model catalog. Provider adapters stay caller-supplied, so a
model/provider switch does not require a new harness. Deferred catalogs compose through the
existing direct-activation surface; selected calls retain their actual tool identities.

Recovery remains the Agent runtime's explicit evidence policy. Completed history is read from the
canonical store and never blindly replayed. Idempotency of effects outside that store remains an
application transaction keyed by stable run/call identity.

## Consequences

- External supervisors can share one supported execution facade without adopting a framework
  daemon or duplicating the durable loop.
- Contract-only consumers load neither entrypoint; coding tools are isolated from the `ai` peer.
- Resource trust, executable authority and OS isolation remain visible host decisions rather than
  permissive defaults.
- The facade remains evolving until independent consumers prove its composition boundary.
