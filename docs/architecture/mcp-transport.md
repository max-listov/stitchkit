---
title: MCP transport
description: Stateless HTTP and stdio ownership on the TypeScript SDK v2.
type: architecture
status: active
created: 2026-08-09
updated: 2026-08-09
---

# MCP transport

## Ownership

Stitchkit owns the contract/runtime tool runner and creates a fresh SDK server
for each HTTP request or stdio connection. The official
`@modelcontextprotocol/server` v2 factories own JSON-RPC parsing, protocol-era
negotiation, cancellation and transport shutdown.

`createMcpHandler` returns one `McpHttpHandler` with `fetch` and idempotent
`close`. `createMcpHttpRoute` is the only application route adapter: it registers
all required HTTP methods and delegates to `fetch`. `createStdioMcpServer`
returns an `McpStdioHandle`; stdout belongs exclusively to JSON-RPC.

## State boundary

HTTP is always request-isolated. Stitchkit keeps no protocol session map, event
store, session id, resumable SSE cursor or auth value between requests. Prepared
static/finite descriptors are immutable and may be shared; server, auth-derived
context, lifecycle and tool-call context are fresh. Arbitrary auth-dependent
surface factories are rebuilt and never cached by identity.

`legacy: 'serve'` asks the official SDK to support its legacy stateless opening
on the same endpoint. `legacy: 'reject'` requires the modern era. This boundary
does not restore stateful continuity or a second framework implementation.
It remains the default because the SDK v2 client itself opens in the legacy era
unless its caller enables version negotiation. A modern-only deployment is an
explicit host-compatibility decision, not a framework-cleanliness requirement.

## Security and shutdown

Authentication and RFC 9728 challenges run before SDK dispatch. Optional Host
and Origin allowlists protect the public Fetch boundary. Without explicit
allowlists, a present Host must match the request URL and a present Origin must
be same-origin; absent Origin remains valid for non-browser MCP hosts. A trusted
gateway must reconstruct the public URL or supply exact allowlists rather than
trust arbitrary forwarded headers. Malformed content, invalid protocol headers
and hostile routing metadata fail before lifecycle or handlers.

`onTransportRejected` observes rejected HTTP/protocol requests without entering
tool lifecycle. It receives a cloned response and is an audit sink only, never a
new authentication or routing source.

Application shutdown closes the HTTP/stdio handle. Closing rejects new work,
aborts in-flight transport work and is safe to call more than once.
