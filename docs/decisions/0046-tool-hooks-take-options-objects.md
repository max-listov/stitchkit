---
title: "ADR 0046 — Tool hooks take options objects"
type: decision
status: accepted
created: 2026-08-07
updated: 2026-08-07
---

# ADR 0046 — Tool hooks take options objects

- **Status:** Accepted — refines the observability surface of
  [ADR 0007](0007-mcp-agent-tools.md), [ADR 0041](0041-tool-error-cause-is-observable.md)
  and [ADR 0042](0042-the-audit-row-may-name-the-cause.md)
- **Date:** 2026-08-07

## Context

`afterToolCall` reached seven positional arguments as observability learned to
carry endpoint identity and the raw thrown value. A consumer interested only in
the cause had to count and placeholder six earlier arguments. The neighbouring
hooks used different positional vocabularies, so adding another field would
repeat the same breaking expansion.

## Decision

Every `ToolCallHooks` callback takes exactly one named options object. Shared
concepts use the same keys everywhere: `toolName`, `args`, `context` and
`endpoint`; phase-specific data adds `result`, `durationMs` or `error`.

The public option types are `BeforeToolCallOptions`, `AfterToolCallOptions` and
`ToolErrorOptions`. A hook receives only fields meaningful at its phase. New
fields are added to an options type rather than to callback arity.

All three hooks change together. There is no positional overload, adapter,
deprecated alias or mixed-style transition: pre-1.0 consumers migrate once and
the framework retains one execution path.

## Consequences

- Call sites destructure the fields they use instead of counting positions.
- Future optional observability fields are additive to the object shape.
- Presets and composed hooks forward one value without reassembling argument
  order.
- The 0.37.0 migration is breaking and must show a before/after example for all
  three callbacks.
- Any future tool-call hook is born object-shaped and reuses the established
  key vocabulary.
