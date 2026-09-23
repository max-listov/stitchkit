---
title: "stitchkit — Vision"
description: Contract-first backend framework for Bun and Node — where it is going, not what it must never break.
type: vision
status: active
created: 2025-05-01
updated: 2026-09-23
---

# stitchkit

Contract-first backend framework for Bun and Node.

One `defineContract()` → an HTTP API + MCP tools + AI-agent tools + a CLI + a typed client.

What stitchkit is, the invariants every change answers to and what it declines are on one page:
[PRINCIPLES.md](./PRINCIPLES.md). This page is only the direction.

## The problem

A modern backend exposes the *same* operations several ways: an HTTP API for the app,
[MCP](https://modelcontextprotocol.io) tools for assistants, tool definitions for AI agents and a
CLI for scripts and the terminal. Written by hand, that is one surface described many times — many
places to drift, many places to keep typed.

## Direction

- **Toward 1.0 through the contract.** The contract, HTTP, client, tool, CLI, observability and
  testing surfaces are **stable** and settle into the 1.0 API, driven by evidence from real
  consumers rather than speculative abstraction. 1.0 is API stability, not new surface.
- **Optional products beside the core, each with a boundary.** The agent runtime, the managed
  application kernel, live state, tracking, the release watcher and the project declaration are
  **evolving** entrypoints an application may opt into; the full table is in the
  [getting-started guide](./guide/getting-started.md#entrypoints). Each removes mechanics applications were
  copying; none becomes a condition for using the contract. The agent runtime is the largest of
  them and is treated as a separate product inside the package (see PRINCIPLES).
- **Fewer ways, not more.** New work extends the owner that already exists; a new entrypoint is
  promoted to stable only when two consumers depend on it.
- **Docs that match the surface.** The guide, API reference, generated agent-facing docs and
  migration notes stay aligned with what ships; the official starter grows only where it clarifies
  capabilities already shipped.

Breaking changes are allowed between minor versions before 1.0, never silently: each has a
mechanical migration in the changelog and is exercised through the published package first.

The release-by-release plan is the root [`ROADMAP.md`](../ROADMAP.md); the reasoning behind each
decision is in [`docs/decisions/`](./decisions/).
