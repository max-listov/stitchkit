---
title: MCP protocol semantics
description: Deterministic discovery, routing metadata, caching and capability boundaries.
type: architecture
status: active
created: 2026-08-09
updated: 2026-08-20
---

# MCP protocol semantics

## Deterministic surface

Framework-owned contract tools, runtime tools and resources preserve declaration
order across HTTP and stdio. Tool manifests preserve mount order;
`listToolNames` is a sorted diagnostics view, and raw SDK registrations remain
consumer-owned. Modern
`2026-07-28` requests are validated by the SDK before the Stitchkit runner.
Negotiated era and validated MCP request metadata are projected into
both `RequestEvent.mcp` and the typed per-call `context.mcp` seen by managed
handlers, lifecycle and hooks. The host-supplied `clientInfo` is operational
attribution only; routing headers and client self-description are never treated
as application identity, authorization or tenant selection.

Generic wait, download, upload and multimodal view-file operations use ordinary runtime-tool
definitions on the managed path. MCP and Agent therefore share one neutral,
validated operation plus canonical lifecycle, hooks, cancellation and
introspection. Their direct `mount*` forms remain explicit raw MCP presentation
adapters over the same mechanics. View-file batches additionally share one
total byte budget and retain structured per-item failures beside valid media.

## Cache policy

Caching is explicit. `McpServerSharedConfig.cache.operations` maps to SDK v2
operation cache hints. `McpResourceDef.cacheHint` controls one resource.
Omission means zero/private, including prepared surfaces. Unbounded dynamic
identity-selected factories are forced to zero/private; a finite `surfaces`
registry is the only identity-selected form that may receive positive hints.

Stitchkit never infers freshness from determinism and never advertises
list-change or subscription capability without an implementation. A cacheable
response must preserve the same semantic ordering; auth values and per-call
context never enter a shared descriptor.

## Apps and multimodal output

MCP Apps remain an optional adapter over `@modelcontextprotocol/ext-apps`.
`ui://` resources preserve their MIME type, CSP/domain metadata and `_meta.ui`;
raw multimodal tool content remains available through the deliberate raw escape
hatch. The optional Apps dependency may carry its own historical transitive SDK,
but Stitchkit source and public declarations expose only v2 server types.

Framework-owned contract and runtime tools advertise the exact declared output
schema. Modern `2026-07-28` responses carry the validated JSON value directly as
`structuredContent`, including arrays, scalars and `null`; no framework wrapper
changes its shape. The official SDK owns legacy-era wire adaptation. A tool
without an output contract has neither `outputSchema` nor `structuredContent`.

## Trace propagation

Framework-owned MCP handlers read only the SDK v2 public request `_meta` and
its standard propagation keys. A valid MCP `traceparent` is authoritative for
that invocation; when absent, HTTP keeps the enclosing request trace and stdio
opens a root. A present invalid value opens a fresh root rather than falling
back to a possibly unrelated HTTP parent. `tracestate` is accepted only beside
a valid MCP parent, while bounded `baggage` may accompany either path.

The MCP request context is established before validation, lifecycle and hooks;
the existing tool runner then opens its normal child span. Parallel calls share
only the caller-provided trace id and retain separate span/context records.
Propagation values are correlation data, never auth or routing identity, and
their contents are not projected into standard audit events. Multi-round input
does not seal trace metadata into `requestState`: every attempt uses the
metadata on that request.
