---
title: "ADR 0327: CLI option projections return parse errors as a field"
description: extractCliGlobalOptions and scanCliInvocation return malformed flag errors on an error field with empty fail-closed routing fields instead of throwing on call or property access.
type: decision
status: accepted
amends: ["0310"]
created: 2026-11-25 13:41 +08:00
updated: 2026-11-25 13:41 +08:00
---

# ADR 0327 — CLI option projections return parse errors as a field

Amends [ADR 0310](0310-one-model-for-cli-invocation-and-json-schema-keywords.md). Serves **I8**, **I9**, and **I13**.

## Context

In ADR 0310, `scanCliInvocation` and `extractCliGlobalOptions` surfaced malformed framework/global flags and broken boolean boundaries by either throwing `CliArgumentError` during the scan or installing a throwing getter on the `.argv` property of the returned object.

A consuming project that calls `extractCliGlobalOptions(argv, globals)` before `createCli(...)` in order to pick a profile or load a dynamic command catalog hit a control-flow hazard: an ordinary malformed invocation (`--profile` without a value, `--quiet=maybe`, `--dry-run inspect false`, or a duplicate global flag) threw before `createCli` ran, or threw unexpectedly whenever any helper spread or read `result.argv`. Callers were forced to wrap `extractCliGlobalOptions` in `try { … } catch (error)` just to fall back to defaults and let `createCli` render the canonical exit-2 diagnostic.

At the same time, `routeCliArgv` already reported parse errors as a plain `error` field without throwing.

## Decision

1. **Non-throwing projections with an explicit `error?: CliArgumentError` field:** `extractCliGlobalOptions` and `scanCliInvocation` never throw on malformed CLI flag syntax (unknown inline boolean values, missing values, duplicate global flags, or broken boolean boundaries). Instead, both return an object with `error?: CliArgumentError`.
2. **Fail-closed plain data fields on error:** Neither projection defines a throwing getter on `.argv`. When `error` is defined:
   - `extractCliGlobalOptions` returns `argv: []` alongside whatever valid global values were parsed before the failure and `error`.
   - `scanCliInvocation` returns `command: undefined`, `commandTokens: []`, and `error`.
   Callers that check `if (parsed.error)` get the exact typed `CliArgumentError`; callers that use the parsed globals to select a default profile and then pass the original `argv` to `createCli(...)` need no `try/catch` and let `createCli` report the error with exit code 2.
3. **Early notice suppression on error:** `writeCliNotice` suppresses early notices whenever `scan.error !== undefined || scan.framework.quiet`, preserving ADR 0295 and ADR 0310 without relying on a thrown exception during scanning.
4. **Stable `routeCliArgv` error field preserved:** `routeCliArgv` keeps its existing `error?: string` field (formatted from `scan.error.message`).

## Consequences

- `stitchkit/cli` is a stable entrypoint; removing the throwing `.argv` getter and direct throw from `extractCliGlobalOptions` and `scanCliInvocation` is a breaking minor change justified under ADR 0198 and ADR 0238, with migration guidance in `docs/guide/upgrading.md`.
- Dynamic-catalog CLI entrypoints read `extractCliGlobalOptions` cleanly without `try/catch` boilerplate, while spreading or logging the returned projection never throws.
- Invalid configuration errors (such as invalid option definitions passed by code, not user `argv`) still fail immediately with `TypeError`.
