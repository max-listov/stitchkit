---
title: Composable native commands beside a contract-derived CLI
description: Explore a typed extension point for binary-owned commands such as login, update and diagnostics without forcing them through HTTP contracts.
type: task
status: done
created: 2026-08-20
updated: 2026-08-20
completed: 2026-08-20 09:50 +00:00
---

# Native command composition for `createCli`

## Зачем

Contract-derived commands cover application operations, but a distributed CLI
also owns commands about the executable itself: credential setup, self-update,
diagnostics, bundled integration installation or shell completion. Those
commands may intentionally work before remote credentials are resolved and do
not belong on HTTP, MCP or Agent surfaces.

Today a consumer handles them in an argv pre-router before `createCli`. The
resulting commands are absent from canonical help, bypass shared collision and
reserved-option checks, repeat output/exit/error handling, and force the
consumer to coordinate when identity and remote services are resolved. Adding
more binary commands grows a second CLI framework beside Stitchkit.

## Результат

- Determine whether `createCli` should accept explicit transport-local command
  definitions that compose with contract/runtime commands in one router and
  help tree.
- If consumer evidence supports it, native commands receive typed argument
  schemas, collision/reserved-name checks, injectable writers/exit behavior and
  deterministic error handling without acquiring fake HTTP identities.
- Command-level startup policy allows help/version and selected local commands
  to run without eagerly resolving remote credentials or constructing remote
  services.
- Stitchkit owns only the generic routing contract; credential persistence,
  updater protocol, diagnostics and integration installation remain consumer
  implementations.

## Границы

- Native commands are not a second `RuntimeToolDefinition`: they are explicitly
  CLI-only executable operations and must never appear accidentally in MCP or
  Agent manifests.
- Do not add built-in login, updater, skill/plugin installation or machine
  identity policy to the generic core.
- Keep the public primitive minimal and generic: one consuming executable has
  already produced multiple stable command categories, but that evidence does
  not justify framework-owned auth, updater or installer mechanisms.

## Перед планированием

- Compare a declarative `commands` collection with smaller hooks around command
  resolution and lazy auth/service construction.
- Keep `runtimeTools` CLI support a separate decision: business operations use
  the canonical tool runner; binary-management commands use this local boundary.
- Pin complete help, unknown-command, collision, no-credentials and injected
  stdout/stderr/exit behavior before choosing the public type.

## План

- [x] Add a Zod-first `defineCliCommand` data definition for CLI-only executable
      commands with no fake HTTP/tool identity.
- [x] Compose native, contract and runtime commands in one help/collision/router
      boundary while dispatching a selected native command before auth/services.
- [x] Reuse argv parsing, stdin filling, reserved-field checks, dry-run,
      stdout/stderr injection, error envelopes and exit mapping.
- [x] Keep lifecycle/tool hooks exclusive to managed contract/runtime operations;
      give native handlers only typed input, run options and injected writers.
- [x] Cover lazy dispatch, help, validation, collision, thrown error, result
      output and packed public declarations; update docs, ADR/index/changelog.

## Acceptance

- [x] A native command is listed in top-level and command help, receives typed
      parsed input, and returns structured output through the CLI formatter.
- [x] Selecting a native command does not resolve `auth`, `services`, context or
      runtime definitions; help/version keep their documented startup behavior.
- [x] Names and reserved options collide consistently across all three command
      sources before managed dispatch.
- [x] Native commands never appear in MCP/Agent manifests and cannot acquire a
      fake scope/method/service identity.
- [x] `bun run verify` is green.

## Конвейер 0/0

- [x] Plan validators: intentionally none by owner request.
- [x] Implementation and authorized gates completed by the primary agent.
- [x] Implementation validators: intentionally none by owner request.

## Что сделано

- [x] Added Zod-first `defineCliCommand` and typed native handler context with
      input, global options and injected stdout/stderr writers.
- [x] Native, contract and runtime commands share one help/router, argv/stdin,
      reserved-field, dry-run, error-envelope and exit-code boundary; native
      commands deliberately have no tool identity, lifecycle or tool hooks.
- [x] Added lazy `resolveAuth`; version, selected native commands and static
      help run before credentials, services, context or runtime-tool factories.
- [x] Static cross-source names fail before managed dispatch; dynamic surface
      names are validated when their identity-dependent factory resolves, as
      recorded in ADR 0083.
- [x] ADR 0083, CLI guide, API reference, changelog, exact public surface and
      packed consumer fixture are synchronized.
- [x] Регрессия: packages/core/tests/cli.test.ts::lists, documents, validates and emits one typed native command; packages/core/tests/cli.test.ts::dispatches native commands before auth, services, context and runtime factories; packages/core/tests/cli.test.ts::version and static top-level help stay credential-free; packages/core/tests/cli.test.ts::maps a native throw and rejects cross-source name collisions.
- [x] `bun run verify` completed with exit 0 on 2026-08-20; no release, commit,
      tag or push was performed.
