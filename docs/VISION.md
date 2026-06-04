---
title: "stitchkit — Vision"
description: Contract-first backend framework for Bun and Node. One defineContract() into an HTTP API, MCP tools, AI-agent tools, a CLI and a typed client.
type: vision
status: active
created: 2025-05-01
updated: 2026-05-29
---

# stitchkit

Contract-first backend framework for Bun and Node.

One `defineContract()` → an HTTP API + MCP tools + AI-agent tools + a CLI + a typed client.

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
- **Small.** ~8500 lines of source. No magic, no codegen, no build step in the
  consuming app.
- **Generic by design.** No domain-specific types — apps bring their own
  scopes, contexts and error codes.

## Status

Pre-1.0. The core is stable and tested, but the public API may still change
between minor versions until 1.0.

## Direction

- Stabilise the API toward 1.0 once it has been proven across more projects.
- OpenAPI generation from contracts.
- Broaden the examples beyond the bundled `starter`.

The release-by-release plan is the root [`ROADMAP.md`](../ROADMAP.md).
