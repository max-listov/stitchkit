---
title: "ADR 0310: One model for CLI invocation scanning and JSON Schema keywords"
description: Unify CLI argument scanning, boolean boundaries, pre-call view column checks, runner construction, and a single exhaustive JSON Schema keyword table with remote-verdict delegation.
type: decision
status: accepted
amends: ["0083", "0295", "0296"]
created: 2026-11-23 15:48 +08:00
updated: 2026-11-23 15:48 +08:00
---

# ADR 0310 — One model for CLI invocation scanning and JSON Schema keywords

Amends [ADR 0083](0083-cli-composes-managed-and-native-commands.md), [ADR 0295](0295-quiet-suppresses-profile-selection-notices.md), and [ADR 0296](0296-framework-options-reserve-their-cli-spellings.md). Serves **I8**, **I9**, and **I13**.

## Context

CLI invocations previously re-scanned raw `argv` across six independent stages (routing, early `--quiet` notice suppression, global option extraction, help filtering, command parsing, and passthrough coercion), with four different boolean word tables and a silent boundary rewrite (`preserveCliBooleanBoundary`) that masked ambiguous tokens. Meanwhile, three separate code paths constructed managed tool runners and validated global options differently (`createCli`, `createCliInvoker`, and `runCliStream`), native commands silently ignored view flags (`--table`, `--sort`, `--sum`, `--count-by`), and unknown view columns were rejected only after calling the handler.

Separately, JSON Schema handling across MCP discovery, OpenAPI discovery, and CLI help maintained three partial keyword lists. OpenAPI 3.0 `nullable: true` was rewritten under draft 2020-12 where Zod ignored it, top-level `oneOf`/`anyOf` collapsed into an unvalidated empty object, and keywords such as `not`, `if`/`then`/`else`, `dependentRequired`, `dependentSchemas`, `unevaluated*`, and draft-07 `dependencies` either dropped the whole tool or were silently ignored.

## Decision

1. **Single-pass CLI scan (`scanCliInvocation`):** `stitchkit/cli` exports `scanCliInvocation(argv, { appGlobals, defaultCommand })` as the sole argv classifier and scanner. `routeCliArgv`, `extractCliGlobalOptions`, early profile notice suppression (`writeCliNotice`, amending ADR 0295), and `createCli` all project from this single pass. Removed framework and application tokens leave explicit separation boundaries (`separatedBefore`) so stripping a flag never glues surrounding command tokens.
2. **Boolean grammar, case policy, and broken boundaries:** One case-insensitive boolean word table governs inline values (`true`/`1`/`yes`/`on`, `false`/`0`/`no`/`off`) and adjacent separate tokens (`true`, `false`); unknown inline values (`--quiet=maybe`) fail with `CliArgumentError` before profile notices are emitted. Adjacent `--flag false` remains a boolean value across framework flags, application options, command fields, and short aliases. When a bare boolean framework flag is separated from `true`/`false` by a stripped token (a command name or an application option, e.g. `--dry-run inspect false` or `inspect --dry-run --profile demo false`), the scanner refuses with `CliArgumentError` and a hint (`--flag=false` or `-- false`) instead of silently rewriting the boundary. Passthrough type guessing (`looseCoerce`) coerces only `true`/`false` and numbers, leaving `--mode on` as `"on"`.
3. **Removal of the ADR 0296 transitional refusal:** Leading framework flags before a native command in a CLI with a managed factory and no `defaultCommand` now route identically to every other CLI profile, amending ADR 0296 and removing its transitional exit-2 refusal.
4. **Pre-call column validation and one CLI runner:** `assertViewColumns` validates view column paths (`--table`, `--sort`, `--sum`, `--count-by`, `--top --by`) against the declared output schema before calling the handler whenever the schema defines an unambiguous object collection (root array or root object with one required non-catchall array of non-catchall, non-union objects), including on empty results; ambiguous or open schemas keep post-call validation. `createCli`, `createCliInvoker`, and stream commands share one tool-runner builder (`createCliToolRunner`), one global option parser (`parseCliGlobalValues`, throwing `CliArgumentError` and parsing JSON strings consistently), and one native executor (`executeNativeCommand`) that applies views when `output` is declared and refuses view flags with exit code 2 when `output` is absent.
5. **Exhaustive JSON Schema keyword table (`JSON_SCHEMA_KEYWORDS`) and remote verdicts:** One table classifies every keyword of JSON Schema draft-07, draft 2020-12, and OpenAPI 3.0 Schema Object (plus `x-*` extensions) for MCP reading, OpenAPI reading, and CLI help display. Unknown or refused keywords (`$anchor`, `$dynamicRef`, `$dynamicAnchor`) fail closed into `onSkippedTool` naming the keyword. OpenAPI 3.0 passes `dialect: 'openapi-3.0'` so `nullable: true` validates `null`; other dialects normalize `nullable: true` to a nullable type union. Keywords that cannot be enforced locally without false rejections (`not`, `if`/`then`/`else`, `dependentRequired`, `dependentSchemas`, `unevaluatedProperties`, `unevaluatedItems`, `dependencies`) are stripped locally and delegate enforcement to the remote server via `markRemoteSchemaVerdict` instead of dropping the tool. Top-level object `oneOf`/`anyOf` branches are merged with any root `properties`/`required` (preserving `$schema`), while non-object branches fail closed into `onSkippedTool`.

## Consequences

- Flag placement, case, profile notices, and runner execution share one observable model across all CLI profiles.
- Every foreign JSON Schema keyword has an explicit, test-verified verdict across MCP, OpenAPI, and CLI help; new keywords encountered in fixtures or specifications cannot be silently dropped.
- Five CLI/connection behaviour changes (broken boolean boundary refusal, pre-call column checks including empty results, native command view handling, top-level union merging, and `createCliInvoker` global option parsing / `CliArgumentError`) ship together as breaking changes in the planned minor release with migration entries in `docs/guide/upgrading.md`.
