---
title: "ADR 0019 — Generic native MCP tools (wait / download / upload)"
type: decision
status: accepted
created: 2026-05-29
updated: 2026-05-29
---

# ADR 0019 — Generic native MCP tools

- **Status:** Accepted — extends [ADR 0007](0007-mcp-agent-tools.md), upholds [ADR 0002](0002-generic-core.md)
- **Date:** 2026-05-29

## Context

Most tools come from a contract (`mountMcp`). Some jobs cannot be expressed as a
request/response contract — they are imperative: block-poll an async job until it
is done, download a result URL to disk, upload a local file. stitchkit already
ships one such generic native tool, `mountViewFile` (materialise a media URL into
MCP image/audio blocks), via the `nativeTools(server)` escape hatch.

Without more of these, every app re-hand-rolls them on the raw `McpServer`:
- it imports `@modelcontextprotocol/sdk` directly to type `server.registerTool`,
- it re-implements the same backoff/timeout poll loop the CLI `--wait` already
  has (`pollUntilDone`), drifting from it.

A consuming app commonly hits exactly this — a hand-written `wait` / `download`
/ `upload` native tool with its own poll loop and a direct SDK import.

## Decision

**Ship the imperative tools as generic native tools, mechanism-only — the app
injects the domain.** Like `mountViewFile`, stitchkit owns the MCP plumbing
(`registerTool`, the SDK types, the poll/fetch/fs mechanics); the consumer
supplies the domain predicate.

- **`mountWait(server, config)`** — polls `config.poll(args)` with backoff until
  `config.done(state)` or the timeout. The loop is the shared `pollUntil`.
- **`mountDownload(server, config)`** — `config.resolveUrl(args)` → fetch → write
  to disk with a content-type / URL-derived extension.
- **`mountUpload(server, config)`** — hands a local `path` to `config.upload`.
- **`pollUntil`** — one backoff/timeout loop, the single engine behind both the
  CLI `--wait` (`pollUntilDone`) and `mountWait`. No second copy.
- **`type McpServer` is re-exported from `stitchkit/tools`** — a consumer writing
  a native-tool registrar (`(server) => …`) types it without importing the SDK.

These stay **domain-free** (ADR 0002): stitchkit knows nothing about
"generations" or "statuses" — the consumer's `poll` / `done` / `resolveUrl` /
`upload` carry all the domain.

## Consequences

- An app composes native tools by configuration, not by hand-rolling on the raw
  SDK — no direct `@modelcontextprotocol/sdk` import in the consumer (the pilot's
  `packages/mcp` dropped to zero).
- One poll loop (`pollUntil`) serves the CLI and MCP — the duplicate the pilot
  carried is gone; CLI `--wait` and MCP `wait` cannot drift.
- The `nativeTools(server)` raw hatch still exists for genuinely bespoke tools;
  these three just cover the common imperative shapes so most apps never need it.
- The MCP SDK coupling lives where it belongs — in the framework, behind a
  generic surface — not scattered across consumers.
