---
title: Pathless runtime tools on the CLI surface
description: Let createCli execute explicit managed runtime definitions alongside contract-derived commands without consumer-owned routing wrappers.
type: task
status: done
created: 2026-08-20
updated: 2026-08-20
completed: 2026-08-20 09:50 +00:00
related: 2026-08-20-managed-native-mcp-tools.md
---

# `runtimeTools` on `createCli`

## Зачем

Stitchkit describes the complete MCP/Agent tool surface as contract services
plus pathless `runtimeTools`, but the CLI stops after contract collection:
`RuntimeToolTransport` excludes `CLI`, `collectToolSurface` returns before
runtime definitions, and `createCli` accepts only `services`.

A consuming CLI therefore cannot reuse a managed local operation already used
by its MCP/Agent surfaces. Filesystem upload/download, wait, local inspection or
another pathless operation has to be represented by a synthetic HTTP contract
or routed outside `createCli`. That loses the one-definition surface model and
can drift in schemas, lifecycle, hooks, error mapping and help output.

## Результат

- `createCli` accepts an explicit `runtimeTools` surface beside `services` and
  executes it through the same canonical tool runner as contract commands.
- Runtime definitions can opt into `CLI` without making CLI exposure the new
  default for existing MCP/Agent tools.
- Contract and runtime commands share collision checks, reserved-name/argument
  checks, auth context, lifecycle, hooks, schema coercion, error/exit mapping,
  help generation and dry-run behavior.
- Surface manifests and transport summaries report the same CLI surface that
  `createCli` can actually execute.
- A consumer can reuse one neutral managed local operation across the explicit
  MCP, Agent and CLI transports without an argv pre-router or fake HTTP path.

## Границы

- This is for application operations that belong in the canonical tool runner;
  it does not make binary-management commands such as login, self-update,
  diagnostics or shell completion into MCP/Agent tools.
- No domain-specific file compression, credential store, polling predicate or
  download naming enters Stitchkit.
- Existing runtime definitions remain MCP/Agent-only unless they explicitly
  list `CLI`; an additive transport must not silently publish new commands.

## Перед планированием

- Decide whether neutral validated output is sufficient for CLI formatting or
  whether `present.cli` is needed; do not add a presenter without a real output
  that the existing formatter cannot represent.
- Resolve stdin and filesystem-path ergonomics without serializing large file
  bodies into argv. The generic boundary may be a runtime definition, an input
  source descriptor or a CLI argument transform, but it must not be a media-only
  special case.
- Cover type-level transport opt-in, packed CLI execution, collisions across
  both surface kinds and lifecycle/hook parity.

## План

- [x] Extend runtime-tool exposure with explicit CLI support while keeping the
      undefined default equal to MCP+Agent only.
- [x] Make the mixed-surface collector authoritative for `createCli`, manifests,
      names and transport summaries.
- [x] Add `runtimeTools` to `CliConfig`, including auth-dependent surface
      resolution, and execute them through the existing CLI tool runner.
- [x] Cover runtime-only CLIs, mixed collisions, reserved fields, help, dry-run,
      validation, lifecycle/hooks and packed declarations.
- [x] Update CLI/tool docs, ADR/index and changelog.

## Acceptance

- [x] An explicit `transports: ['CLI']` runtime definition appears in help,
      introspection and execution with typed Zod input/output.
- [x] A definition with no `transports` remains MCP+Agent-only and does not
      silently widen an existing CLI.
- [x] Contract/runtime collisions fail before dispatch and all CLI protections
      apply equally to both sources.
- [x] A CLI may consist only of runtime definitions; MCP/AI peers remain absent
      from the light `stitchkit/cli` entrypoint.
- [x] `bun run verify` is green.

## Конвейер 0/0

- [x] Plan validators: intentionally none by owner request.
- [x] Implementation and authorized gates completed by the primary agent.
- [x] Implementation validators: intentionally none by owner request.

## Что сделано

- [x] Added explicit `'CLI'` runtime-tool exposure without changing the existing
      MCP+Agent default and made the mixed collector authoritative for CLI.
- [x] `createCli` accepts static or identity-dependent `runtimeTools`, supports
      runtime-only binaries and executes managed definitions through the same
      context/lifecycle/hooks/validation runner as contract commands.
- [x] Help, reserved fields, dry-run, stdin, wait polling, collisions,
      introspection and output/error mapping share the existing CLI mechanics.
- [x] ADR 0083, CLI/MCP guides, API reference, changelog, exact public surface
      and packed consumer fixture are synchronized.
- [x] Регрессия: packages/core/tests/cli.test.ts::an explicit CLI definition shares help, validation, lifecycle and hooks; packages/core/tests/cli.test.ts::undefined exposure stays MCP+Agent-only and a runtime-only CLI works; packages/core/tests/cli.test.ts::a contract/runtime collision fails before dispatch.
- [x] `bun run verify` completed with exit 0 on 2026-08-20; no release, commit,
      tag or push was performed.
