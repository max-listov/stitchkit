---
title: "ADR 0129: Deferred Agent tools are durable direct activation"
description: "A bounded canonical search receipt selects real mounted tools for one durable run without a gateway or process-local unlock state."
type: decision
status: accepted
created: 2026-08-29
updated: 2026-08-29
---

# ADR 0129 — Deferred Agent tools are durable direct activation

## Context

An Agent application may own hundreds of contract and runtime tools while one
model step needs only a few. Sending every schema on every request consumes
provider context. A generic `{ name, arguments }` executor avoids that cost by
erasing the selected operation's typed identity, lifecycle, presenter and
durable history. Keeping an unlocked-name set in memory also loses activation
on recovery and can leak it to a queued successor.

## Decision

`createDeferredAgentToolSurface` composes the canonical Agent projection from
`buildToolManifest`, mounts the whole executable catalog through `mountAgent`
and owns the final `prepareStep.activeTools` list. The first step exposes only
one bounded search tool, declared always-on tools and validated dynamic pins.
Search returns exact names and descriptions, never schemas or execution.

A successful search result contains a versioned receipt with the durable run
identity, selected finite-surface key and exact selected names. The ordinary
Agent tool-result record is the only activation state. Each step reconstructs
the latest valid same-run replacement from provider messages; parallel search
results in one step merge in call order. Cross-run, cross-surface, malformed and
stale receipts fail closed. Recovery therefore restores the same activation,
while interruption and queued successors inherit nothing.

The next request advertises the actual selected `mountAgent` tools. Direct
calls retain their own identity, Zod boundary, lifecycle, fence, hooks, errors
and multimodal presenter. A known but inactive call is repaired into the search
tool with a `SEARCH_REQUIRED` receipt and never executes the requested handler;
an unknown name remains an honest failure.

All catalogs are immutable and validated at construction. Query/result bytes,
selected/active counts and canonical schema bytes have explicit ceilings. A
custom async selector may rank with a remote index, but only locally canonical
names can enter a receipt. Structured controller evidence contains counts,
bytes and provenance, never query text, prompts, arguments or domain context.

## Consequences

- Large catalogs pay an extra search round only when the application opts in;
  small catalogs may remain cheaper on ordinary `mountAgent`.
- Identity-specific capability boundaries are finite eagerly validated
  surfaces selected per run, not a lazy remote discovery channel.
- Canonical schema bytes are comparable framework evidence, not a claim about
  provider tokenization; actual input and cost still come from provider usage.
- MCP mounting and external MCP discovery remain unchanged and separate.
