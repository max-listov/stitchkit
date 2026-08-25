---
title: "stitchkit — Vision"
description: Contract-first backend framework for Bun and Node, with optional process-local application and agent runtimes.
type: vision
status: active
created: 2025-05-01
updated: 2026-08-23
---

# stitchkit

Contract-first backend framework for Bun and Node.

One `defineContract()` → an HTTP API + MCP tools + AI-agent tools + a CLI + a typed client.

Applications that want Stitchkit to own the conversation mechanics may also opt
into the server-only agent runtime: durable run transitions, provider-valid
history, prompt/context composition, model adapters, streaming, managed-tool
fencing, delivery events and run observability. Applications that already own
those mechanics continue to use the low-level agent-tool surface directly.

Applications that repeat dependency-aware startup, readiness, admission,
periodic timers and ordered shutdown may opt into the server-only managed
application kernel. It composes resources inside one process; durable work,
provider policy, process supervision and deployment remain outside Stitchkit.

## The problem

A modern backend has to expose the *same* operations several ways: as an HTTP
API for the app, as [MCP](https://modelcontextprotocol.io) tools for assistants
like Claude and Cursor, as tool definitions for AI agents, and as a CLI for
scripts, Skills and the terminal. Done by hand, that is the same surface
described many times — many places to drift, many places to keep typed.

## The idea

Describe each operation once — method, path, Zod schemas, scope, which
transports it is exposed on. From that single contract stitchkit derives the
HTTP route, the MCP tool, the agent tool, the CLI command and a fully-typed
client. One source of truth; the transports cannot drift.

## Core principles

- **One contract, every surface.** Define the API once — get HTTP, MCP, agent
  tools, a CLI and a typed client, all typed from the same declaration.
- **Zero HTTP-framework dependency.** Built on `Bun.serve()` (Bun) or `srvx`
  (Node). No Hono, no Elysia, no Express.
- **Thin over what you already use.** WebSocket is Socket.IO; the React data
  layer is `react-query-kit`. stitchkit owns the contract and the transport —
  it does not ship a competing WebSocket engine or hook library.
- **Inspectable.** A focused core with explicit adapters and no generated
  application code or framework build step in the consuming app. Public
  behaviour is pinned by source tests, runtime smoke tests and packed-consumer
  checks.
- **Generic by design.** No domain-specific types — apps bring their own
  scopes, contexts and error codes.
- **Optional application runtime, not a job platform.** Stitchkit may own a
  tool-using agent's process-local execution protocol and typed persistence
  boundary. Applications still own their database adapter, distributed lease,
  domain prompts and tools, transport/UI, and idempotency of external effects.
- **Process-local composition, not process management.** The managed application
  kernel may own resource ordering, readiness, ephemeral schedules, admission
  and bounded shutdown inside one process. Applications and deployment tooling
  retain durable jobs, provider protocols, restart policy and process placement.
- **Every entrypoint says how settled it is.** The contract, HTTP, client, tool,
  CLI, observability and testing surfaces are **stable**: they change rarely and
  only for a reason worth a migration. The declaration, the agent runtime and the application
  kernel are **evolving**: their shape is still being found and may be redefined
  in any minor, always with a marked breaking change and a migration section,
  never silently. Both are legitimate to build on — the declaration exists so
  the choice is informed rather than discovered. Promoting a surface from
  evolving to stable is its own decision, recorded as an ADR.

## Status

Pre-1.0 and used by real applications. The shipped surface includes Bun and
Node HTTP adapters, contract and raw/binary responses, OpenAPI 3.1, typed
clients, Socket.IO, MCP contract and native tools, MCP Apps resources, agent
tools, CLI generation and request/tool observability. The optional agent application runtime is a
public server-only package surface. Its protocol, persistence reducer, recovery, race harness and
packed Bun/Node proof ship as one coherent slice; consumer-owned database, domain and transport
policy remain outside core.

A project also describes itself once. `stitchkit/declaration` ships the project
declaration — identity, roles, build, runtime requirements, release steps and
the names of the variables a deployment supplies — so the project, the
scaffolder and whatever binds an artifact into a deployment read one versioned
schema instead of three copies. Its boundary is enforced by shape: there is
nowhere in it to put a port, a host, an address, a machine path or a
supervision policy, because none of those are true of the code.

The additive managed application kernel is the equivalent server-only
composition surface for ordinary process resources. It builds on the existing
managed-server and signal primitives without becoming a distributed scheduler,
provider framework or deployment plane.

Breaking changes are still allowed between minor versions, but never silently:
each one has a mechanical migration in the changelog and is exercised through
the published package before release.

## Direction

- Stabilise the API toward 1.0 through evidence from real consumers rather than
  speculative abstraction.
- Keep the guide, API reference, generated agent-facing docs and migration notes
  aligned with the public surface.
- Grow the packed official starter only where it clarifies already-shipped
  capabilities without moving frontend infrastructure into the framework.
- Remove copied agent-runtime mechanics from consuming applications through a
  server-only additive entrypoint, while retaining `mountAgent` as the smaller
  independent composition path.
- Remove copied process lifecycle, timer, admission and operational-projection
  mechanics through an optional provider-neutral application entrypoint, while
  retaining the lower-level server and signal primitives.

The release-by-release plan is the root [`ROADMAP.md`](../ROADMAP.md).
