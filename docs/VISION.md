---
title: "stitchkit — Vision"
description: Contract-first backend framework for Bun and Node, with an optional application runtime for tool-using AI agents.
type: vision
status: active
created: 2025-05-01
updated: 2026-08-22
---

# stitchkit

Contract-first backend framework for Bun and Node.

One `defineContract()` → an HTTP API + MCP tools + AI-agent tools + a CLI + a typed client.

Applications that want Stitchkit to own the conversation mechanics may also opt
into the server-only agent runtime: durable run transitions, provider-valid
history, prompt/context composition, model adapters, streaming, managed-tool
fencing, delivery events and run observability. Applications that already own
those mechanics continue to use the low-level agent-tool surface directly.

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

## Status

Pre-1.0 and used by real applications. The shipped surface includes Bun and
Node HTTP adapters, contract and raw/binary responses, OpenAPI 3.1, typed
clients, Socket.IO, MCP contract and native tools, MCP Apps resources, agent
tools, CLI generation and request/tool observability. The optional agent application runtime is a
public server-only package surface. Its protocol, persistence reducer, recovery, race harness and
packed Bun/Node proof ship as one coherent slice; consumer-owned database, domain and transport
policy remain outside core.

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

The release-by-release plan is the root [`ROADMAP.md`](../ROADMAP.md).
